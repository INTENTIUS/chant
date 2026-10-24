/**
 * `chant ci serve` (#4095, epic #4101): the chant runner's trigger loop on one
 * host. It polls the forge for the open pull requests into the target branch
 * and for the branch's head, and runs the pull-request jobs with
 * {@link ciRun} (./ci-run.ts): `plan` for each new pull request head, and
 * `record` for each new commit on the target branch (#4168), measured from
 * the head the previous poll saw (the push's `before`). The record applies
 * nothing. With `applyOnMerge` (`--apply-on-merge`) the newest green commit
 * of the branch, once no apply ran for it, gets `apply`: `pr-apply --green`
 * at that commit, measured from the one last applied (#4168 step 9). After
 * each job settles it runs `ci tick` from the runs the jobs recorded, when
 * the declaration has `ci.green`, so a green commit follows the record that
 * made its runs. What the list below says of the apply holds for it under
 * `applyOnMerge`.
 *
 * - Dedupe. A state file in the state directory keeps every job it started,
 *   keyed by job and commit (`plan:<pr>:<sha>`, `record:<sha>`, `apply:<sha>`), with how it
 *   ended, and the target head the last apply was measured to. A job already
 *   in it is not started again, unless it failed and `rerunFailed` asks for
 *   it: the forge's "re-run failed jobs".
 * - One apply per group. An apply takes the git-ref lease (../lifecycle/lease.ts,
 *   the one `chant operator` holds) named for `prApplyGroup`, renews it while
 *   it runs and releases it after. An apply that finds it held waits for a
 *   later poll, as a forge's concurrency group queues it.
 * - Merged pull request. A record asks the forge for the pull request whose
 *   merge commit the new head is (`pullRequestFor`, as pr-record does) and
 *   passes it as `--pr`, so its commit status link and run index use
 *   `<pr>/<commit>`. With none found it runs without `--pr`. An apply covers
 *   every merge since the last applied green commit, so it passes none.
 * - Resume records. Each apply gets `<state>/resume/<prApplyRecordKey>.json`
 *   as its `--resume` record, so a re-run of a failed apply at the same
 *   commit finishes under the approval it has. This replaces the forge's CI
 *   cache.
 * - A gate per wave (#4003). With `--wave-gate` the apply job runs
 *   `pr-apply --wave-gate`, which applies the waves in order and stops at
 *   the first whose moved plan waits on its own gate. The job fails, and the
 *   resume record keeps the waves that applied; once the wave's plan is
 *   approved, `rerunFailed` runs the apply again and it carries on from
 *   that wave.
 * - Capacity. At most `maxJobs` jobs run at once. A job over the limit is not
 *   recorded, so a later poll starts it.
 * - Fast-forwards only (#4122). An apply runs only when the target's new head
 *   descends from the head seen before it. Any other move, such as a force
 *   push back to an older commit, is recorded as seen and not applied.
 * - `[skip ci]` (#4122). A target head or pull request head whose commit
 *   message says `[skip ci]` or `[ci skip]` is recorded as seen and not run,
 *   as Actions does.
 * - Build requests (#4169). With `buildCommand`, each `ci/build/<sha>`
 *   tag the tick or `ci run --at` pushed is served once: the command runs
 *   in a fresh detached worktree of the commit, with `CHANT_BUILD_COMMIT`,
 *   `CHANT_BUILD_PHASES` (comma-separated) and `CHANT_BUILD_REASON` set,
 *   and is expected to run the phases' Ops (`chant run <op>`), whose
 *   records the tick reads. A build counts against `maxJobs`, and the state
 *   file keeps it under `build:<sha>`. Without `buildCommand` the tags are
 *   left alone.
 * - The forge's ledger (#4121). Before each job, when no other job of this
 *   serve runs, the clone's `chant/lifecycle` follows the forge's: it is
 *   deleted when the forge has none, and reset to the forge's when neither
 *   contains the other. Each is a warning. A local branch ahead of the
 *   forge's keeps its facts, and the job's push sends them. Nothing here
 *   pushes the ledger.
 * - Routed branches (#4325). `ci.branches` decides the branches one serve
 *   polls: a routed member's route alone, an unrouted member's `--branch`
 *   (default `main`), and at the workspace root `main` and each routed
 *   branch. Jobs on a routed branch get `--branch`. The state file keeps a
 *   head per branch (`target`, then `targets`).
 *
 * - Land branches (#4168 4.4). With `land`, each `chant/land/<name>` branch
 *   pushed to the remote is a change asking to land without a pull request.
 *   A head that does not descend from the target's is refused and left for
 *   its author to rebase. Otherwise `buildCommand` runs on it with
 *   `CHANT_BUILD_PHASES` set to `ci.green.preMerge` and `CHANT_BUILD_REASON`
 *   `land`, and the phases are judged from the Op run records on its head
 *   ({@link judgePreMerge}). When the command exits 0 and every phase
 *   passes, the target is pushed to the head, a fast-forward the remote
 *   refuses if the target moved, and the land branch is deleted. The next
 *   poll sees the new head and runs the record job, whose merge record
 *   names a work item or a direct push. A refused land stays in the state
 *   file under `land:<name>:<sha>`, so a new push to the branch is tried
 *   again and the same head is not.
 * - The `git` forge kind (#4016 gap 6). With `forge: "git"` the serve reads
 *   only refs, through `git ls-remote` against `origin`, so any git server
 *   that takes pushes will do. It lists no pull requests and sets no commit
 *   status, and the jobs run without `--forge`.
 *
 * Host mode only: each job runs in a fresh worktree on this host as this
 * user, with the clean environment `ciRun` gives it. A pull request from a
 * fork is never planned, and with `authors` only those people's pull requests
 * are. Container isolation is #4015.
 *
 * A webhook is not here yet. {@link ciServeSchedule} takes triggers, and
 * {@link ciServeObserve} is the poll that makes them; a webhook handler would
 * turn a checked payload into the same triggers and schedule them.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CI_BUILD_TAG_PREFIX, readBuildRequests, type BuildRequestReason } from "./ci-builds";
import { prApplyGroup, prApplyRecordKey } from "../components/pr-pipeline";
import { forgeFromEnv, type OpenPullRequest } from "../pr-forge";
import type { CommandContext } from "../cli/registry";
import { formatError, formatWarning } from "../cli/format";
import { acquireLease, currentHolderId, releaseLease, DEFAULT_LEASE_TTL_MS, type LeaseRecord } from "../lifecycle/lease";
import { parseDuration } from "../op/duration";
import { reportUrlOf } from "./ci-report-url";
import { CI_JOB_OPS, ciJobPlace, ciLoopOptions, ciSecretsOf, ciRun, ciStatusFromEnv, CiRunError, type CiJobName, type CiRunRequest, type CiRunResult } from "./ci-run";
import { CiGreenError, ciTick, judgePreMerge, lastGreen, RUNNER_KEY_ENV, signedRunsRequired, type CommitVerdict } from "./ci-green";
import { gitTop } from "./tree";
import { readDeclaration } from "./declaration";
import { servedBranches } from "./ci-branches";
import { locateWorkspace } from "./which-chant";
import { ciServeRunnerKey, formatRunnerKeySetup, setupRunnerKey } from "./ci-runner-key";

/** The forges `ci serve` polls. GitLab is later. `git` is any git server, read through refs alone (#4016 gap 6). */
export type CiServeForgeKind = "github" | "forgejo" | "git";

/** What `ci serve` reads from the forge: the two calls GitHub's and Forgejo's clients have (../pr-forge.ts). */
export interface CiServeForge {
  openPullRequests(base: string): Promise<OpenPullRequest[]>;
  branchHead(branch: string): Promise<string | undefined>;
  /** The merged pull request that produced a commit, as pr-apply finds it (`pullRequestFor`). Without it an apply gets no `--pr`. */
  pullRequestFor?(sha: string): Promise<number | null>;
}

/**
 * A job the forge's state calls for: the plan of a pull request's head, or
 * for a target-branch commit its record (#4168), or with `applyOnMerge` the
 * apply of the newest green commit (#4168 step 9).
 */
export type CiServeTrigger =
  | { job: "plan"; commit: string; base: string; pr: number; rerun?: boolean; branch?: string }
  | { job: "apply" | "record"; commit: string; base: string; rerun?: boolean; branch?: string };

/**
 * The `git` forge kind (#4016 gap 6): the branch head from `git ls-remote`
 * against `remote`, and no pull requests. A remote that can't be reached is
 * an error for the pass, as a forge API's would be.
 */
export function gitCiServeForge(top: string, remote = "origin"): CiServeForge {
  return {
    openPullRequests: async () => [],
    async branchHead(branch) {
      const r = gitStatus(top, ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`]);
      if (r.code === 2) return undefined;
      if (r.code !== 0) throw new CiRunError(`git ls-remote ${remote} could not read refs/heads/${branch}`);
      return r.out.split(/\s+/)[0] || undefined;
    },
  };
}

/** What a build runs: a `ci/build/<sha>` request (#4169), or a land branch's pre-merge phases (#4168 4.4). */
export interface CiServeBuildInput {
  commit: string;
  phases: string[];
  reason: BuildRequestReason | "land";
}

/** Where pushed land branches live on the remote (#4168 4.4). */
export const LAND_BRANCH_PREFIX = "chant/land/";

/** One land branch head in the state file, by `land:<name>:<sha>`. */
export interface CiServeLandState {
  branch: string;
  commit: string;
  status: "running" | "landed" | "refused";
  /** Why it was refused, in a line. */
  reason?: string;
  startedAt: string;
  settledAt?: string;
}

/** One job in the state file. */
export interface CiServeJobState {
  job: CiJobName;
  commit: string;
  base: string;
  pr?: number;
  /** `running` while it runs; a `running` entry no live process holds is taken as failed. */
  status: "running" | "ok" | "fail";
  runId: string;
  attempts: number;
  startedAt: string;
  settledAt?: string;
  /** Why it failed, in a line. */
  failure?: string;
  /** Where its report was copied. */
  report?: string;
}

/** The state file, `<state>/<prApplyGroup>.json`. */
export interface CiServeState {
  schema: 1;
  forge: CiServeForgeKind;
  repo: string;
  env: string;
  branch: string;
  member?: string;
  /** The target branch's head the last apply was measured to, or the last head seen and not applied. */
  target?: string;
  /** The same for each further branch `ci.branches` routes (#4325), by branch. `target` is the first served branch's. */
  targets?: Record<string, string>;
  jobs: Record<string, CiServeJobState>;
  /** Plans seen and not run, by state key, with why (#4122). */
  skipped?: Record<string, "skip-ci">;
  /** The build requests served (#4169), by `build:<sha>`, with how each ended. */
  builds?: Record<string, { tag: string; status: "running" | "ok" | "fail"; startedAt: string; settledAt?: string }>;
  /** The land branch heads seen (#4168 4.4), by `land:<name>:<sha>`. */
  lands?: Record<string, CiServeLandState>;
}

/** What a pass did, in order, for the log. */
export type CiServeEvent =
  | { type: "baseline"; commit: string }
  | { type: "no-branch"; branch: string }
  | { type: "skipped"; pr: number; reason: "fork" | "author"; author?: string }
  | { type: "held"; job: CiJobName; commit: string; pr?: number; reason: "capacity" | "lease"; heldBy?: string }
  | { type: "started"; job: CiJobName; commit: string; pr?: number; base: string; runId: string; attempt: number; resume?: string }
  | { type: "settled"; job: CiJobName; commit: string; pr?: number; status: "ok" | "fail"; failure?: string; report?: string }
  | { type: "not-run"; job: CiJobName; commit: string; pr?: number; reason: "not-fast-forward" | "skip-ci"; branch?: string; from?: string }
  | { type: "ledger"; action: "deleted" | "reset"; local: string; forge?: string }
  | { type: "build"; commit: string; phases: string[]; status: "started" | "ok" | "fail" | "held"; exitCode?: number }
  /** A land branch (#4168 4.4): its pre-merge phases started, the target moved to it, or it was refused and left. */
  | { type: "land"; branch: string; commit: string; status: "started" | "landed" | "refused" | "held"; reason?: string; warning?: string }
  /** `ci tick` after the pass (#4168): the tags it made from the runs. */
  | { type: "tick"; made: string[] }
  | { type: "error"; message: string };

/** The `ciRun` request fields `ci serve` passes through to every job: the generator's options and the runner's. */
export type CiServeJobOptions = Omit<CiRunRequest, "cwd" | "job" | "env" | "forge" | "base" | "pr" | "commit" | "output" | "resumeRecord" | "runId">;

export interface CiServeOptions {
  /** The host's clone, or a workspace member's directory in it. */
  cwd: string;
  forge: CiServeForgeKind;
  /** `owner/name`. */
  repo: string;
  env: string;
  client: CiServeForge;
  /** Default `<git common dir>/chant/ci-serve`. */
  stateDir?: string;
  /** Default 1. */
  maxJobs?: number;
  /** Plan only pull requests these logins opened, without case. Default anyone with a branch in the repository. */
  authors?: readonly string[];
  /** Run again the failed apply at the target's head, and the failed plans of open heads. */
  rerunFailed?: boolean;
  /**
   * Apply each new target-branch commit (#4168), as `ci serve` did before
   * #4168. Default false: each new commit gets the record job, which applies
   * nothing.
   */
  applyOnMerge?: boolean;
  /**
   * Run after each pass that settled a job (#4168): `ci tick` from the runs
   * the jobs recorded. Returns the tags it made, or undefined when the
   * declaration has no `ci.green`. The command passes one; a test may not.
   */
  tick?: () => Promise<string[] | undefined>;
  /** Passed to each job. `job.hostEnv` gets `GITHUB_REPOSITORY` set to `repo`. */
  job?: CiServeJobOptions;
  /** This process's lease identity. Default `currentHolderId()`. */
  holder?: string;
  leaseTtlMs?: number;
  log?: (event: CiServeEvent) => void;
  now?: () => Date;
  /** Runs a job. Default {@link ciRun}. */
  run?: (req: CiRunRequest) => Promise<CiRunResult>;
  /**
   * The shell line that builds a requested commit (#4169), run in a fresh
   * worktree of it. Without it `ci/build/<sha>` tags are not served.
   */
  buildCommand?: string;
  /** Runs a build. Default: `sh -c <buildCommand>` in a detached worktree of the commit. */
  build?: (input: { top: string; request: CiServeBuildInput; command: string }) => Promise<number>;
  /**
   * Land `chant/land/<name>` branches (#4168 4.4): the `ci.green.preMerge`
   * phases each must pass first. Needs `buildCommand`, which runs them.
   */
  land?: { phases: string[] };
  /** Judges a land head's phases. Default {@link judgePreMerge} from the Op run records. */
  judgeLand?: (input: { commit: string; base: string }) => Promise<CommitVerdict>;
}

/** The jobs this process runs now, by state key, shared by every pass of one loop. */
export interface CiServeRuntime {
  /** Jobs and build requests (#4169) alike, by state key: they share `maxJobs`. */
  inflight: Map<string, Promise<unknown>>;
}

export const newCiServeRuntime = (): CiServeRuntime => ({ inflight: new Map() });

/** The state key of a job. */
export function ciServeKey(t: { job: CiJobName; commit: string; pr?: number }): string {
  return t.job === "plan" ? `plan:${t.pr}:${t.commit}` : `${t.job}:${t.commit}`;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return undefined;
  }
}

const LEDGER = "chant/lifecycle";
/** Where the forge's ledger tip is fetched to, a ref only this module writes. */
const FORGE_LEDGER = "refs/chant/ci-serve/forge-ledger";

/** `git` with its exit status, for the calls whose answer is the status. */
function gitStatus(cwd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } });
  return { code: r.status ?? -1, out: (r.stdout ?? "").trim() };
}

/**
 * Make the clone's `chant/lifecycle` follow the forge's (#4121). The clone's
 * branch outlives the forge's, so a ledger the forge deleted or rewrote would
 * make the next pr-apply find the two diverged and stall.
 *
 * - The forge has none: the local branch and its remote-tracking ref go.
 * - Neither contains the other: the local branch and its remote-tracking ref
 *   are reset to the forge's tip.
 * - The local branch is ahead of the forge's, or behind it, or the same: it
 *   is left, and an apply's push sends what it holds that the forge lacks.
 *
 * Nothing is pushed, so a rewritten ledger never goes back to the forge. A
 * forge that can't be reached leaves everything as it is; the job's own
 * fetch says why.
 */
export function reconcileCiServeLedger(top: string): CiServeEvent | undefined {
  const local = tryGit(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${LEDGER}^{commit}`]);
  const listed = gitStatus(top, ["ls-remote", "--exit-code", "origin", `refs/heads/${LEDGER}`]);
  if (listed.code === 2) {
    // A remote-tracking ref left from a deleted branch would be the next push's lease, and refuse it.
    tryGit(top, ["update-ref", "-d", `refs/remotes/origin/${LEDGER}`]);
    if (!local) return undefined;
    tryGit(top, ["update-ref", "-d", `refs/heads/${LEDGER}`, local]);
    return { type: "ledger", action: "deleted", local };
  }
  if (listed.code !== 0 || !local) return undefined;
  const forge = listed.out.split(/\s+/)[0];
  if (!forge || forge === local) return undefined;
  if (gitStatus(top, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${LEDGER}:${FORGE_LEDGER}`]).code !== 0) return undefined;
  try {
    const ahead = gitStatus(top, ["merge-base", "--is-ancestor", forge, local]).code === 0;
    const behind = gitStatus(top, ["merge-base", "--is-ancestor", local, forge]).code === 0;
    if (ahead || behind) return undefined;
    tryGit(top, ["update-ref", `refs/heads/${LEDGER}`, forge, local]);
    tryGit(top, ["update-ref", `refs/remotes/origin/${LEDGER}`, forge]);
    return { type: "ledger", action: "reset", local, forge };
  } finally {
    tryGit(top, ["update-ref", "-d", FORGE_LEDGER]);
  }
}

/** A commit message that asks for no CI run, as Actions and GitLab read it. */
const SKIP_CI = /\[(?:skip ci|ci skip)\]/i;

/** Whether `commit`'s message asks for no CI run. A commit this clone can't read is not skipped. */
function skipsCi(top: string, commit: string): boolean {
  const body = tryGit(top, ["log", "-1", "--format=%B", commit]);
  return body !== undefined && SKIP_CI.test(body);
}

/**
 * How the target branch moved from `from` to `head` (#4122): `fast-forward`
 * when `head` descends from `from`, `other` when it does not, and `unknown`
 * when `head` could not be fetched. Once `head` is here its history is too,
 * so a `from` this clone lacks is not in that history.
 */
function targetMove(top: string, branch: string, from: string, head: string): "fast-forward" | "other" | "unknown" {
  tryGit(top, ["fetch", "--quiet", "--no-tags", "origin", branch]);
  if (gitStatus(top, ["cat-file", "-e", `${head}^{commit}`]).code !== 0) return "unknown";
  return gitStatus(top, ["merge-base", "--is-ancestor", from, head]).code === 0 ? "fast-forward" : "other";
}

/** Where a serve keeps its state when `--state` names nowhere: beside the run events, in the repository's common git directory. */
export function defaultCiServeStateDir(cwd: string): string {
  const common = tryGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common) throw new CiRunError("ci serve runs in a clone of the repository it serves, and this directory is not in a git repository");
  return join(common, "chant", "ci-serve");
}

/** What a serve works out once, before its first pass. */
interface ServePlace {
  top: string;
  member?: string;
  /** The first branch served: the one the state file's `target` follows. */
  branch: string;
  /** Every branch served (#4325), `branch` first: a routed member's route, or at the workspace root the default and each routed branch. */
  branches: string[];
  /** The served branches a job is told with `--branch`: the ones `ci.branches` names. */
  routed: string[];
  group: string;
  stateDir: string;
  stateFile: string;
}

function servePlace(opts: CiServeOptions): ServePlace {
  const cwd = resolve(opts.cwd);
  const top = gitTop(cwd);
  if (!top) throw new CiRunError("ci serve runs in a clone of the repository it serves, and this directory is not in a git repository");
  const { member } = ciJobPlace(cwd, top);
  const group = prApplyGroup(opts.env, member);
  const stateDir = opts.stateDir ? resolve(cwd, opts.stateDir) : defaultCiServeStateDir(cwd);
  // #4325: ci.branches decides which branches this serve polls. A workspace that can't be read routes nothing.
  let routes: Record<string, string[]> | undefined;
  try {
    routes = readDeclaration(locateWorkspace(cwd).tree).ci?.branches;
  } catch {
    routes = undefined;
  }
  const named = opts.job?.loop?.branch;
  let served: ReturnType<typeof servedBranches>;
  try {
    served = servedBranches(routes, member, named ?? "main", named !== undefined);
  } catch (err) {
    throw new CiRunError(message(err));
  }
  return { top, ...(member ? { member } : {}), branch: served.served[0]!, branches: served.served, routed: served.routed, group, stateDir, stateFile: join(stateDir, `${group}.json`) };
}

/** The state file, or a new one. */
export function readCiServeState(file: string, fresh: Omit<CiServeState, "schema" | "jobs">): CiServeState {
  if (existsSync(file)) {
    const s = JSON.parse(readFileSync(file, "utf-8")) as CiServeState;
    if (s.schema !== 1 || typeof s.jobs !== "object" || s.jobs === null) throw new CiRunError(`${file} is not a ci serve state file this chant reads`);
    return s;
  }
  return { schema: 1, ...fresh, jobs: {} };
}

function writeState(file: string, state: CiServeState): void {
  mkdirSync(resolve(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

/** A job entry that can run again with `rerunFailed`: it failed, or it says `running` and no job of this process runs it. */
const failedEntry = (entry: CiServeJobState | undefined, key: string, rt: CiServeRuntime): entry is CiServeJobState =>
  !!entry && (entry.status === "fail" || (entry.status === "running" && !rt.inflight.has(key)));

/**
 * One poll of the forge, as triggers: an apply when the target's head moved
 * since the last apply by a fast-forward (none on the first poll, which only
 * notes the head, and none for a head whose message says `[skip ci]`),
 * then a plan for each open pull request head not yet planned, oldest pull
 * request first. A job already in the state file is left out unless it
 * failed and `rerunFailed` is set. The first poll's head, and a head seen
 * and not applied, are written to the state file.
 */
export async function ciServeObserve(opts: CiServeOptions, rt: CiServeRuntime = newCiServeRuntime()): Promise<{ triggers: CiServeTrigger[]; events: CiServeEvent[] }> {
  const place = servePlace(opts);
  const fresh = { forge: opts.forge, repo: opts.repo, env: opts.env, branch: place.branch, ...(place.member ? { member: place.member } : {}) };
  const state = readCiServeState(place.stateFile, fresh);
  // Read again at the write: a job of this serve may have settled while the forge answered.
  const update = (fn: (s: CiServeState) => void): void => {
    const s = readCiServeState(place.stateFile, fresh);
    fn(s);
    writeState(place.stateFile, s);
  };
  const triggers: CiServeTrigger[] = [];
  const events: CiServeEvent[] = [];
  // #4168: a new target commit is recorded. With applyOnMerge the newest green commit is applied, below.
  const onMerge = "record" as const;
  const authors = opts.authors?.length ? new Set(opts.authors.map((a) => a.toLowerCase())) : undefined;

  // #4325: each served branch is polled on its own, with its own head to measure moves from.
  for (const branch of place.branches) {
    const [head, prs] = await Promise.all([opts.client.branchHead(branch), opts.client.openPullRequests(branch)]);
    const first = branch === place.branch;
    const target = first ? state.target : state.targets?.[branch];
    const setTarget = (s: CiServeState, sha: string): void => {
      if (first) s.target = sha;
      else s.targets = { ...s.targets, [branch]: sha };
    };
    // A job on a routed branch is told which, so its apply routes members as the pushed branch does.
    const routed = place.routed.includes(branch) ? { branch } : {};

    if (head === undefined) {
      events.push({ type: "no-branch", branch });
    } else if (target === undefined) {
      // What the branch held before this runner watched it was applied by whatever ran then.
      update((s) => setTarget(s, head));
      events.push({ type: "baseline", commit: head });
    } else if (head !== target) {
      const from = target;
      const move = targetMove(place.top, branch, from, head);
      const entry = state.jobs[ciServeKey({ job: onMerge, commit: head })];
      if (move === "unknown") {
        events.push({ type: "error", message: `${branch} is at ${head.slice(0, 12)} on the forge, and that commit could not be fetched; the next poll tries again` });
      } else if (move === "other" || (!entry && skipsCi(place.top, head))) {
        // #4122: a move that is not a fast-forward, or a head that asks for no run, is seen and not applied.
        update((s) => setTarget(s, head));
        events.push({ type: "not-run", job: onMerge, commit: head, reason: move === "other" ? "not-fast-forward" : "skip-ci", ...(move === "other" ? { branch, from } : {}) });
      } else if (!entry) triggers.push({ job: onMerge, commit: head, base: from, ...routed });
      else if (opts.rerunFailed && failedEntry(entry, ciServeKey(entry), rt)) triggers.push({ job: onMerge, commit: head, base: entry.base, rerun: true, ...routed });
    } else {
      const key = ciServeKey({ job: onMerge, commit: head });
      const entry = state.jobs[key];
      if (opts.rerunFailed && failedEntry(entry, key, rt)) triggers.push({ job: onMerge, commit: head, base: entry.base, rerun: true, ...routed });
    }

    if (opts.applyOnMerge && head !== undefined) {
      const green = newestGreen(place.top, opts.cwd, branch, place.routed.includes(branch));
      if (green) {
        const key = ciServeKey({ job: "apply", commit: green });
        const entry = state.jobs[key];
        if (!entry) triggers.push({ job: "apply", commit: green, base: green, ...routed });
        else if (opts.rerunFailed && failedEntry(entry, key, rt)) triggers.push({ job: "apply", commit: green, base: entry.base, rerun: true, ...routed });
      }
    }

    for (const pr of prs) {
      if (pr.fork) {
        events.push({ type: "skipped", pr: pr.number, reason: "fork" });
        continue;
      }
      if (authors && !authors.has((pr.author ?? "").toLowerCase())) {
        events.push({ type: "skipped", pr: pr.number, reason: "author", ...(pr.author ? { author: pr.author } : {}) });
        continue;
      }
      const key = ciServeKey({ job: "plan", commit: pr.headSha, pr: pr.number });
      const entry = state.jobs[key];
      const base = pr.baseSha ?? head;
      if (!base || state.skipped?.[key]) continue;
      if (!entry) {
        // #4122: a head whose message asks for no run is seen and not planned.
        if (gitStatus(place.top, ["cat-file", "-e", `${pr.headSha}^{commit}`]).code !== 0) tryGit(place.top, ["fetch", "--quiet", "--no-tags", "origin", `refs/pull/${pr.number}/head`]);
        if (skipsCi(place.top, pr.headSha)) {
          update((s) => {
            s.skipped = { ...s.skipped, [key]: "skip-ci" };
          });
          events.push({ type: "not-run", job: "plan", commit: pr.headSha, pr: pr.number, reason: "skip-ci" });
        } else triggers.push({ job: "plan", commit: pr.headSha, base, pr: pr.number, ...routed });
      }
      else if (opts.rerunFailed && failedEntry(entry, key, rt)) triggers.push({ job: "plan", commit: pr.headSha, base: entry.base, pr: pr.number, rerun: true, ...routed });
    }
  }
  return { triggers, events };
}

/** What {@link ciServeSchedule} did with the triggers. */
export interface CiServeScheduled {
  /** Each job started, settling to its state entry. */
  started: Promise<CiServeJobState>[];
  events: CiServeEvent[];
}

/**
 * Start the triggers' jobs, at most `maxJobs` at once with the jobs this
 * process already runs. An apply first takes its group's lease. A trigger
 * that can't start (over capacity, lease held, or already running here) is
 * reported and not recorded, so the next poll finds it again.
 */
export async function ciServeSchedule(opts: CiServeOptions, triggers: readonly CiServeTrigger[], rt: CiServeRuntime = newCiServeRuntime()): Promise<CiServeScheduled> {
  const place = servePlace(opts);
  const max = opts.maxJobs ?? 1;
  const holder = opts.holder ?? currentHolderId();
  const ttlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const events: CiServeEvent[] = [];
  const emit = (e: CiServeEvent): void => {
    events.push(e);
    log(e);
  };
  const started: Promise<CiServeJobState>[] = [];
  const fresh = { forge: opts.forge, repo: opts.repo, env: opts.env, branch: place.branch, ...(place.member ? { member: place.member } : {}) };
  const update = (fn: (s: CiServeState) => void): void => {
    const s = readCiServeState(place.stateFile, fresh);
    fn(s);
    writeState(place.stateFile, s);
  };

  for (const t of triggers) {
    const key = ciServeKey(t);
    const pr = t.job === "plan" ? { pr: t.pr } : {};
    if (rt.inflight.has(key)) continue;
    if (rt.inflight.size >= max) {
      emit({ type: "held", job: t.job, commit: t.commit, ...pr, reason: "capacity" });
      continue;
    }
    let lease: LeaseRecord | undefined;
    if (t.job === "apply") {
      let got: Awaited<ReturnType<typeof acquireLease>>;
      try {
        got = await acquireLease(place.group, holder, { cwd: opts.cwd, ttlMs, mode: "claim", requirePush: true, now });
      } catch (err) {
        emit({ type: "error", message: `the ${place.group} lease could not be taken: ${message(err)}` });
        continue;
      }
      if (!got.acquired || !got.lease) {
        emit({ type: "held", job: "apply", commit: t.commit, reason: "lease", ...(got.heldBy ? { heldBy: got.heldBy.holder } : {}) });
        continue;
      }
      lease = got.lease;
    }

    // #4121: with no other job of this serve writing it, the clone's ledger follows the forge's.
    if (rt.inflight.size === 0) {
      const ledger = reconcileCiServeLedger(place.top);
      if (ledger) emit(ledger);
    }

    const previous = readCiServeState(place.stateFile, fresh).jobs[key];
    const attempt = (previous?.attempts ?? 0) + 1;
    const runId = `chant-serve-${now().getTime()}-${t.job}-${t.commit.slice(0, 8)}`;
    const resume = t.job === "apply" ? join(place.stateDir, "resume", `${prApplyRecordKey(opts.env, t.commit, place.member)}.json`) : undefined;
    const report = join(place.stateDir, "reports", place.group, `${CI_JOB_OPS[t.job]}${t.job === "plan" ? `-${t.pr}` : ""}-${t.commit.slice(0, 12)}`);
    const entry: CiServeJobState = { job: t.job, commit: t.commit, base: t.base, ...pr, status: "running", runId, attempts: attempt, startedAt: now().toISOString() };
    update((s) => {
      s.jobs[key] = entry;
      if (t.job === "record" && !t.rerun) {
        if (t.branch === undefined || t.branch === place.branch) s.target = t.commit;
        else s.targets = { ...s.targets, [t.branch]: t.commit };
      }
    });
    emit({ type: "started", job: t.job, commit: t.commit, ...pr, base: t.base, runId, attempt, ...(resume && existsSync(resume) ? { resume } : {}) });

    const job = runJob(opts, place, t, { runId, report, ...(resume ? { resume } : {}) }, lease ? { lease, holder, ttlMs, now } : undefined).then((done) => {
      rt.inflight.delete(key);
      const settled: CiServeJobState = { ...entry, ...done, settledAt: now().toISOString() };
      try {
        update((s) => {
          s.jobs[key] = settled;
        });
      } catch (err) {
        emit({ type: "error", message: `${key} settled, and the state file could not be written: ${message(err)}` });
      }
      emit({ type: "settled", job: t.job, commit: t.commit, ...pr, status: settled.status === "ok" ? "ok" : "fail", ...(settled.failure ? { failure: settled.failure } : {}), ...(settled.report ? { report: settled.report } : {}) });
      return serveTick(opts).then(() => settled);
    });
    rt.inflight.set(key, job);
    started.push(job);
  }
  return { started, events };
}

/** Run one job: fetch its commit, run it with `ciRun`, keep the lease renewed while it runs, and release it after. Never throws. */
async function runJob(
  opts: CiServeOptions,
  place: ServePlace,
  t: CiServeTrigger,
  paths: { runId: string; report: string; resume?: string },
  held: { lease: LeaseRecord; holder: string; ttlMs: number; now: () => Date } | undefined,
): Promise<Pick<CiServeJobState, "status" | "failure" | "report" | "pr">> {
  const renew = held
    ? setInterval(() => {
        void acquireLease(place.group, held.holder, { cwd: opts.cwd, ttlMs: held.ttlMs, mode: "renew", token: held.lease.token, now: held.now }).catch(() => undefined);
      }, Math.max(1000, Math.floor(held.ttlMs / 3)))
    : undefined;
  renew?.unref?.();
  let merged: number | undefined;
  try {
    // The pull request's head is on the forge's refs/pull/<n>/head, the target's on the branch.
    tryGit(place.top, ["fetch", "--quiet", "--no-tags", "origin", t.job === "plan" ? `refs/pull/${t.pr}/head` : (t.branch ?? place.branch)]);
    const hostEnv = { ...(opts.job?.hostEnv ?? process.env), GITHUB_REPOSITORY: opts.repo };
    // An apply is for a merge: pass the pull request whose merge commit it is, so the commit status link and the run index use `<pr>/<commit>`. None found, or a forge that errs, is today's behaviour.
    if (t.job === "record" && opts.client.pullRequestFor) merged = (await opts.client.pullRequestFor(t.commit).catch(() => null)) ?? undefined;
    const run = opts.run ?? ciRun;
    const r = await run({
      ...opts.job,
      // #4325: a job on a routed branch is told the branch, so it routes members as a push to it does.
      ...(t.branch !== undefined ? { loop: { ...opts.job?.loop, branch: t.branch } } : {}),
      hostEnv,
      cwd: opts.cwd,
      job: t.job,
      env: opts.env,
      // #4016 gap 6: a plain git server has no API, so the job runs without --forge, shaped as a GitHub job.
      ...(opts.forge === "git" ? { forge: "github" as const, noForge: true } : { forge: opts.forge }),
      base: t.base,
      ...(t.job === "plan" ? { pr: t.pr } : merged !== undefined ? { pr: merged } : {}),
      commit: t.commit,
      output: paths.report,
      runId: paths.runId,
      ...(paths.resume ? { resumeRecord: paths.resume } : {}),
    });
    const why = r.record.failure ? `${r.record.failure.code}: ${r.record.failure.reason}` : r.failure ? `${r.failure.phase}: ${r.failure.error.split("\n")[0]}` : undefined;
    return { status: r.status === "ok" ? "ok" : "fail", ...(merged !== undefined ? { pr: merged } : {}), ...(why && r.status !== "ok" ? { failure: why } : {}), ...(r.report ? { report: r.report } : {}) };
  } catch (err) {
    return { status: "fail", ...(merged !== undefined ? { pr: merged } : {}), failure: message(err) };
  } finally {
    if (renew) clearInterval(renew);
    if (held) await releaseLease(place.group, held.holder, held.lease.token, { cwd: opts.cwd }).catch(() => false);
  }
}

/**
 * The newest green commit of the target branch (#4168 step 9), after
 * fetching the ci tags, or undefined when none is green or the workspace
 * declares no `ci.green`.
 */
function newestGreen(top: string, cwd: string, branch: string, routed = false): string | undefined {
  tryGit(top, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`, "+refs/tags/ci/*:refs/tags/ci/*"]);
  try {
    // #4325: a routed branch has its own verdict, and none when ci.green does not name it.
    const doc = lastGreen({ cwd, ...(routed ? { branch } : {}) });
    return "commit" in doc && doc.commit ? doc.commit.sha : undefined;
  } catch {
    return undefined;
  }
}

/** One pass: observe, schedule, serve build requests, and with `wait` wait for the jobs it started. */
export async function ciServePass(opts: CiServeOptions, rt: CiServeRuntime = newCiServeRuntime(), wait = true): Promise<{ events: CiServeEvent[]; jobs: CiServeJobState[] }> {
  const observed = await ciServeObserve(opts, rt);
  for (const e of observed.events) opts.log?.(e);
  const scheduled = await ciServeSchedule(opts, observed.triggers, rt);
  const builds = opts.buildCommand ? ciServeBuilds(opts, rt) : { started: [], events: [] };
  const lands = opts.land && opts.buildCommand ? await ciServeLands(opts, rt) : { started: [], events: [] };
  const jobs = wait ? await Promise.all(scheduled.started) : [];
  if (wait) await Promise.all([...builds.started, ...lands.started]);
  return { events: [...observed.events, ...scheduled.events, ...builds.events, ...lands.events], jobs };
}

/**
 * Serve the build requests (#4169): fetch the `ci/build/*` tags, and start
 * `buildCommand` for each one not in the state file yet, oldest first, while
 * fewer than `maxJobs` jobs run. A build that fails is recorded and not run
 * again; the tick decides what its phases say.
 */
export function ciServeBuilds(opts: CiServeOptions, rt: CiServeRuntime): { started: Promise<void>[]; events: CiServeEvent[] } {
  const place = servePlace(opts);
  const fresh = { forge: opts.forge, repo: opts.repo, env: opts.env, branch: place.branch, ...(place.member ? { member: place.member } : {}) };
  const update = (fn: (s: CiServeState) => void): void => {
    const st = readCiServeState(place.stateFile, fresh);
    fn(st);
    writeState(place.stateFile, st);
  };
  const events: CiServeEvent[] = [];
  const started: Promise<void>[] = [];
  tryGit(place.top, ["fetch", "--quiet", "--prune", "origin", `+refs/tags/${CI_BUILD_TAG_PREFIX}*:refs/tags/${CI_BUILD_TAG_PREFIX}*`]);
  const served = readCiServeState(place.stateFile, fresh).builds ?? {};
  const max = opts.maxJobs ?? 1;
  const now = opts.now ?? (() => new Date());
  const requests = [...readBuildRequests(place.top).values()].sort((a, b) => a.at.localeCompare(b.at));
  for (const request of requests) {
    const key = `build:${request.commit}`;
    if (served[key]?.tag === request.tag || rt.inflight.has(key)) continue;
    const log = (e: CiServeEvent) => {
      events.push(e);
      opts.log?.(e);
    };
    if (rt.inflight.size >= max) {
      log({ type: "build", commit: request.commit, phases: request.phases, status: "held" });
      continue;
    }
    update((st) => {
      st.builds = { ...st.builds, [key]: { tag: request.tag, status: "running", startedAt: now().toISOString() } };
    });
    log({ type: "build", commit: request.commit, phases: request.phases, status: "started" });
    const build = opts.build ?? runBuild;
    const job = build({ top: place.top, request, command: opts.buildCommand! })
      .catch(() => 1)
      .then((code) => {
        update((st) => {
          st.builds = { ...st.builds, [key]: { tag: request.tag, status: code === 0 ? "ok" : "fail", startedAt: st.builds?.[key]?.startedAt ?? now().toISOString(), settledAt: now().toISOString() } };
        });
        opts.log?.({ type: "build", commit: request.commit, phases: request.phases, status: code === 0 ? "ok" : "fail", exitCode: code });
      });
    const tracked = job.finally(() => rt.inflight.delete(key));
    rt.inflight.set(key, tracked);
    started.push(tracked);
  }
  return { started, events };
}

/** The land branches on `origin`, by name, with their heads (#4168 4.4). */
function landBranches(top: string): { name: string; head: string }[] {
  const r = gitStatus(top, ["ls-remote", "origin", `refs/heads/${LAND_BRANCH_PREFIX}*`]);
  if (r.code !== 0) return [];
  return r.out
    .split("\n")
    .map((line) => line.split(/\s+/))
    .filter(([sha, ref]) => sha && ref?.startsWith(`refs/heads/${LAND_BRANCH_PREFIX}`))
    .map(([head, ref]) => ({ name: ref!.slice(`refs/heads/${LAND_BRANCH_PREFIX}`.length), head: head! }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Why a land's phases don't let it land, or undefined when every one passed. */
function landRefusal(verdict: CommitVerdict): string | undefined {
  if (verdict.verdict === "pass") return undefined;
  const failed = verdict.phases.filter((p) => p.verdict === "fail").map((p) => p.phase);
  if (failed.length > 0) return `the pre-merge phase${failed.length > 1 ? "s" : ""} ${failed.join(", ")} failed`;
  const open = verdict.phases.filter((p) => p.verdict !== "pass").map((p) => p.phase);
  return `the build recorded no finished run for ${open.join(", ")}`;
}

/**
 * Serve the land branches (#4168 4.4): for each `chant/land/<name>` head not
 * in the state file, refuse it unless it descends from the target's head,
 * else run `buildCommand` on it with the pre-merge phases, judge them, and
 * when they pass push the target to it and delete the branch. At most
 * `maxJobs` builds and jobs run at once.
 */
export async function ciServeLands(opts: CiServeOptions, rt: CiServeRuntime): Promise<{ started: Promise<void>[]; events: CiServeEvent[] }> {
  const place = servePlace(opts);
  const fresh = { forge: opts.forge, repo: opts.repo, env: opts.env, branch: place.branch, ...(place.member ? { member: place.member } : {}) };
  const update = (fn: (s: CiServeState) => void): void => {
    const st = readCiServeState(place.stateFile, fresh);
    fn(st);
    writeState(place.stateFile, st);
  };
  const events: CiServeEvent[] = [];
  const started: Promise<void>[] = [];
  const now = opts.now ?? (() => new Date());
  const log = (e: CiServeEvent): void => {
    events.push(e);
    opts.log?.(e);
  };
  const phases = opts.land!.phases;
  const seen = readCiServeState(place.stateFile, fresh).lands ?? {};
  for (const { name, head } of landBranches(place.top)) {
    const key = `land:${name}:${head}`;
    const branch = `${LAND_BRANCH_PREFIX}${name}`;
    if (seen[key] || rt.inflight.has(key)) continue;
    if (rt.inflight.size >= (opts.maxJobs ?? 1)) {
      log({ type: "land", branch, commit: head, status: "held", reason: "--max-jobs jobs run" });
      continue;
    }
    const settle = (status: "landed" | "refused", reason?: string, warning?: string): void => {
      update((st) => {
        st.lands = { ...st.lands, [key]: { branch, commit: head, status, ...(reason ? { reason } : {}), startedAt: st.lands?.[key]?.startedAt ?? now().toISOString(), settledAt: now().toISOString() } };
      });
      log({ type: "land", branch, commit: head, status, ...(reason ? { reason } : {}), ...(warning ? { warning } : {}) });
    };
    const target = await opts.client.branchHead(place.branch);
    if (target === undefined) {
      log({ type: "error", message: `${branch} waits: the remote has no branch ${place.branch} to land it on` });
      continue;
    }
    tryGit(place.top, ["fetch", "--quiet", "--no-tags", "origin", place.branch, `+refs/heads/${branch}:refs/chant/ci-serve/land/${name}`]);
    // #4168 4.4: a land only ever fast-forwards the target, so its head must descend from the target's.
    if (gitStatus(place.top, ["merge-base", "--is-ancestor", target, head]).code !== 0) {
      settle("refused", `${head.slice(0, 12)} does not descend from ${place.branch} at ${target.slice(0, 12)}; rebase ${branch} onto it and push again`);
      continue;
    }
    update((st) => {
      st.lands = { ...st.lands, [key]: { branch, commit: head, status: "running", startedAt: now().toISOString() } };
    });
    log({ type: "land", branch, commit: head, status: "started" });
    const build = opts.build ?? runBuild;
    const judge = opts.judgeLand ?? ((input: { commit: string; base: string }) => judgePreMerge({ cwd: opts.cwd, ...input }));
    const job = (async () => {
      const code = await build({ top: place.top, request: { commit: head, phases, reason: "land" }, command: opts.buildCommand! }).catch(() => 1);
      if (code !== 0) return settle("refused", `the build of ${phases.join(", ")} exited ${code}`);
      let refusal: string | undefined;
      try {
        refusal = landRefusal(await judge({ commit: head, base: target }));
      } catch (err) {
        refusal = `the pre-merge phases could not be judged: ${message(err)}`;
      }
      if (refusal) return settle("refused", refusal);
      // A plain push: the remote refuses it unless it fast-forwards the target, so a target that moved meanwhile refuses the land.
      const pushed = spawnSync("git", ["push", "--quiet", "origin", `${head}:refs/heads/${place.branch}`], { cwd: place.top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      if (pushed.status !== 0) return settle("refused", `the push to ${place.branch} was refused: ${(pushed.stderr ?? "").trim().split("\n").pop() ?? ""}`);
      const deleted = gitStatus(place.top, ["push", "--quiet", "origin", "--delete", `refs/heads/${branch}`]);
      tryGit(place.top, ["update-ref", "-d", `refs/chant/ci-serve/land/${name}`]);
      settle("landed", undefined, deleted.code === 0 ? undefined : `${branch} could not be deleted on the remote; delete it by hand`);
    })().finally(() => rt.inflight.delete(key));
    rt.inflight.set(key, job);
    started.push(job);
  }
  return { started, events };
}

/** `sh -c <command>` in a fresh detached worktree of the request's commit, removed after. Resolves to the exit code. */
async function runBuild(input: { top: string; request: CiServeBuildInput; command: string }): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "chant-ci-build-"));
  try {
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", dir, input.request.commit], { cwd: input.top, stdio: ["ignore", "pipe", "pipe"] });
    return await new Promise<number>((done) => {
      const child = spawn("sh", ["-c", input.command], {
        cwd: dir,
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, CHANT_BUILD_COMMIT: input.request.commit, CHANT_BUILD_PHASES: input.request.phases.join(","), CHANT_BUILD_REASON: input.request.reason },
      });
      child.on("error", () => done(127));
      child.on("close", (code) => done(code ?? 1));
    });
  } finally {
    tryGit(input.top, ["worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `ci tick` after a job settled (#4168), logged; a tick that fails is an error event and never fails the job. */
async function serveTick(opts: CiServeOptions): Promise<CiServeEvent | undefined> {
  if (!opts.tick) return undefined;
  let event: CiServeEvent | undefined;
  try {
    const made = await opts.tick();
    event = made === undefined ? undefined : { type: "tick", made };
  } catch (err) {
    event = { type: "error", message: `ci tick after a job settled: ${message(err)}` };
  }
  if (event) opts.log?.(event);
  return event;
}

/**
 * The loop: a pass every `intervalMs` until `signal` aborts, jobs running
 * across passes up to `maxJobs`. A pass the forge fails is logged and the
 * loop goes on. On abort it waits for the jobs that run.
 */
export async function ciServeLoop(opts: CiServeOptions & { intervalMs: number; signal?: AbortSignal }): Promise<void> {
  const rt = newCiServeRuntime();
  while (!opts.signal?.aborted) {
    try {
      await ciServePass(opts, rt, false);
    } catch (err) {
      opts.log?.({ type: "error", message: message(err) });
    }
    await new Promise<void>((done) => {
      const timer = setTimeout(done, opts.intervalMs);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        done();
      }, { once: true });
    });
  }
  await Promise.allSettled([...rt.inflight.values()]);
}

/** One line for an event, as `ci serve` prints it. */
export function formatCiServeEvent(e: CiServeEvent): string {
  const at = (job: CiJobName, commit: string, pr?: number): string => `${CI_JOB_OPS[job]} ${commit.slice(0, 12)}${pr !== undefined ? ` (pull request ${pr})` : ""}`;
  switch (e.type) {
    case "baseline":
      return `target at ${e.commit.slice(0, 12)}; the next commit there is applied`;
    case "no-branch":
      return `the forge has no branch ${e.branch}`;
    case "skipped":
      return e.reason === "fork" ? `pull request ${e.pr} is from a fork, and host mode plans none` : `pull request ${e.pr} is by ${e.author ?? "an unknown author"}, who is not an --author`;
    case "held":
      return `${at(e.job, e.commit, e.pr)} waits: ${e.reason === "capacity" ? "--max-jobs jobs run" : `the apply lease is held${e.heldBy ? ` by ${e.heldBy}` : ""}`}`;
    case "started":
      return `${at(e.job, e.commit, e.pr)} started, run ${e.runId}, attempt ${e.attempt}${e.resume ? ", resuming" : ""}`;
    case "settled":
      return `${at(e.job, e.commit, e.pr)} ${e.status === "ok" ? "passed" : `failed${e.failure ? `: ${e.failure}` : ""}`}${e.report ? `; report ${e.report}` : ""}`;
    case "not-run":
      return e.reason === "skip-ci"
        ? `${at(e.job, e.commit, e.pr)} is not run: its commit message says [skip ci]`
        : `${e.branch ?? "the target branch"} moved from ${e.from?.slice(0, 12) ?? "a commit"} to ${e.commit.slice(0, 12)}, which is not a fast-forward, so ${e.commit.slice(0, 12)} is recorded as seen and not applied`;
    case "ledger":
      return e.action === "deleted"
        ? `the forge has no ${LEDGER}, so this clone's, at ${e.local.slice(0, 12)}, was deleted`
        : `the forge's ${LEDGER} at ${e.forge!.slice(0, 12)} does not contain this clone's at ${e.local.slice(0, 12)}, so this clone's was reset to the forge's and not pushed`;
    case "build": {
      const what = `the build of ${e.phases.join(", ")} at ${e.commit.slice(0, 12)}`;
      if (e.status === "held") return `${what} waits: --max-jobs jobs run`;
      return e.status === "started" ? `${what} started` : e.status === "ok" ? `${what} passed` : `${what} failed${e.exitCode !== undefined ? ` with exit code ${e.exitCode}` : ""}`;
    }
    case "land": {
      const what = `${e.branch} at ${e.commit.slice(0, 12)}`;
      if (e.status === "started") return `${what}: the pre-merge phases started`;
      if (e.status === "held") return `${what} waits: ${e.reason ?? "--max-jobs jobs run"}`;
      if (e.status === "refused") return `${what} was refused and left on the remote: ${e.reason ?? "no reason given"}`;
      return `${what} landed${e.warning ? `; ${e.warning}` : ", and the land branch was deleted"}`;
    }
    case "tick":
      return e.made.length > 0 ? `ci tick made ${e.made.join(", ")}` : "ci tick: no tag due";
    case "error":
      return `error: ${e.message}`;
  }
}

// ── The command ──────────────────────────────────────────────────────────────

/**
 * `chant ci serve|run --setup-key [--trust [--principal <name>]] [--state <dir>] [--branch <name>]` (#4099):
 * make the host's runner key when there is none, print its public half on
 * stdout, and say whether the target's head lists it. With --trust, commit
 * the runner entry on a branch of its own and push it for review.
 */
export function runnerKeySetupCommand(ctx: CommandContext): number {
  const { args } = ctx;
  const cwd = process.cwd();
  const top = gitTop(cwd);
  if (!top) throw new CiRunError("the runner key is kept in the repository's git directory, and this directory is not in a git repository");
  if (args.ciPrincipal !== undefined && !args.trustKey) throw new CiRunError("--principal names who --trust lists the key for; give --trust with it");
  const branch = args.branch ?? "main";
  const setup = setupRunnerKey({
    top,
    stateDir: args.statePath ? resolve(args.statePath) : defaultCiServeStateDir(cwd),
    branch,
    ...(args.ciPrincipal ? { principal: args.ciPrincipal } : {}),
    ...(args.trustKey ? { trust: true } : {}),
    ...(args.by ? { by: args.by } : {}),
  });
  console.log(setup.key.publicKey);
  console.error(formatRunnerKeySetup(setup, branch));
  return 0;
}

const USAGE =
  "chant ci serve --setup-key [--trust [--principal <name>]] [--state <dir>] [--branch <name>] | " +
  "chant ci serve --forge forgejo|github|git --repo <owner/repo> --env <env> [--interval <s>] [--max-jobs <n>] [--state <dir>] " +
  "[--author <login>]... [--once] [--rerun-failed] [--build-command <line>] [--land] [--gate <name>] [--wave-gate <name>] [--branch <name>] [--events-json] [--report-url <url>] [--no-status] [--status-url <url template>] " +
  "[--image <image>] [--before-script <line>]... [--pr-build] [--pr-build-command <line>] [--chant <command>] [--pass-env <NAME>]... [--secrets <file>] [--key <runner key.pem>] [--unsigned]";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `--interval`: seconds, or a duration such as `30s` or `2m`. Default 30 seconds. */
export function ciServeInterval(value: string | undefined): number {
  if (value === undefined) return 30_000;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : parseDuration(value);
  if (!(ms >= 1000)) throw new CiRunError(`--interval takes seconds or a duration of a second or more, not ${JSON.stringify(value)}`);
  return ms;
}

/** `ci.green.preMerge` where `cwd` is, for `--land` (#4168 4.4). Throws when the declaration names none. */
function preMergeOf(cwd: string): string[] {
  let pre: string[] | undefined;
  try {
    pre = readDeclaration(locateWorkspace(cwd).tree).ci?.green?.preMerge;
  } catch (err) {
    throw new CiRunError(`--land reads ci.green.preMerge from the workspace declaration, which could not be read: ${message(err)}`);
  }
  if (!pre || pre.length === 0) throw new CiRunError("--land runs the ci.green.preMerge phases on each land branch, and the declaration names none; add them to ci.green");
  return pre;
}

/** `chant ci serve` (#4095). */
export async function runCiServe(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  try {
    if (args.setupKey) return runnerKeySetupCommand(ctx);
    const forge = args.forge;
    if (forge !== "forgejo" && forge !== "github" && forge !== "git") throw new CiRunError(`--forge names the forge ci serve polls: --forge forgejo|github|git${forge ? `, not ${JSON.stringify(forge)}` : ""}`);
    // #4016 gap 6: a plain git server has no repository name to ask an API for, so --repo only labels the state file.
    if (!args.ciRepo && forge !== "git") throw new CiRunError("--repo names the repository whose pull requests ci serve polls: --repo <owner/repo>");
    // #4168 4.4: landing runs the pre-merge phases through the build command.
    if (args.ciLand && !args.ciBuildCommand) throw new CiRunError("--land runs each land branch's pre-merge phases with --build-command, so it needs one: --build-command '<line>'");
    if (!args.env) throw new CiRunError("--env names the environment the pipeline is for: --env <env>");
    for (const name of args.passEnv ?? []) if (!ENV_NAME.test(name)) throw new CiRunError(`--pass-env takes a variable's name, not ${JSON.stringify(name)}`);
    // #4168: a gate per wave gates the apply on merge, which a merge runs only when opted in.
    if (args.waveGate && !args.applyOnMerge) throw new CiRunError("--wave-gate gates the apply on merge, so it needs --apply-on-merge (#4168); without it a merge gets the record job, which applies nothing");
    const intervalMs = ciServeInterval(args.interval);
    const cwd = process.cwd();
    const top = gitTop(cwd);
    if (!top) throw new CiRunError("ci serve runs in a clone of the repository it serves, and this directory is not in a git repository");
    const stateDir = args.statePath ? resolve(args.statePath) : defaultCiServeStateDir(cwd);
    const branch = args.branch ?? "main";
    const repo = args.ciRepo ?? (tryGit(top, ["remote", "get-url", "origin"]) || "origin");
    const landPhases = args.ciLand ? preMergeOf(cwd) : undefined;
    // #4099: the host's key, checked against .chant/trust.json at the target's head before the first poll.
    // #4156: signing is opt-in. Without ci.green.signedSince no key is quiet, and an untrusted one warns once and serves unsigned.
    const keyed = ciServeRunnerKey({
      top,
      stateDir,
      branch,
      ...(args.key !== undefined ? { keyFile: resolve(args.key) } : {}),
      envKey: process.env[RUNNER_KEY_ENV] || undefined,
      unsigned: args.unsigned,
      required: signedRunsRequired(cwd),
    });
    const fromFlag = keyed.fromFlag;
    const runnerKey = keyed.pem;
    if (keyed.warning) console.error(formatWarning({ message: keyed.warning }));
    if (runnerKey !== undefined) console.error(`ci serve: signing runs with the runner key from ${keyed.source}`);
    else if (keyed.note && args.verbose) console.error(`ci serve: ${keyed.note}`);
    // #4096: read once, so a loose or broken secrets file stops the serve before its first poll.
    const secrets = ciSecretsOf(args.ciSecrets);
    // #4160: without --report-url, the declaration's ci.reportUrl.
    const reportUrl = await reportUrlOf(args.reportUrl, cwd);
    if (reportUrl && !args.reportUrl) console.error(`ci serve: reports and the run index go to ${reportUrl}, the declaration's ci.reportUrl`);
    const hostEnv = { ...process.env, GITHUB_REPOSITORY: repo };
    let client: CiServeForge;
    let status: ReturnType<typeof ciStatusFromEnv>["status"];
    if (forge === "git") {
      // #4016 gap 6: refs only, and no commit status to set.
      client = gitCiServeForge(top);
      if (!args.noStatus) console.error(formatWarning({ message: "the git forge kind has no API, so no commit status is set; each job's result is in the state file and its report" }));
    } else {
      const api = forgeFromEnv(forge, hostEnv);
      const fromEnv = ciStatusFromEnv({ forge, hostEnv, noStatus: args.noStatus, statusUrl: args.statusUrl });
      if (fromEnv.warning) console.error(formatWarning({ message: fromEnv.warning }));
      status = fromEnv.status;
      if (!api.openPullRequests || !api.branchHead) throw new CiRunError(`the ${forge} client cannot list pull requests`);
      client = { openPullRequests: api.openPullRequests.bind(api), branchHead: api.branchHead.bind(api), pullRequestFor: api.pullRequestFor.bind(api) };
    }
    // #4168: a host that applied each merge before the upgrade hears that it no longer does.
    if (!args.applyOnMerge) console.error("ci serve: each new commit on the target branch gets the record job, which applies nothing (#4168); --apply-on-merge also applies each newest green commit");
    const opts: CiServeOptions = {
      cwd,
      forge,
      repo,
      env: args.env,
      client,
      stateDir,
      ...(args.maxJobs ? { maxJobs: args.maxJobs } : {}),
      ...(args.ciAuthors?.length ? { authors: args.ciAuthors } : {}),
      ...(args.rerunFailed ? { rerunFailed: true } : {}),
      ...(args.ciBuildCommand ? { buildCommand: args.ciBuildCommand } : {}),
      ...(args.applyOnMerge ? { applyOnMerge: true } : {}),
      ...(landPhases ? { land: { phases: landPhases } } : {}),
      // #4168: the tick from the runs the jobs recorded, signed with the runs' key. No ci.green, no tick.
      tick: async () => {
        try {
          return (await ciTick({ cwd, source: "runs", ...(runnerKey !== undefined ? { runnerKey } : {}) })).made;
        } catch (err) {
          if (err instanceof CiGreenError && err.code === "ci-green-undeclared") return undefined;
          throw err;
        }
      },
      job: {
        loop: ciLoopOptions(reportUrl ? { ...args, reportUrl } : args),
        ...(args.runIndexLimit ? { runIndexLimit: args.runIndexLimit } : {}),
        ...(args.image ? { image: args.image } : {}),
        ...(args.beforeScript?.length ? { beforeScript: args.beforeScript } : {}),
        ...(args.ciChant ? { chant: args.ciChant } : {}),
        ...(args.passEnv?.length ? { passEnv: args.passEnv } : {}),
        ...(status ? { status } : {}),
        ...(secrets ? { secrets } : {}),
        ...(runnerKey !== undefined ? { runnerKey, runnerKeyFromEnv: !fromFlag } : {}),
        ...(args.eventsJson ? { runEvents: (line: string) => void process.stdout.write(line) } : {}),
        hostEnv,
        stepOutput: (line) => void process.stderr.write(`${line}\n`),
      },
      log: (e) => console.error(e.type === "error" || e.type === "ledger" ? formatWarning({ message: formatCiServeEvent(e) }) : `ci serve: ${formatCiServeEvent(e)}`),
    };
    if (args.once) {
      const pass = await ciServePass(opts);
      return pass.jobs.some((j) => j.status !== "ok") ? 1 : 0;
    }
    const stop = new AbortController();
    const onSignal = (): void => stop.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      await ciServeLoop({ ...opts, intervalMs, signal: stop.signal });
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    return 0;
  } catch (err) {
    console.error(formatError({ message: `chant ci serve: ${message(err)}`, hint: USAGE }));
    return 1;
  }
}
