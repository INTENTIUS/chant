/**
 * The why chain of a region (#4023): for each commit the intent walk read,
 * the work item it names, its ci tag, the release that shipped it, the gate
 * resolutions that admitted that release and the deploy records per
 * environment. "Who asked for this, and who let it ship" in one read.
 *
 * Every link is made by a record that already exists, and each one states
 * that record in `source`, so a reader can follow it:
 *
 * - work item: a `Chant-Record` or `Chant-Lease` trailer, judged as #4029's
 *   `judgeCommitLink` judges it. A commit in a work item's window (the
 *   intent graph's `worked` bucket) is listed apart, as a window match, and
 *   never links it.
 * - ci tag: `ci/green/<sha>` or `ci/revoked/<sha>`, judged as `release cut`
 *   judges it (#4031, `judgedCiTags`).
 * - release: `_releases/<digest>.json`, whose `commit` is the commit itself
 *   (`cut-from`) or one that has it in its history (`contains`).
 * - gates and deploys: `joinRelease` (#4043), and a deploy's `admission`
 *   read back to the resolution in `_gates/<op>.jsonl` (#4020).
 * - the plan a gate bound: the change set stored under its `planDigest`
 *   (#4022), and a deploy's release plan in `_plans/` (ws-055).
 *
 * A commit is "contained" by a later commit when that commit has it as an
 * ancestor in the history read. For each commit the chain names the releases
 * cut from it, or failing those the first release cut after it, and the first
 * deploy per environment that shipped it, so the document stays the size of
 * the walk. Everything is read from local git: the tags and the local
 * `chant/lifecycle` branch. Nothing is fetched.
 */

import { execFileSync } from "node:child_process";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import type { ReleaseRecord, RunOrigin } from "../lifecycle/release-ledger";
import type { JoinedRelease } from "../lifecycle/release-join";
import type { ReleasePlan } from "../lifecycle/plan-ledger";
import type { Release, ReleaseCut } from "../lifecycle/release-store";
import type { CiTags, CountedCiTag, IgnoredCiTag, RevokedTagView } from "./ci-green";
import type { CommitLinkProblem, CommitLinkState, WorkIndex } from "./commit-links";
import type { CiGreen } from "./declaration";
import type { CommitTrailerJoins } from "./trailer-joins";

/** Where a link comes from: the record (`ref`), and the field of it whose `value` made the join. */
export interface TraceSource {
  /** A commit sha, a tag ref (`refs/tags/...`), a record file, or a path on `chant/lifecycle` (`chant/lifecycle:<path>`). */
  ref: string;
  /** The trailer, field or edge that joins, such as `Chant-Record`, `commit`, `releaseDigest`, `admission` or `window`. */
  field: string;
  /** Its value, as the record holds it. */
  value: string;
}

/** A work item a commit links to, or falls in the window of. */
export interface TraceWork {
  /** `<kind>:<id>`. */
  id: string;
  /** The work node in `nodes`, or null when no kind read has the record. */
  node: string | null;
  source: TraceSource;
}

export interface TraceTagView {
  tag: string;
  tagged: string | null;
  /** The runner whose statement the tag carries, or null for a tag that counts unsigned (#4031). */
  signer: string | null;
  source: TraceSource;
}

/** A commit's ci tags as readers count them (#4031, ws-103). */
export interface TraceTag {
  /** `revoked` when a revoked tag counts, else `green` when a green tag counts, else `none`. */
  state: "green" | "revoked" | "none";
  green: TraceTagView | null;
  revoked: (TraceTagView & Pick<RevokedTagView, "phase" | "run">) | null;
  /** Tags on the commit that exist and don't count. */
  ignored: IgnoredCiTag[];
}

/** One gate resolution: who let it through, on which channel, when, and for which plan. */
export interface TraceGate {
  op: string;
  gate: string;
  environment: string | null;
  resolvedBy: string;
  relayedBy: string | null;
  /** `cli`, `mcp` or `acp`, the channel the resolution was authored on (#2384), or null when the record doesn't say. */
  channel: string | null;
  at: string;
  planDigest: string | null;
  /** `planDigest`, when a change set is stored under it (#4022): `chant change-set show <changeSet>` prints it. */
  changeSet: string | null;
  changeSetSource: TraceSource | null;
  /** A pass over an empty change set, written by the promote itself (#4045). */
  empty: boolean;
  /** Whether the approval carries an ssh seal (`chant approve --sign`, #3163). `status` judges it against the signers at base. */
  sealed: boolean;
  url: string | null;
  source: TraceSource;
}

/** A release that shipped a commit of the walk. */
export interface TraceRelease {
  releaseDigest: string;
  label: string | null;
  member: string | null;
  /** The green commit it was cut from. */
  commit: string;
  /** That commit's ci tags. */
  tag: TraceTag;
  source: TraceSource;
  cuts: { label: string | null; actor: string; timestamp: string; signed: boolean; runOrigin: RunOrigin | null; source: TraceSource }[];
  /** The release gate's resolutions for it, oldest first. */
  gates: TraceGate[];
  /** The ids of its deploy records in `deploys`, oldest first. */
  deploys: string[];
}

/** A deploy record (`ReleaseRecord` in `<env>/releases.jsonl`). */
export interface TraceDeploy {
  /** `deploy:<member>/<env>/<component>/<runId>@<timestamp>`, with `.` for a ledger of no member. */
  id: string;
  member: string | null;
  env: string;
  component: string;
  timestamp: string;
  actor: string;
  approver: string | null;
  runId: string;
  runOrigin: RunOrigin | null;
  gitSha: string;
  digest: string;
  /** The release it was made from, by its `releaseDigest` or through the release gate resolution its admission names (#4043), or null. */
  release: string | null;
  releaseSource: TraceSource | null;
  /** The gate resolution its `admission` names (#4020), or null for an ungated deploy, one recorded before 0.124.28, or one whose resolution is not on the branch. */
  admittedBy: TraceGate | null;
  /** The release plan its `digest` names in `_plans/` (ws-055), or null when none is stored. */
  plan: { document: ReleasePlan; source: TraceSource } | null;
  source: TraceSource;
}

export interface TraceCommit {
  /** The commit node. */
  commit: string;
  sha: string;
  /**
   * The work items the commit names, judged as `check --changes` judges it
   * (#4029): `linked`, `unlinked`, `wrong` or `merge`. Null when no work kind
   * was read.
   */
  work: { state: CommitLinkState; items: TraceWork[]; problems: CommitLinkProblem[] } | null;
  /** The work items whose window holds the commit (the `worked` within edges). They don't link it. */
  windowMatches: TraceWork[];
  tag: TraceTag;
  /** The releases cut from the commit, or when none, the first release cut from a commit that has it in its history. */
  releases: { release: string; link: "cut-from" | "contains"; source: TraceSource }[];
  /** Per environment, the first deploy record built from the commit or a commit that has it in its history. */
  deploys: { deploy: string; env: string; link: "built-from" | "contains"; source: TraceSource }[];
}

export type TraceReasonCode = "ledger-unreadable" | "declaration-invalid";

/** The why chain (#4023): commits in walk order, then the releases and deploys they name. */
export interface IntentTrace {
  commits: TraceCommit[];
  releases: TraceRelease[];
  deploys: TraceDeploy[];
  /** Parts of the chain that could not be read: the ci tags (`declaration-invalid`) or a ledger (`ledger-unreadable`). The rest stands. */
  reasons: { code: TraceReasonCode; message: string }[];
}

export interface TraceInput {
  top: string;
  /** The commits of the walk, in its order. */
  commits: { id: string; sha: string; trailers: Record<string, string[]>; joins: CommitTrailerJoins }[];
  /** The work records the walk read, by work kind, and their nodes by `<kind>:<id>`. Null when no work kind was read. */
  work: { index: Omit<WorkIndex, "ledger">; nodes: Map<string, string> } | null;
  /** The work items whose window holds each commit, by sha. */
  windows: Map<string, { id: string; node: string; path: string }[]>;
  /**
   * The ledgers to read, each as the directory `chant/lifecycle` stores
   * resolve it from. `within` is a path part every ledger of the member has,
   * `_members/<name>/`, so a member with nothing on the branch is skipped
   * unread; null when it can't be told, as for a member at the root.
   */
  ledgers: { member: string | null; cwd: string; within: string | null }[];
  green: CiGreen | null;
  /** Whether `later` is `sha` or has it as an ancestor, in the history read. */
  contains: (sha: string, later: string) => boolean;
}

function tryGit(top: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

const fileOf = (digest: string): string => `${digest.replace(/:/g, "_")}.json`;
const onBranch = (path: string): string => `chant/lifecycle:${path}`;
const byTime = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type RevokedView = (sha: string, r: CountedCiTag) => RevokedTagView;

function tagOf(sha: string, tags: CiTags | null, revokedView: RevokedView): TraceTag {
  const green = tags?.green.get(sha);
  const revoked = tags?.revoked.get(sha);
  const view = (kind: "green" | "revoked", t: CountedCiTag): TraceTagView => ({
    tag: `ci/${kind}/${sha}`,
    tagged: t.tagged,
    signer: t.signer,
    source: { ref: `refs/tags/ci/${kind}/${sha}`, field: "name", value: sha },
  });
  return {
    state: revoked ? "revoked" : green ? "green" : "none",
    green: green ? view("green", green) : null,
    revoked: revoked ? { ...view("revoked", revoked), phase: revokedView(sha, revoked).phase, run: revokedView(sha, revoked).run } : null,
    ignored: tags?.ignored.get(sha) ?? [],
  };
}

/** Build the chain. Never throws for a ledger or tag it can't read: that is a reason. */
export async function buildTrace(input: TraceInput): Promise<IntentTrace> {
  const { top } = input;
  const reasons: IntentTrace["reasons"] = [];
  const shas = input.commits.map((c) => c.sha);

  // The ci tags, judged as release cut judges them.
  let tags: CiTags | null = null;
  const { revokedTagView } = await import("./ci-green");
  try {
    const { judgedCiTags } = await import("../lifecycle/release-revocation");
    tags = await judgedCiTags(top, input.green);
  } catch (err) {
    reasons.push({ code: "declaration-invalid", message: `the ci tags could not be judged: ${err instanceof Error ? err.message : String(err)}` });
  }

  // The work item each commit names (#4029).
  const { judgeCommitLink, hasLeaseLedger, mergeCommits } = await import("./commit-links");
  const index: WorkIndex | null = input.work ? { ...input.work.index, ledger: hasLeaseLedger(top) } : null;
  const merges = index ? mergeCommits(top, shas) : new Set<string>();
  const workNode = (id: string) => input.work?.nodes.get(id) ?? null;

  // The ledgers on the local chant/lifecycle branch.
  const branch = tryGit(top, ["rev-parse", "--verify", "--quiet", "refs/heads/chant/lifecycle"]) !== undefined;
  interface Ledger {
    member: string | null;
    loc: { cwd: string };
    prefix: string;
    releases: Release[];
    deploys: { env: string; record: ReleaseRecord }[];
  }
  const ledgers: Ledger[] = [];
  // One listing of the branch, so a ledger that holds no release and no deploy costs nothing more.
  const paths = branch ? (tryGit(top, ["ls-tree", "-r", "--name-only", "--full-tree", "refs/heads/chant/lifecycle"]) ?? "").split("\n").filter(Boolean) : [];
  const holds = (prefix: string) =>
    paths.some((p) => p.startsWith(prefix) && (p.startsWith(`${prefix}_releases/`) || /^[^/_][^/]*\/releases\.jsonl$/.test(p.slice(prefix.length))));
  if (branch) {
    const { resolveMemberLedger } = await import("../lifecycle/member-ledger");
    const { readAllReleases } = await import("../lifecycle/release-store");
    const { listReleaseEnvironments, readReleaseLedger } = await import("../lifecycle/release-ledger");
    for (const l of input.ledgers) {
      if (l.within !== null && !paths.some((p) => p.includes(l.within!))) continue;
      const loc = { cwd: l.cwd };
      try {
        const prefix = (await resolveMemberLedger(l.cwd)).prefix;
        if (ledgers.some((x) => x.prefix === prefix) || !holds(prefix)) continue;
        const { releases } = await readAllReleases(loc);
        const deploys: Ledger["deploys"] = [];
        for (const env of await listReleaseEnvironments(loc)) {
          for (const record of (await readReleaseLedger(env, loc)).records) deploys.push({ env, record });
        }
        ledgers.push({ member: l.member, loc, prefix, releases, deploys });
      } catch (err) {
        reasons.push({ code: "ledger-unreadable", message: `${l.member ?? "the workspace"}'s ledger on chant/lifecycle: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` });
      }
    }
  }

  // Each commit to the releases and deploys that shipped it.
  const firstCut = new Map<string, string>();
  const releaseHits = new Map<Ledger, Set<string>>();
  const deployHits = new Map<string, { ledger: Ledger; env: string; record: ReleaseRecord }>();
  const deployId = (l: Ledger, env: string, r: ReleaseRecord) => `deploy:${l.member ?? "."}/${env}/${r.component}/${r.runId}@${r.timestamp}`;
  const perCommit = new Map<string, { releases: TraceCommit["releases"]; deploys: TraceCommit["deploys"] }>();
  if (ledgers.some((l) => l.releases.length > 0)) {
    const { readCuts } = await import("../lifecycle/release-store");
    for (const l of ledgers) {
      if (l.releases.length === 0) continue;
      try {
        for (const c of (await readCuts(l.loc)).cuts) if (!firstCut.has(c.releaseDigest) || byTime(c.timestamp, firstCut.get(c.releaseDigest)!) < 0) firstCut.set(c.releaseDigest, c.timestamp);
      } catch {
        // A release with no readable cut sorts last; its file still joins.
      }
    }
  }
  for (const sha of shas) {
    const releases: TraceCommit["releases"] = [];
    const deploys: TraceCommit["deploys"] = [];
    for (const l of ledgers) {
      const releaseSource = (r: Release): TraceSource => ({ ref: onBranch(`${l.prefix}_releases/${fileOf(r.releaseDigest)}`), field: "commit", value: r.commit });
      const cut = l.releases.filter((r) => r.commit === sha);
      const chosen: { r: Release; link: "cut-from" | "contains" }[] = cut.map((r) => ({ r, link: "cut-from" as const }));
      if (chosen.length === 0) {
        const later = l.releases.filter((r) => input.contains(sha, r.commit)).sort((a, b) => byTime(firstCut.get(a.releaseDigest) ?? "￿", firstCut.get(b.releaseDigest) ?? "￿") || byTime(a.releaseDigest, b.releaseDigest));
        if (later.length > 0) chosen.push({ r: later[0], link: "contains" });
      }
      for (const { r, link } of chosen) {
        releases.push({ release: r.releaseDigest, link, source: releaseSource(r) });
        (releaseHits.get(l) ?? releaseHits.set(l, new Set()).get(l)!).add(r.releaseDigest);
      }
      const first = new Map<string, { env: string; record: ReleaseRecord; link: "built-from" | "contains" }>();
      for (const d of l.deploys) {
        const link = d.record.gitSha === sha ? "built-from" : input.contains(sha, d.record.gitSha) ? "contains" : null;
        if (!link) continue;
        const had = first.get(d.env);
        if (!had || byTime(d.record.timestamp, had.record.timestamp) < 0) first.set(d.env, { ...d, link });
      }
      for (const [env, d] of [...first].sort(([a], [b]) => byTime(a, b))) {
        const id = deployId(l, env, d.record);
        deployHits.set(id, { ledger: l, env, record: d.record });
        deploys.push({ deploy: id, env, link: d.link, source: { ref: onBranch(`${l.prefix}${env}/releases.jsonl`), field: "gitSha", value: d.record.gitSha } });
      }
    }
    perCommit.set(sha, { releases, deploys });
  }

  // The releases, through joinRelease, with their gates and deploys.
  const { joinRelease } = await import("../lifecycle/release-join");
  const { readGateLedger } = await import("../lifecycle/gate-ledger");
  const { readStoredChangeSet, changeSetFile, CHANGE_SETS_DIR } = await import("../lifecycle/change-set-store");
  const gateLedgers = new Map<string, Promise<GateResolutionRecord[]>>();
  const resolutionsOf = (l: Ledger, op: string) => {
    const key = `${l.prefix}\0${op}`;
    let hit = gateLedgers.get(key);
    if (!hit) {
      hit = readGateLedger(op, l.loc).then(
        (g) => g.resolutions,
        () => [],
      );
      gateLedgers.set(key, hit);
    }
    return hit;
  };
  const changeSets = new Map<string, Promise<boolean>>();
  const gateOf = async (l: Ledger, r: GateResolutionRecord): Promise<TraceGate> => {
    let stored: Promise<boolean> | undefined;
    if (r.planDigest) {
      const key = `${l.prefix}\0${r.planDigest}`;
      stored = changeSets.get(key);
      if (!stored) {
        stored = readStoredChangeSet(r.planDigest, l.loc).then(
          (x) => x.status === "found",
          () => false,
        );
        changeSets.set(key, stored);
      }
    }
    const has = stored ? await stored : false;
    return {
      op: r.op,
      gate: r.gate,
      environment: r.environment ?? null,
      resolvedBy: r.resolvedBy,
      relayedBy: r.relayedBy ?? null,
      channel: r.origin ?? null,
      at: r.timestamp,
      planDigest: r.planDigest ?? null,
      changeSet: has ? r.planDigest! : null,
      changeSetSource: has ? { ref: onBranch(`${l.prefix}${CHANGE_SETS_DIR}/${changeSetFile(r.planDigest!)}`), field: "planDigest", value: r.planDigest! } : null,
      empty: r.empty === true,
      sealed: r.seal !== undefined,
      url: r.url ?? null,
      source: { ref: onBranch(`${l.prefix}_gates/${r.op}.jsonl`), field: r.releaseDigest ? "releaseDigest" : "gate", value: r.releaseDigest ?? r.gate },
    };
  };

  const releases: TraceRelease[] = [];
  const joinedDeploys = new Map<string, { ledger: Ledger; env: string; record: ReleaseRecord; release: JoinedRelease }>();
  for (const l of ledgers) {
    const wanted = releaseHits.get(l);
    if (!wanted || wanted.size === 0) continue;
    const commits = [...new Set(l.releases.filter((r) => wanted.has(r.releaseDigest)).map((r) => r.commit))];
    let joined: JoinedRelease[];
    try {
      joined = (await joinRelease({ commits }, l.loc)).releases;
    } catch (err) {
      reasons.push({ code: "ledger-unreadable", message: `joining ${l.member ?? "the workspace"}'s releases: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` });
      continue;
    }
    for (const j of joined) {
      for (const d of j.deploys) joinedDeploys.set(deployId(l, d.env, d), { ledger: l, env: d.env, record: d, release: j });
      releases.push({
        releaseDigest: j.releaseDigest,
        label: j.label,
        member: j.release.member,
        commit: j.commit,
        tag: tagOf(j.commit, tags, revokedTagView),
        source: { ref: onBranch(`${l.prefix}_releases/${fileOf(j.releaseDigest)}`), field: "releaseDigest", value: j.releaseDigest },
        cuts: j.cuts.map((c: ReleaseCut) => ({
          label: c.label,
          actor: c.actor,
          timestamp: c.timestamp,
          signed: c.signature !== null,
          runOrigin: c.runOrigin,
          source: { ref: onBranch(`${l.prefix}_releases/cuts.jsonl`), field: "releaseDigest", value: c.releaseDigest },
        })),
        gates: await Promise.all([...j.gates.resolutions].sort((a, b) => byTime(a.timestamp, b.timestamp)).map((r) => gateOf(l, r))),
        deploys: j.deploys.map((d) => deployId(l, d.env, d)),
      });
    }
  }

  // The deploys: those a commit names and those of each release, oldest first.
  const { readReleasePlan } = await import("../lifecycle/plan-ledger");
  const plans = new Map<string, Promise<ReleasePlan | null>>();
  const all = new Map<string, { ledger: Ledger; env: string; record: ReleaseRecord; release?: JoinedRelease }>([...deployHits, ...joinedDeploys]);
  const releaseResolutions = new Map<Ledger, GateResolutionRecord[]>();
  const deploys: TraceDeploy[] = [];
  for (const [id, d] of [...all].sort(([, a], [, b]) => byTime(a.record.timestamp, b.record.timestamp) || byTime(a.env, b.env))) {
    const r = d.record;
    const l = d.ledger;
    let release: string | null = r.releaseDigest ?? null;
    let releaseSource: TraceSource | null = release ? { ref: onBranch(`${l.prefix}${d.env}/releases.jsonl`), field: "releaseDigest", value: release } : null;
    if (!release && r.admission?.op === "release") {
      if (!releaseResolutions.has(l)) releaseResolutions.set(l, await resolutionsOf(l, "release"));
      const { releaseOfDeploy } = await import("../lifecycle/release-join");
      release = releaseOfDeploy(r, releaseResolutions.get(l)!) ?? null;
      if (release) releaseSource = { ref: onBranch(`${l.prefix}${d.env}/releases.jsonl`), field: "admission", value: `${r.admission.gate}@${r.admission.resolvedAt}` };
    }
    let admittedBy: TraceGate | null = null;
    if (r.admission) {
      const found = (await resolutionsOf(l, r.admission.op)).find((x) => x.gate === r.admission!.gate && x.timestamp === r.admission!.resolvedAt);
      if (found) admittedBy = await gateOf(l, found);
    }
    const planKey = `${l.prefix}\0${r.digest}`;
    let plan = plans.get(planKey);
    if (!plan) {
      plan = readReleasePlan(r.digest, l.loc).catch(() => null);
      plans.set(planKey, plan);
    }
    const document = await plan;
    deploys.push({
      id,
      member: l.member,
      env: d.env,
      component: r.component,
      timestamp: r.timestamp,
      actor: r.actor,
      approver: r.approver ?? null,
      runId: r.runId,
      runOrigin: r.runOrigin ?? null,
      gitSha: r.gitSha,
      digest: r.digest,
      release,
      releaseSource,
      admittedBy,
      plan: document ? { document, source: { ref: onBranch(`${l.prefix}_plans/${fileOf(r.digest)}`), field: "digest", value: r.digest } } : null,
      source: { ref: onBranch(`${l.prefix}${d.env}/releases.jsonl`), field: "runId", value: r.runId },
    });
  }

  const commits: TraceCommit[] = input.commits.map((c) => {
    let work: TraceCommit["work"] = null;
    if (index) {
      const judged = merges.has(c.sha) ? { state: "merge" as const, ids: [], problems: [] } : judgeCommitLink(c.trailers, c.joins, index);
      const items: TraceWork[] = judged.ids.map((id) => {
        const named = c.joins.records.some((r) => `${r.kind}:${r.id}` === id);
        return {
          id,
          node: workNode(id),
          source: named ? { ref: c.sha, field: "Chant-Record", value: id } : { ref: c.sha, field: "Chant-Lease", value: c.joins.lease?.token ?? "" },
        };
      });
      work = { state: judged.state, items, problems: judged.problems };
    }
    const windowMatches: TraceWork[] = (input.windows.get(c.sha) ?? []).map((w) => ({ id: w.id, node: w.node, source: { ref: w.path, field: "window", value: "worked" } }));
    const hit = perCommit.get(c.sha) ?? { releases: [], deploys: [] };
    return { commit: c.id, sha: c.sha, work, windowMatches, tag: tagOf(c.sha, tags, revokedTagView), releases: hit.releases, deploys: hit.deploys };
  });

  return { commits, releases, deploys, reasons };
}
