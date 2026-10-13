/**
 * Verify a change against the policy at its base (#2524 D5, Threat model).
 *
 * This is what CI runs on a protected branch: every commit in `base..head` is
 * asked of the attestors with the policy read at base, so nothing the change
 * does to its own copy of the policy counts. A change that edits the policy
 * (the signers file or `.chant/trust.json`) is a protected write: every commit
 * that touches those files must be attested by a signer the base policy
 * trusts, and by an admin when the base policy grants the admin role.
 *
 * The write scope is policy too (#3079): when the workspace declaration at
 * base has a `writeScope` or `agents` block, a commit that changes either
 * block, or removes the declaration, is a protected write on the same terms.
 * Other edits to the declaration are not. The declaration is found from
 * `cwd`, as `chant workspace check --changes` finds it.
 *
 * Attestation is opt-in (#2525 rule 6). Without a signers file at base the
 * check passes and says so, unless `--require attested` asks for more.
 *
 * Agent runs (#3192): a commit an agent run made, by its `Chant-Run` trailer
 * or its run's end, is attested by a run statement that a runner or steward
 * key at base signed and that names the commit. Such a commit counts as
 * `attested` with the attestor `agent-run`, so `--require attested` tells a
 * person's signed commit from a run's attested one by the attestor.
 * `--require attested-runs` asks only that every commit a run made be
 * covered, and needs runner keys at base but no signers file. Without
 * `--require`, `runs` reports and nothing fails (studio-035 d).
 */

import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DECLARATION_FILES, WorkspaceReadError } from "../declaration";
import { parseJsonText } from "../jsonc";
import { locateWorkspace } from "../which-chant";
import { type CommitAttestor, type ProvenanceLevel } from "./attestor";
import { policyAtBase, commitProvenance, resolveBase, type BaseSource, type RecordProvenance } from "./provenance";
import { policyWriters, protectedPaths, type ExcludedSigner, type TrustPolicy } from "./policy";
import { fileAt, nextVersion, rotationPath, signerHistory, type RotationRefusalCode } from "./rotation";
import { changeRuns, type ChangeRuns } from "./run-commits";

/** What `--require` takes: a provenance level, or `attested-runs` (#3192). */
export type VerifyRequirement = ProvenanceLevel | "attested-runs";

export interface CommitVerdict extends RecordProvenance {
  commit: string;
  subject: string;
  /** A merge that changes nothing of its own; its parents are checked instead. */
  skipped?: string;
}

export interface ProtectedWrite {
  commit: string;
  paths: string[];
  /** For a declaration write (#3079): the scope blocks the commit changes. */
  blocks?: ScopeBlock[];
  level: ProvenanceLevel;
  principal?: string;
  allowed: boolean;
  reason: string;
}

export interface ChangeReport {
  base: string | null;
  baseFrom: BaseSource | null;
  head: string | null;
  policy: {
    active: boolean;
    signersPath: string;
    principals: string[];
    excluded: ExcludedSigner[];
    writers: string[];
    problems: string[];
  };
  require: VerifyRequirement | null;
  commits: CommitVerdict[];
  /** The change's commits that agent runs made, and which a signed run statement covers (#3192). */
  runs: ChangeRuns;
  protectedPaths: string[];
  /** Protected paths whose content differs between the merge base and head. */
  protectedChanged: string[];
  protectedWrites: ProtectedWrite[];
  /**
   * The workspace declaration at base, when it has a scope block (#3079): its
   * path from the repository root, the blocks it has, and the blocks that
   * differ between the merge base and head.
   */
  declaration: { path: string; blocks: ScopeBlock[]; changed: ScopeBlock[] } | null;
  /**
   * When the change edits the signer set (#2553): the version it proposes and
   * who signed it, or, when the new set is refused, the version it had to
   * follow and why.
   */
  rotation: { from: number; to: number; signedBy: string[] } | { from: number; code: RotationRefusalCode; reason: string } | null;
  notes: string[];
  failures: string[];
  ok: boolean;
}

export interface VerifyOptions {
  repo: string;
  /** Where to look for the workspace declaration, as `check --changes` does; the repository root by default. */
  cwd?: string;
  base?: string;
  head?: string;
  require?: VerifyRequirement;
  attestors: readonly CommitAttestor[];
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

/**
 * Commits in `range` that change any of `paths`, each with the paths it
 * changes. Merges count only for what they change beyond every parent.
 */
export function commitsTouching(repo: string, range: string, paths: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const log = git(repo, ["--literal-pathspecs", "log", "-c", "--name-only", "--no-renames", "--format=%x00%H", range, "--", ...paths]);
  const wanted = new Set(paths);
  let commit = "";
  for (const line of log.split("\n")) {
    if (line.startsWith("\0")) commit = line.slice(1).trim();
    else if (line && wanted.has(line)) out.set(commit, [...(out.get(commit) ?? []), line]);
  }
  return out;
}

/** The declaration blocks whose change is a protected write (#3079). */
export type ScopeBlock = "writeScope" | "agents";
const SCOPE_BLOCKS: readonly ScopeBlock[] = ["writeScope", "agents"];

/** The scope blocks of the declaration in `dir` at `rev`: absent ones undefined, or the text when it can't be read. */
type ScopeState = { blocks: Partial<Record<ScopeBlock, unknown>> } | { unreadable: string };

function scopeState(repo: string, rev: string, dir: string): ScopeState {
  const present = DECLARATION_FILES.map((name) => ({ name, text: fileAt(repo, rev, posix.join(dir, name)) })).filter((f) => f.text !== undefined);
  if (present.length === 0) return { blocks: {} };
  if (present.length > 1) return { unreadable: present.map((f) => f.text).join("\0") };
  const parsed = parseJsonText(present[0].text!, { jsonc: present[0].name.endsWith(".jsonc") });
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) return { unreadable: present[0].text! };
  const obj = parsed.value as Record<string, unknown>;
  return { blocks: Object.fromEntries(SCOPE_BLOCKS.filter((b) => obj[b] !== undefined).map((b) => [b, obj[b]])) };
}

/** The scope blocks that differ between two states; all of them when either can't be read and the texts differ. */
function changedBlocks(a: ScopeState, b: ScopeState): ScopeBlock[] {
  if ("unreadable" in a || "unreadable" in b) {
    return "unreadable" in a && "unreadable" in b && a.unreadable === b.unreadable ? [] : [...SCOPE_BLOCKS];
  }
  return SCOPE_BLOCKS.filter((k) => !isDeepStrictEqual(a.blocks[k], b.blocks[k]));
}

/**
 * The directory, from the repository root, of the declaration found from
 * `cwd` at `base`, with the scope blocks it has there. Null when there is no
 * declaration, or one with neither block: then nothing in it is protected. A
 * declaration that can't be read at base counts as having both.
 */
function scopedDeclarationAt(repo: string, cwd: string, base: string): { dir: string; blocks: ScopeBlock[] } | null {
  let dir: string;
  try {
    const root = locateWorkspace(cwd, base).root;
    dir = root === "." ? "" : root;
  } catch (err) {
    if (err instanceof WorkspaceReadError) return null;
    throw err;
  }
  const state = scopeState(repo, base, dir);
  const blocks = "unreadable" in state ? [...SCOPE_BLOCKS] : SCOPE_BLOCKS.filter((b) => b in state.blocks);
  return blocks.length > 0 ? { dir, blocks } : null;
}

/** Whether a merge commit changes nothing beyond what its parents bring. */
function mergeWithoutOwnChanges(repo: string, commit: string, parents: number): boolean {
  if (parents < 2) return false;
  return git(repo, ["diff-tree", "-c", "--name-only", "--no-commit-id", "-r", commit]).trim() === "";
}

export function verifyChange(opts: VerifyOptions): ChangeReport {
  const { repo } = opts;
  const base = resolveBase(repo, opts.base);
  const policy: TrustPolicy = policyAtBase(repo, base);
  const report: ChangeReport = {
    base: base.commit,
    baseFrom: base.from,
    head: null,
    policy: {
      active: policy.active,
      signersPath: policy.signersPath,
      principals: [...new Set(policy.signers.map((s) => s.principal))].sort(),
      excluded: policy.excluded,
      writers: [...policyWriters(policy)].sort(),
      problems: policy.problems,
    },
    require: opts.require ?? null,
    commits: [],
    runs: { ledger: null, runners: [], commits: [] },
    protectedPaths: protectedPaths(policy),
    protectedChanged: [],
    protectedWrites: [],
    declaration: null,
    rotation: null,
    notes: [],
    failures: [],
    ok: false,
  };
  const headRev = opts.head ?? "HEAD";
  let head: string | undefined;
  try {
    head = headRev.startsWith("-") ? undefined : git(repo, ["rev-parse", "--verify", "--quiet", `${headRev}^{commit}`]).trim() || undefined;
  } catch {
    head = undefined;
  }
  if (!base.commit) report.failures.push(base.problem ?? "no base revision");
  if (!head) report.failures.push(`--head ${headRev} names no commit in this repository`);
  if (!base.commit || !head) return report;
  report.head = head;
  if (policy.problems.length > 0) {
    report.failures.push(...policy.problems.map((p) => `the policy at base cannot be read, so nothing verifies: ${p}`));
    return report;
  }

  // Every commit in the change, oldest first, with its parents.
  const listing = git(repo, ["rev-list", "--reverse", "--parents", `${base.commit}..${head}`]).split("\n").filter(Boolean);
  const parentList = new Map(listing.map((l) => { const [c, ...p] = l.split(" "); return [c, p] as const; }));
  const parentsOf = new Map([...parentList].map(([c, p]) => [c, p.length] as const));
  report.runs = changeRuns(repo, [...parentsOf.keys()], policy.runners);
  if (opts.require === "attested-runs") {
    if (policy.runners.length === 0 && report.runs.commits.length > 0) {
      report.notes.push(`.chant/trust.json at base lists no runner keys, so no run statement can verify`);
    }
    for (const r of report.runs.commits) {
      if (r.attested || r.runs.length === 0 || mergeWithoutOwnChanges(repo, r.commit, parentsOf.get(r.commit) ?? 0)) continue;
      report.failures.push(`${r.commit.slice(0, 8)} was made by agent run ${r.runs.join(", ")}, and --require attested-runs was given: ${r.reason}`);
    }
  }

  const mergeBase = git(repo, ["merge-base", base.commit, head]).trim();
  const changedPaths = git(repo, ["--literal-pathspecs", "diff", "--name-only", "--no-renames", mergeBase, head, "--", ...report.protectedPaths])
    .split("\n")
    .filter(Boolean);
  report.protectedChanged = changedPaths;

  if (!policy.active) {
    report.notes.push(`no signers file (${policy.signersPath}) at base ${base.commit.slice(0, 8)}: attestation is off and nothing is verified`);
    if (changedPaths.includes(policy.signersPath)) {
      report.notes.push(`this change adds ${policy.signersPath}; it applies to changes made after it is merged, never to this one`);
    }
    if (opts.require && opts.require !== "attested-runs") report.failures.push(`--require ${opts.require} was given, and there is no signers file at base to attest anything`);
    report.ok = report.failures.length === 0;
    return report;
  }

  // Every commit in the change, judged by the policy at base.
  const runCover = new Map(report.runs.commits.filter((r) => r.attested).map((r) => [r.commit, r]));
  const verdicts = new Map<string, CommitVerdict>();
  for (const line of listing) {
    const [commit, ...parents] = line.split(" ");
    const subject = git(repo, ["log", "-1", "--format=%s", commit]).trim();
    let p = commitProvenance(repo, policy, commit, opts.attestors);
    const cover = runCover.get(commit);
    // A commit no signer attests, made by a run a runner key at base vouches for (#3192).
    if (p.level !== "attested" && cover) p = { level: "attested", commit, attestor: "agent-run", principal: cover.signer, reason: cover.reason };
    const v: CommitVerdict = { ...p, commit, subject };
    if (p.level !== "attested" && mergeWithoutOwnChanges(repo, commit, parents.length)) {
      v.skipped = "a merge with no changes of its own; the commits it brings are checked instead";
    }
    verdicts.set(commit, v);
    report.commits.push(v);
  }

  // Protected writes: every commit that touches the policy needs a writer's signature.
  const writers = policyWriters(policy);
  const judge = (commit: string, paths: string[], blocks?: ScopeBlock[]) => {
    const v = verdicts.get(commit) ?? { ...commitProvenance(repo, policy, commit, opts.attestors), commit, subject: "" };
    const allowed = v.level === "attested" && v.principal !== undefined && writers.has(v.principal);
    const who = policy.roles.admin?.length ? "an admin the policy at base names" : "a signer the policy at base lists";
    const what = blocks ? `${paths.join(", ")} (${blocks.join(", ")})` : paths.join(", ");
    const reason = allowed
      ? `signed by ${v.principal}, ${who.replace(/^an? /, "")}`
      : v.level === "attested"
        ? `signed by ${v.principal}, who is not ${who}`
        : `${what} is protected and needs a signature by ${who}: ${v.reason}`;
    report.protectedWrites.push({ commit, paths, ...(blocks ? { blocks } : {}), level: v.level, ...(v.principal ? { principal: v.principal } : {}), allowed, reason });
    if (!allowed) report.failures.push(`${commit.slice(0, 8)} changes ${what}: ${reason}`);
  };
  if (changedPaths.length > 0) {
    const touching = commitsTouching(repo, `${base.commit}..${head}`, report.protectedPaths);
    if (touching.size === 0) {
      report.failures.push(`the policy files ${changedPaths.join(", ")} differ from base, and no commit in the change accounts for it`);
    }
    for (const [commit, paths] of touching) judge(commit, paths);
  }

  // The write scope in the declaration at base (#3079): a commit that changes writeScope or agents.
  const scoped = scopedDeclarationAt(repo, opts.cwd ?? repo, base.commit);
  if (scoped) {
    const files = DECLARATION_FILES.map((name) => posix.join(scoped.dir, name));
    const changed = changedBlocks(scopeState(repo, mergeBase, scoped.dir), scopeState(repo, head, scoped.dir));
    report.declaration = { path: files.find((f) => fileAt(repo, base.commit!, f) !== undefined) ?? files[0], blocks: scoped.blocks, changed };
    if (changed.length > 0) {
      let accounted = false;
      for (const [commit, paths] of commitsTouching(repo, `${base.commit}..${head}`, files)) {
        const after = scopeState(repo, commit, scoped.dir);
        // A merge changes a block only when it differs from every parent.
        const per = (parentList.get(commit) ?? []).map((p) => new Set(changedBlocks(scopeState(repo, p, scoped.dir), after)));
        const blocks = SCOPE_BLOCKS.filter((b) => per.length > 0 && per.every((s) => s.has(b)));
        if (blocks.length === 0) continue;
        accounted = true;
        judge(commit, paths, blocks);
      }
      if (!accounted) {
        report.failures.push(`${changed.join(" and ")} in ${report.declaration.path} differ from base, and no commit in the change accounts for it`);
      }
    }
  }

  // A new signer set must be signed by a threshold of the set at base (#2553).
  const rotation = rotationPath(policy.signersPath);
  if (changedPaths.includes(policy.signersPath) || changedPaths.includes(rotation)) {
    const next = { signers: fileAt(repo, head, policy.signersPath), rotation: fileAt(repo, head, rotation) };
    const latest = signerHistory(repo, base.commit, policy.signersPath).versions.at(-1);
    if (next.signers !== undefined && latest && latest.version > 0) {
      const v = nextVersion(latest, next, null);
      if ("code" in v) {
        report.rotation = { from: latest.version, code: v.code, reason: v.reason };
        report.failures.push(`the signer set at head is not a valid rotation of the set at base (${v.code}): ${v.reason}`);
      } else if (v !== latest) report.rotation = { from: latest.version, to: v.version, signedBy: v.signedBy };
    }
  }

  if (opts.require && opts.require !== "attested-runs") {
    for (const v of report.commits) {
      if (v.skipped || v.level === opts.require) continue;
      report.failures.push(`${v.commit.slice(0, 8)} is ${v.level}, and --require ${opts.require} was given: ${v.reason}`);
    }
  }
  report.ok = report.failures.length === 0;
  return report;
}
