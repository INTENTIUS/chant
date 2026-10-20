/**
 * `chant ci serve` (#4095, epic #4101): the chant runner's trigger loop on one
 * host. It polls the forge for the open pull requests into the target branch
 * and for the branch's head, and runs the pull-request jobs with
 * {@link ciRun} (./ci-run.ts): `plan` for each new pull request head, and
 * `apply` for each new commit on the target branch, measured from the head
 * the previous poll saw (the push's `before`).
 *
 * - Dedupe. A state file in the state directory keeps every job it started,
 *   keyed by job and commit (`plan:<pr>:<sha>`, `apply:<sha>`), with how it
 *   ended, and the target head the last apply was measured to. A job already
 *   in it is not started again, unless it failed and `rerunFailed` asks for
 *   it: the forge's "re-run failed jobs".
 * - One apply per group. An apply takes the git-ref lease (../lifecycle/lease.ts,
 *   the one `chant operator` holds) named for `prApplyGroup`, renews it while
 *   it runs and releases it after. An apply that finds it held waits for a
 *   later poll, as a forge's concurrency group queues it.
 * - Merged pull request. An apply asks the forge for the pull request whose
 *   merge commit the new head is (`pullRequestFor`, as pr-apply does) and
 *   passes it as `--pr`, so its commit status link and run index use
 *   `<pr>/<commit>`. With none found it runs without `--pr`.
 * - Resume records. Each apply gets `<state>/resume/<prApplyRecordKey>.json`
 *   as its `--resume` record, so a re-run of a failed apply at the same
 *   commit finishes under the approval it has. This replaces the forge's CI
 *   cache.
 * - Capacity. At most `maxJobs` jobs run at once. A job over the limit is not
 *   recorded, so a later poll starts it.
 * - Fast-forwards only (#4122). An apply runs only when the target's new head
 *   descends from the head seen before it. Any other move, such as a force
 *   push back to an older commit, is recorded as seen and not applied.
 * - `[skip ci]` (#4122). A target head or pull request head whose commit
 *   message says `[skip ci]` or `[ci skip]` is recorded as seen and not run,
 *   as Actions does.
 * - The forge's ledger (#4121). Before each job, when no other job of this
 *   serve runs, the clone's `chant/lifecycle` follows the forge's: it is
 *   deleted when the forge has none, and reset to the forge's when neither
 *   contains the other. Each is a warning. A local branch ahead of the
 *   forge's keeps its facts, and the job's push sends them. Nothing here
 *   pushes the ledger.
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

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prApplyGroup, prApplyRecordKey } from "../components/pr-pipeline";
import { forgeFromEnv, type OpenPullRequest } from "../pr-forge";
import type { CommandContext } from "../cli/registry";
import { formatError, formatWarning } from "../cli/format";
import { acquireLease, currentHolderId, releaseLease, DEFAULT_LEASE_TTL_MS, type LeaseRecord } from "../lifecycle/lease";
import { parseDuration } from "../op/duration";
import { CI_JOB_OPS, ciJobPlace, ciSecretsOf, ciRun, ciStatusFromEnv, CiRunError, type CiJobName, type CiRunRequest, type CiRunResult } from "./ci-run";
import { RUNNER_KEY_ENV } from "./ci-green";
import { gitTop } from "./tree";
import { ciServeRunnerKey, formatRunnerKeySetup, setupRunnerKey } from "./ci-runner-key";

/** The forges `ci serve` polls. GitLab is later. */
export type CiServeForgeKind = "github" | "forgejo";

/** What `ci serve` reads from the forge: the two calls GitHub's and Forgejo's clients have (../pr-forge.ts). */
export interface CiServeForge {
  openPullRequests(base: string): Promise<OpenPullRequest[]>;
  branchHead(branch: string): Promise<string | undefined>;
  /** The merged pull request that produced a commit, as pr-apply finds it (`pullRequestFor`). Without it an apply gets no `--pr`. */
  pullRequestFor?(sha: string): Promise<number | null>;
}

/** A job the forge's state calls for: the plan of a pull request's head, or the apply of a target-branch commit. */
export type CiServeTrigger =
  | { job: "plan"; commit: string; base: string; pr: number; rerun?: boolean }
  | { job: "apply"; commit: string; base: string; rerun?: boolean };

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
  jobs: Record<string, CiServeJobState>;
  /** Plans seen and not run, by state key, with why (#4122). */
  skipped?: Record<string, "skip-ci">;
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
  /** Passed to each job. `job.hostEnv` gets `GITHUB_REPOSITORY` set to `repo`. */
  job?: CiServeJobOptions;
  /** This process's lease identity. Default `currentHolderId()`. */
  holder?: string;
  leaseTtlMs?: number;
  log?: (event: CiServeEvent) => void;
  now?: () => Date;
  /** Runs a job. Default {@link ciRun}. */
  run?: (req: CiRunRequest) => Promise<CiRunResult>;
}

/** The jobs this process runs now, by state key, shared by every pass of one loop. */
export interface CiServeRuntime {
  inflight: Map<string, Promise<CiServeJobState>>;
}

export const newCiServeRuntime = (): CiServeRuntime => ({ inflight: new Map() });

/** The state key of a job. */
export function ciServeKey(t: { job: CiJobName; commit: string; pr?: number }): string {
  return t.job === "plan" ? `plan:${t.pr}:${t.commit}` : `apply:${t.commit}`;
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
  branch: string;
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
  return { top, ...(member ? { member } : {}), branch: opts.job?.loop?.branch ?? "main", group, stateDir, stateFile: join(stateDir, `${group}.json`) };
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
  const [head, prs] = await Promise.all([opts.client.branchHead(place.branch), opts.client.openPullRequests(place.branch)]);

  if (head === undefined) {
    events.push({ type: "no-branch", branch: place.branch });
  } else if (state.target === undefined) {
    // What the branch held before this runner watched it was applied by whatever ran then.
    update((s) => {
      s.target = head;
    });
    events.push({ type: "baseline", commit: head });
  } else if (head !== state.target) {
    const from = state.target;
    const move = targetMove(place.top, place.branch, from, head);
    const entry = state.jobs[ciServeKey({ job: "apply", commit: head })];
    if (move === "unknown") {
      events.push({ type: "error", message: `${place.branch} is at ${head.slice(0, 12)} on the forge, and that commit could not be fetched; the next poll tries again` });
    } else if (move === "other" || (!entry && skipsCi(place.top, head))) {
      // #4122: a move that is not a fast-forward, or a head that asks for no run, is seen and not applied.
      update((s) => {
        s.target = head;
      });
      events.push({ type: "not-run", job: "apply", commit: head, reason: move === "other" ? "not-fast-forward" : "skip-ci", ...(move === "other" ? { branch: place.branch, from } : {}) });
    } else if (!entry) triggers.push({ job: "apply", commit: head, base: from });
    else if (opts.rerunFailed && failedEntry(entry, ciServeKey(entry), rt)) triggers.push({ job: "apply", commit: head, base: entry.base, rerun: true });
  } else {
    const key = ciServeKey({ job: "apply", commit: head });
    const entry = state.jobs[key];
    if (opts.rerunFailed && failedEntry(entry, key, rt)) triggers.push({ job: "apply", commit: head, base: entry.base, rerun: true });
  }

  const authors = opts.authors?.length ? new Set(opts.authors.map((a) => a.toLowerCase())) : undefined;
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
      } else triggers.push({ job: "plan", commit: pr.headSha, base, pr: pr.number });
    }
    else if (opts.rerunFailed && failedEntry(entry, key, rt)) triggers.push({ job: "plan", commit: pr.headSha, base: entry.base, pr: pr.number, rerun: true });
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
      if (t.job === "apply" && !t.rerun) s.target = t.commit;
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
      return settled;
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
    tryGit(place.top, ["fetch", "--quiet", "--no-tags", "origin", t.job === "plan" ? `refs/pull/${t.pr}/head` : place.branch]);
    const hostEnv = { ...(opts.job?.hostEnv ?? process.env), GITHUB_REPOSITORY: opts.repo };
    // An apply is for a merge: pass the pull request whose merge commit it is, so the commit status link and the run index use `<pr>/<commit>`. None found, or a forge that errs, is today's behaviour.
    if (t.job === "apply" && opts.client.pullRequestFor) merged = (await opts.client.pullRequestFor(t.commit).catch(() => null)) ?? undefined;
    const run = opts.run ?? ciRun;
    const r = await run({
      ...opts.job,
      hostEnv,
      cwd: opts.cwd,
      job: t.job,
      env: opts.env,
      forge: opts.forge,
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

/** One pass: observe, schedule, and with `wait` wait for the jobs it started. */
export async function ciServePass(opts: CiServeOptions, rt: CiServeRuntime = newCiServeRuntime(), wait = true): Promise<{ events: CiServeEvent[]; jobs: CiServeJobState[] }> {
  const observed = await ciServeObserve(opts, rt);
  for (const e of observed.events) opts.log?.(e);
  const scheduled = await ciServeSchedule(opts, observed.triggers, rt);
  const jobs = wait ? await Promise.all(scheduled.started) : [];
  return { events: [...observed.events, ...scheduled.events], jobs };
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
  "chant ci serve --forge forgejo|github --repo <owner/repo> --env <env> [--interval <s>] [--max-jobs <n>] [--state <dir>] " +
  "[--author <login>]... [--once] [--rerun-failed] [--gate <name>] [--branch <name>] [--events-json] [--report-url <url>] [--no-status] [--status-url <url template>] " +
  "[--image <image>] [--before-script <line>]... [--pr-build] [--pr-build-command <line>] [--chant <command>] [--pass-env <NAME>]... [--secrets <file>] [--key <runner key.pem>] [--unsigned]";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `--interval`: seconds, or a duration such as `30s` or `2m`. Default 30 seconds. */
export function ciServeInterval(value: string | undefined): number {
  if (value === undefined) return 30_000;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : parseDuration(value);
  if (!(ms >= 1000)) throw new CiRunError(`--interval takes seconds or a duration of a second or more, not ${JSON.stringify(value)}`);
  return ms;
}

/** `chant ci serve` (#4095). */
export async function runCiServe(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  try {
    if (args.setupKey) return runnerKeySetupCommand(ctx);
    const forge = args.forge;
    if (forge !== "forgejo" && forge !== "github") throw new CiRunError(`--forge names the forge ci serve polls: --forge forgejo|github${forge ? `, not ${JSON.stringify(forge)}` : ""}`);
    if (!args.ciRepo) throw new CiRunError("--repo names the repository whose pull requests ci serve polls: --repo <owner/repo>");
    if (!args.env) throw new CiRunError("--env names the environment the pipeline is for: --env <env>");
    for (const name of args.passEnv ?? []) if (!ENV_NAME.test(name)) throw new CiRunError(`--pass-env takes a variable's name, not ${JSON.stringify(name)}`);
    const intervalMs = ciServeInterval(args.interval);
    const cwd = process.cwd();
    const top = gitTop(cwd);
    if (!top) throw new CiRunError("ci serve runs in a clone of the repository it serves, and this directory is not in a git repository");
    const stateDir = args.statePath ? resolve(args.statePath) : defaultCiServeStateDir(cwd);
    const branch = args.branch ?? "main";
    // #4099: the host's key, checked against .chant/trust.json at the target's head before the first poll.
    const keyed = ciServeRunnerKey({ top, stateDir, branch, ...(args.key !== undefined ? { keyFile: resolve(args.key) } : {}), envKey: process.env[RUNNER_KEY_ENV] || undefined, unsigned: args.unsigned });
    const fromFlag = keyed.fromFlag;
    const runnerKey = keyed.pem;
    console.error(`ci serve: ${runnerKey === undefined ? "runs are not signed (--unsigned)" : `signing runs with the runner key from ${keyed.source}`}`);
    // #4096: read once, so a loose or broken secrets file stops the serve before its first poll.
    const secrets = ciSecretsOf(args.ciSecrets);
    const hostEnv = { ...process.env, GITHUB_REPOSITORY: args.ciRepo };
    const client = forgeFromEnv(forge, hostEnv);
    const { status, warning } = ciStatusFromEnv({ forge, hostEnv, noStatus: args.noStatus, statusUrl: args.statusUrl });
    if (warning) console.error(formatWarning({ message: warning }));
    if (!client.openPullRequests || !client.branchHead) throw new CiRunError(`the ${forge} client cannot list pull requests`);
    const opts: CiServeOptions = {
      cwd,
      forge,
      repo: args.ciRepo,
      env: args.env,
      client: { openPullRequests: client.openPullRequests.bind(client), branchHead: client.branchHead.bind(client), pullRequestFor: client.pullRequestFor.bind(client) },
      stateDir,
      ...(args.maxJobs ? { maxJobs: args.maxJobs } : {}),
      ...(args.ciAuthors?.length ? { authors: args.ciAuthors } : {}),
      ...(args.rerunFailed ? { rerunFailed: true } : {}),
      job: {
        loop: {
          ...(args.gate ? { gate: args.gate } : {}),
          ...(args.branch ? { branch: args.branch } : {}),
          ...(args.eventsJson ? { events: true } : {}),
          ...(args.reportUrl ? { reportUrl: args.reportUrl } : {}),
          ...(args.prBuild ? { build: true } : {}),
          ...(args.prBuildCommand ? { buildCommand: args.prBuildCommand } : {}),
        },
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
