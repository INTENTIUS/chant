/**
 * Garbage collection of stored change sets, releases and run events by the
 * retention policy (#4036). `chant lifecycle gc` runs it.
 *
 * What it prunes on `chant/lifecycle`, in every member's ledger at once:
 *
 *   _change-sets/<digest>.json          a stored change set (#4022)
 *   _releases/<digest>.json             a release (#4026)
 *   _releases/templates/<digest>.txt    template bytes no kept release names
 *
 * A prune is one new commit on the local branch that removes those files. It
 * never rewrites or force-pushes history: other clones and tools read the
 * branch, and every pruned file stays reachable in the commits before the
 * prune. So a prune bounds the tree a reader walks at the tip, and the
 * repository's history keeps growing by what is written. `git log -- <path>`
 * on the branch still finds a pruned file.
 *
 * What it never touches: the ledgers. `_releases/cuts.jsonl`,
 * `<env>/releases.jsonl`, `_gates/<op>.jsonl`, the run ledgers and every other
 * `.jsonl` on the branch are append-only and are not edited (#4034), and a
 * whole ledger file is not removed either: the latest deploy record of an
 * environment, a gate's standing fact and a release's label all live in them,
 * and they are small next to what they index (one line per fact). Nor does it
 * touch snapshots, `_plans/`, `_builds/` or checkpoints, which have no policy
 * yet. A cut line whose release was pruned stays, so its label keeps naming
 * that digest and can't be given to another release.
 *
 * What is never pruned, whatever its age:
 *
 * 1. A release an environment runs: the release the latest deploy record of
 *    each component in each environment names, by its `releaseDigest` or the
 *    release gate resolution its admission names (`releaseOfDeploy`, #4043),
 *    and that release's templates. A promotion picks up what the step before
 *    runs (#4030), so this also keeps every release a promotion can take by
 *    default.
 * 2. What a pending gate binds: the change set (`planDigest`) and release
 *    (`releaseDigest`) of every pending fact that has not expired.
 * 3. A release still promotable: one whose commit has no `ci/revoked` tag and
 *    that was cut within `releases.days`, or is among the newest
 *    `releases.keep` releases of its member.
 * 4. A change set a gate fact (an approval, an `empty` resolution or a
 *    pending fact) names together with a release that is kept.
 *
 * Anything else is pruned once it is older than its kind's window: a change
 * set `changeSets.days` after it was stored or last named by a gate fact,
 * whichever is later. A file that can't be read as a release is kept.
 *
 * Run events are local files under `<git-common-dir>/chant/run-events/`
 * (`../run-event-store.ts`) and are deleted outright.
 */

import { execFileSync } from "node:child_process";
import { RefCASConflictError, writeLedgerFiles, pushLifecycleReport, type LedgerFileRemoval } from "./git";
import { MEMBERS_DIR } from "./member-ledger";
import { CHANGE_SETS_DIR } from "./change-set-store";
import { CUTS_FILE, RELEASES_DIR, TEMPLATES_SUBDIR, parseCuts, parseRelease, type Release } from "./release-store";
import { parseGateLedger, type GateResolutionRecord, type PendingGateRecord } from "./gate-ledger";
import { parseReleaseLedger, releaseLedgerLines } from "./release-read";
import { latestPerComponent } from "./release-ledger";
import { releaseOfDeploy } from "./release-join";
import { RELEASE_GATE_OP } from "../op/gate-name";
import { planRunEventPrune, pruneRunEvents, type RunEventFile } from "../run-event-store";
import type { RetentionPolicy } from "./retention-policy";

const STATE_BRANCH = "chant/lifecycle";
const DAY_MS = 86_400_000;

/** What a pruned or kept file on the branch is. */
export type GcKind = "change-set" | "release" | "template";

/** Why a file is kept. Closed. */
export type GcKeepCode =
  /** The latest deploy record of a component in an environment names the release. */
  | "deployed"
  /** A pending fact that has not expired binds it. */
  | "pending-gate"
  /** The release is among the newest `releases.keep` of its member and not revoked. */
  | "newest"
  /** It is within its kind's window (and, for a release, not revoked). */
  | "within-window"
  /** A gate fact names the change set with a release that is kept, or a kept release names the template. */
  | "kept-release"
  /** The file can't be read as what its directory holds, so nothing can be said about it. */
  | "unreadable";

export interface GcKeepReason {
  code: GcKeepCode;
  /** The environment, gate or release the reason names, when it names one. */
  detail?: string;
}

export interface GcFile {
  kind: GcKind;
  /** The member, its path of names joined with `/`, or null for the flat layout. */
  member: string | null;
  /** The full path on the branch. */
  path: string;
  digest: string;
  bytes: number;
  /** The blob sha at the tip read. */
  sha: string;
  /** When it was last written to the branch (the newest commit that added it), or null when history does not say. */
  storedAt: string | null;
}

export interface GcKept extends GcFile {
  reasons: GcKeepReason[];
}

/** Files and bytes in the tip's tree. */
export interface TreeSize {
  files: number;
  bytes: number;
  changeSets: { files: number; bytes: number };
  releases: { files: number; bytes: number };
  templates: { files: number; bytes: number };
  /** Every `.jsonl` file: append-only, never pruned. */
  ledgers: { files: number; bytes: number };
  other: { files: number; bytes: number };
}

/** What a prune of `chant/lifecycle` would do. */
export interface LifecycleGcPlan {
  /** The branch tip read, or null when the checkout has no `chant/lifecycle`. */
  tip: string | null;
  remove: GcFile[];
  keep: GcKept[];
  before: TreeSize;
  after: TreeSize;
}

export interface GcInput {
  /** Any directory in the repository. The whole branch is read, every member at once. */
  cwd: string;
  policy: RetentionPolicy;
  now: Date;
  /** Full shas of commits with a `ci/revoked` tag: their releases are not promotable. */
  revokedCommits?: ReadonlySet<string>;
}

interface BranchFile {
  path: string;
  sha: string;
  bytes: number;
}

function git(cwd: string, args: string[], input?: string): Buffer {
  return execFileSync("git", args, { cwd, input, maxBuffer: 1024 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}

function branchTip(cwd: string): string | null {
  try {
    return git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${STATE_BRANCH}`]).toString().trim() || null;
  } catch {
    return null;
  }
}

function listTree(cwd: string, tip: string): BranchFile[] {
  const out: BranchFile[] = [];
  for (const line of git(cwd, ["ls-tree", "-r", "-l", "--full-tree", tip]).toString().split("\n")) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.+)$/);
    if (m) out.push({ sha: m[1], bytes: Number(m[2]), path: m[3] });
  }
  return out;
}

/** The text of each blob, read in one `git cat-file --batch`. */
function readBlobs(cwd: string, shas: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const unique = [...new Set(shas)];
  if (unique.length === 0) return out;
  const buf = git(cwd, ["cat-file", "--batch"], `${unique.join("\n")}\n`);
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const header = buf.subarray(at, nl).toString().split(" ");
    at = nl + 1;
    if (header[1] === "missing" || header.length < 3) continue;
    const size = Number(header[2]);
    out.set(header[0], buf.subarray(at, at + size).toString("utf8"));
    at += size + 1;
  }
  return out;
}

/** When each change set and release file was last added on the branch, newest add first, in one `git log`. */
function storedTimes(cwd: string, tip: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = git(cwd, [
    "log", "--format=%x00%cI", "--name-only", "--diff-filter=A", tip, "--",
    `:(top,glob)**/${CHANGE_SETS_DIR}/*.json`, `:(top,glob)**/${RELEASES_DIR}/*.json`,
  ]).toString();
  for (const chunk of text.split("\0")) {
    const lines = chunk.split("\n").filter(Boolean);
    const when = lines.shift();
    if (!when) continue;
    for (const path of lines) if (!out.has(path)) out.set(path, when);
  }
  return out;
}

/** Split a branch path into the member prefix (`_members/<a>/_members/<b>/`) and the rest. */
export function splitLedgerPath(path: string): { prefix: string; member: string | null; rest: string } {
  const segs = path.split("/");
  const names: string[] = [];
  let i = 0;
  while (segs[i] === MEMBERS_DIR && i + 2 < segs.length) {
    names.push(segs[i + 1]);
    i += 2;
  }
  return { prefix: segs.slice(0, i).map((s) => `${s}/`).join(""), member: names.length > 0 ? names.join("/") : null, rest: segs.slice(i).join("/") };
}

/**
 * The key a digest is matched by: its hex. A plan digest written `sha256:<hex>`
 * names the same plan as `jcs1-sha256:<hex>` (`samePlanDigest`), and a file
 * name writes `:` as `_`, so both sides are reduced to the hex.
 */
export function digestKey(digestOrStem: string): string {
  const hex = digestOrStem.match(/[0-9a-f]{64}$/);
  return hex ? hex[0] : digestOrStem.replace(/:/g, "_");
}

const stemOf = (name: string, ext: string): string => name.slice(0, -ext.length);
const fileDigest = (name: string, ext: string): string => stemOf(name, ext).replace(/_/g, ":");

interface MemberLedger {
  prefix: string;
  member: string | null;
  changeSets: Map<string, GcFile>;
  releases: Map<string, GcFile>;
  templates: Map<string, GcFile>;
  cuts: BranchFile | null;
  gates: BranchFile[];
  deploys: Array<{ env: string; file: BranchFile }>;
}

function emptySize(): TreeSize {
  const z = () => ({ files: 0, bytes: 0 });
  return { files: 0, bytes: 0, changeSets: z(), releases: z(), templates: z(), ledgers: z(), other: z() };
}

function sizeOf(files: readonly BranchFile[], kinds: ReadonlyMap<string, GcKind>): TreeSize {
  const s = emptySize();
  for (const f of files) {
    s.files++;
    s.bytes += f.bytes;
    const kind = kinds.get(f.path);
    const slot = kind === "change-set" ? s.changeSets : kind === "release" ? s.releases : kind === "template" ? s.templates : f.path.endsWith(".jsonl") ? s.ledgers : s.other;
    slot.files++;
    slot.bytes += f.bytes;
  }
  return s;
}

/**
 * Decide what a prune of `chant/lifecycle` removes and keeps, by the rules at
 * the top of this file. Reads the branch at its local tip and writes nothing.
 */
export function planLifecycleGc(input: GcInput): LifecycleGcPlan {
  const { cwd, policy, now } = input;
  const revoked = input.revokedCommits ?? new Set<string>();
  const tip = branchTip(cwd);
  if (!tip) return { tip: null, remove: [], keep: [], before: emptySize(), after: emptySize() };

  const files = listTree(cwd, tip);
  const stored = storedTimes(cwd, tip);
  const members = new Map<string, MemberLedger>();
  const kinds = new Map<string, GcKind>();
  const ledgerOf = (prefix: string, member: string | null): MemberLedger => {
    let m = members.get(prefix);
    if (!m) {
      m = { prefix, member, changeSets: new Map(), releases: new Map(), templates: new Map(), cuts: null, gates: [], deploys: [] };
      members.set(prefix, m);
    }
    return m;
  };

  for (const f of files) {
    const { prefix, member, rest } = splitLedgerPath(f.path);
    const segs = rest.split("/");
    const name = segs.at(-1)!;
    const entry = (kind: GcKind, digest: string): GcFile => {
      kinds.set(f.path, kind);
      return { kind, member, path: f.path, digest, bytes: f.bytes, sha: f.sha, storedAt: stored.get(f.path) ?? null };
    };
    if (segs.length === 2 && segs[0] === CHANGE_SETS_DIR && name.endsWith(".json")) {
      const e = entry("change-set", fileDigest(name, ".json"));
      ledgerOf(prefix, member).changeSets.set(digestKey(stemOf(name, ".json")), e);
    } else if (segs.length === 2 && segs[0] === RELEASES_DIR && name.endsWith(".json")) {
      const e = entry("release", fileDigest(name, ".json"));
      ledgerOf(prefix, member).releases.set(digestKey(stemOf(name, ".json")), e);
    } else if (segs.length === 3 && segs[0] === RELEASES_DIR && segs[1] === TEMPLATES_SUBDIR && name.endsWith(".txt")) {
      const e = entry("template", fileDigest(name, ".txt"));
      ledgerOf(prefix, member).templates.set(digestKey(stemOf(name, ".txt")), e);
    } else if (segs.length === 2 && segs[0] === RELEASES_DIR && name === CUTS_FILE) {
      ledgerOf(prefix, member).cuts = f;
    } else if (segs.length === 2 && segs[0] === "_gates" && name.endsWith(".jsonl")) {
      ledgerOf(prefix, member).gates.push(f);
    } else if (segs.length === 2 && name === "releases.jsonl" && !segs[0].startsWith("_")) {
      ledgerOf(prefix, member).deploys.push({ env: segs[0], file: f });
    }
  }

  const blobs = readBlobs(
    cwd,
    [...members.values()].flatMap((m) => [...m.releases.values()].map((r) => r.sha).concat(m.cuts ? [m.cuts.sha] : [], m.gates.map((g) => g.sha), m.deploys.map((d) => d.file.sha))),
  );

  const keep: GcKept[] = [];
  const remove: GcFile[] = [];
  const nowMs = now.getTime();

  for (const m of members.values()) {
    const reasons = new Map<GcFile, GcKeepReason[]>();
    const keepFile = (f: GcFile | undefined, reason: GcKeepReason): void => {
      if (!f) return;
      reasons.set(f, [...(reasons.get(f) ?? []), reason]);
    };

    // The gate facts of every op in the member.
    const pending: PendingGateRecord[] = [];
    const resolutions: GateResolutionRecord[] = [];
    let releaseGateResolutions: GateResolutionRecord[] = [];
    for (const g of m.gates) {
      const parsed = parseGateLedger(blobs.get(g.sha) ?? "");
      pending.push(...parsed.pending);
      resolutions.push(...parsed.resolutions);
      if (g.path.endsWith(`/${RELEASE_GATE_OP}.jsonl`) || g.path === `_gates/${RELEASE_GATE_OP}.jsonl`) releaseGateResolutions = parsed.resolutions;
    }

    // Releases, parsed.
    const parsed = new Map<GcFile, Release | null>();
    for (const r of m.releases.values()) {
      const release = parseRelease(blobs.get(r.sha) ?? "");
      parsed.set(r, release && digestKey(release.releaseDigest) === digestKey(r.digest) ? release : null);
    }

    // Rule 1: what each environment runs.
    for (const { env, file } of m.deploys) {
      const { records } = parseReleaseLedger(releaseLedgerLines(blobs.get(file.sha) ?? null));
      for (const record of latestPerComponent(records).values()) {
        const digest = releaseOfDeploy(record, releaseGateResolutions);
        if (digest !== undefined) keepFile(m.releases.get(digestKey(digest)), { code: "deployed", detail: `${env}/${record.component}` });
      }
    }

    // Rule 2: what a pending gate binds, until its fact expires.
    for (const p of pending) {
      if (new Date(p.expiresAt).getTime() <= nowMs) continue;
      const detail = `${p.op}/${p.gate}${p.environment ? ` in ${p.environment}` : ""}`;
      if (p.planDigest) keepFile(m.changeSets.get(digestKey(p.planDigest)), { code: "pending-gate", detail });
      if (p.releaseDigest) keepFile(m.releases.get(digestKey(p.releaseDigest)), { code: "pending-gate", detail });
    }

    // Rule 3: a release still promotable.
    const { cuts } = parseCuts(m.cuts ? (blobs.get(m.cuts.sha) ?? null) : null);
    const cutAt = new Map<string, string>();
    for (const c of cuts) {
      const k = digestKey(c.releaseDigest);
      if (!cutAt.has(k) || c.timestamp > cutAt.get(k)!) cutAt.set(k, c.timestamp);
    }
    const releaseCutoff = nowMs - policy.releases.days * DAY_MS;
    const promotable: Array<{ file: GcFile; at: number }> = [];
    for (const [k, file] of m.releases) {
      const release = parsed.get(file)!;
      if (!release) {
        keepFile(file, { code: "unreadable" });
        continue;
      }
      if (revoked.has(release.commit)) continue;
      const when = cutAt.get(k) ?? file.storedAt;
      promotable.push({ file, at: when ? new Date(when).getTime() : Number.POSITIVE_INFINITY });
    }
    promotable.sort((a, b) => b.at - a.at || (a.file.path < b.file.path ? -1 : 1));
    promotable.forEach(({ file, at }, i) => {
      if (i < policy.releases.keep) keepFile(file, { code: "newest" });
      if (at >= releaseCutoff) keepFile(file, { code: "within-window" });
    });

    const keptReleases = new Set([...m.releases.values()].filter((r) => reasons.has(r)));
    const keptKeys = new Set([...keptReleases].map((r) => digestKey(r.digest)));

    // Templates follow the releases that name them.
    const unreadableKept = [...keptReleases].some((r) => parsed.get(r) === null);
    for (const r of keptReleases) {
      const release = parsed.get(r);
      if (!release) continue;
      for (const t of release.targets) for (const tpl of t.templates) keepFile(m.templates.get(digestKey(tpl.digest)), { code: "kept-release", detail: r.digest });
    }
    if (unreadableKept) for (const t of m.templates.values()) keepFile(t, { code: "unreadable", detail: "a release file of this member can't be read" });

    // Rule 4, and the change-set window.
    const lastNamed = new Map<string, number>();
    for (const fact of [...pending, ...resolutions]) {
      if (!fact.planDigest) continue;
      const k = digestKey(fact.planDigest);
      const t = new Date(fact.timestamp).getTime();
      if (!lastNamed.has(k) || t > lastNamed.get(k)!) lastNamed.set(k, t);
      if (fact.releaseDigest && keptKeys.has(digestKey(fact.releaseDigest))) keepFile(m.changeSets.get(k), { code: "kept-release", detail: fact.releaseDigest });
    }
    const changeSetCutoff = nowMs - policy.changeSets.days * DAY_MS;
    for (const [k, file] of m.changeSets) {
      const storedMs = file.storedAt ? new Date(file.storedAt).getTime() : Number.POSITIVE_INFINITY;
      const last = Math.max(storedMs, lastNamed.get(k) ?? Number.NEGATIVE_INFINITY);
      if (last >= changeSetCutoff) keepFile(file, { code: "within-window" });
    }

    for (const f of [...m.changeSets.values(), ...m.releases.values(), ...m.templates.values()]) {
      const why = reasons.get(f);
      if (why) keep.push({ ...f, reasons: dedupe(why) });
      else remove.push(f);
    }
  }

  const byPath = (a: GcFile, b: GcFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  remove.sort(byPath);
  keep.sort(byPath);
  const removed = new Set(remove.map((f) => f.path));
  return { tip, remove, keep, before: sizeOf(files, kinds), after: sizeOf(files.filter((f) => !removed.has(f.path)), kinds) };
}

function dedupe(reasons: GcKeepReason[]): GcKeepReason[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const k = `${r.code}\0${r.detail ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The commit message of a prune. */
export function pruneMessage(remove: readonly GcFile[]): string {
  const n = (kind: GcKind) => remove.filter((f) => f.kind === kind).length;
  return `Retention: remove ${n("change-set")} change set(s), ${n("release")} release(s) and ${n("template")} template(s)`;
}

const PRUNE_ATTEMPTS = 5;

/** What {@link runLifecycleGc} did, or would do on a dry run. */
export interface GcReport {
  now: string;
  policy: RetentionPolicy;
  dryRun: boolean;
  lifecycle: LifecycleGcPlan & {
    /** The prune commit, or null on a dry run or when nothing was removed. */
    commit: string | null;
    pushed: boolean;
    pushWarning?: string;
  };
  runEvents: {
    dir: string | null;
    remove: RunEventFile[];
    kept: { files: number; bytes: number };
    /** How many files were deleted; 0 on a dry run. */
    deleted: number;
  };
}

/**
 * Plan and, unless `dryRun`, carry out a prune: one commit on the local
 * `chant/lifecycle` that removes what the plan lets go, and the run event
 * files it lets go deleted. The commit is planned against the tip it is
 * written on: if the branch moved in between, the plan is made again. It is
 * pushed only when `push` is set.
 */
export async function runLifecycleGc(input: GcInput & { dryRun: boolean; push?: boolean }): Promise<GcReport> {
  let plan = planLifecycleGc(input);
  let commit: string | null = null;
  if (!input.dryRun && plan.tip && plan.remove.length > 0) {
    for (let attempt = 1; ; attempt++) {
      const removals: LedgerFileRemoval[] = plan.remove.map((f) => ({ path: f.path, remove: true, expectPriorSha: f.sha }));
      try {
        commit = await writeLedgerFiles(removals, pruneMessage(plan.remove), { cwd: input.cwd, expectTip: plan.tip! });
        break;
      } catch (err) {
        if (!(err instanceof RefCASConflictError) || attempt >= PRUNE_ATTEMPTS) throw err;
        plan = planLifecycleGc(input);
        if (!plan.tip || plan.remove.length === 0) break;
      }
    }
  }
  let pushed = false;
  let pushWarning: string | undefined;
  if (commit && input.push) {
    const r = await pushLifecycleReport({ cwd: input.cwd });
    pushed = r.pushed;
    pushWarning = r.pushWarning;
  }

  const events = await planRunEventPrune(input.cwd, input.policy.runEvents, input.now);
  const deleted = input.dryRun ? 0 : pruneRunEvents(events);
  return {
    now: input.now.toISOString(),
    policy: input.policy,
    dryRun: input.dryRun,
    lifecycle: { ...plan, commit, pushed, ...(pushWarning ? { pushWarning } : {}) },
    runEvents: {
      dir: events.dir,
      remove: events.remove,
      kept: { files: events.keep.length, bytes: events.keep.reduce((n, f) => n + f.bytes, 0) },
      deleted,
    },
  };
}
