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
 * - Resume records. Each apply gets `<state>/resume/<prApplyRecordKey>.json`
 *   as its `--resume` record, so a re-run of a failed apply at the same
 *   commit finishes under the approval it has. This replaces the forge's CI
 *   cache.
 * - Capacity. At most `maxJobs` jobs run at once. A job over the limit is not
 *   recorded, so a later poll starts it.
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

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { prApplyGroup, prApplyRecordKey } from "../components/pr-pipeline";
import { forgeFromEnv, type OpenPullRequest } from "../pr-forge";
import type { CommandContext } from "../cli/registry";
import { formatError, formatWarning } from "../cli/format";
import { acquireLease, currentHolderId, releaseLease, DEFAULT_LEASE_TTL_MS, type LeaseRecord } from "../lifecycle/lease";
import { parseDuration } from "../op/duration";
import { CI_JOB_OPS, ciJobPlace, ciSecretsOf, ciRun, ciStatusFromEnv, CiRunError, type CiJobName, type CiRunRequest, type CiRunResult } from "./ci-run";
import { RUNNER_KEY_ENV } from "./ci-green";
import { gitTop } from "./tree";

/** The forges `ci serve` polls. GitLab is later. */
export type CiServeForgeKind = "github" | "forgejo";

/** What `ci serve` reads from the forge: the two calls GitHub's and Forgejo's clients have (../pr-forge.ts). */
export interface CiServeForge {
  openPullRequests(base: string): Promise<OpenPullRequest[]>;
  branchHead(branch: string): Promise<string | undefined>;
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
  /** The target branch's head the last apply was measured to, or the head the first poll found. */
  target?: string;
  jobs: Record<string, CiServeJobState>;
}

/** What a pass did, in order, for the log. */
export type CiServeEvent =
  | { type: "baseline"; commit: string }
  | { type: "no-branch"; branch: string }
  | { type: "skipped"; pr: number; reason: "fork" | "author"; author?: string }
  | { type: "held"; job: CiJobName; commit: string; pr?: number; reason: "capacity" | "lease"; heldBy?: string }
  | { type: "started"; job: CiJobName; commit: string; pr?: number; base: string; runId: string; attempt: number; resume?: string }
  | { type: "settled"; job: CiJobName; commit: string; pr?: number; status: "ok" | "fail"; failure?: string; report?: string }
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
 * since the last apply (none on the first poll, which only notes the head),
 * then a plan for each open pull request head not yet planned, oldest pull
 * request first. A job already in the state file is left out unless it
 * failed and `rerunFailed` is set. The first poll's head is written to the
 * state file.
 */
export async function ciServeObserve(opts: CiServeOptions, rt: CiServeRuntime = newCiServeRuntime()): Promise<{ triggers: CiServeTrigger[]; events: CiServeEvent[] }> {
  const place = servePlace(opts);
  const state = readCiServeState(place.stateFile, { forge: opts.forge, repo: opts.repo, env: opts.env, branch: place.branch, ...(place.member ? { member: place.member } : {}) });
  const triggers: CiServeTrigger[] = [];
  const events: CiServeEvent[] = [];
  const [head, prs] = await Promise.all([opts.client.branchHead(place.branch), opts.client.openPullRequests(place.branch)]);

  if (head === undefined) {
    events.push({ type: "no-branch", branch: place.branch });
  } else if (state.target === undefined) {
    // What the branch held before this runner watched it was applied by whatever ran then.
    state.target = head;
    writeState(place.stateFile, state);
    events.push({ type: "baseline", commit: head });
  } else if (head !== state.target) {
    const entry = state.jobs[ciServeKey({ job: "apply", commit: head })];
    if (!entry) triggers.push({ job: "apply", commit: head, base: state.target });
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
    if (!base) continue;
    if (!entry) triggers.push({ job: "plan", commit: pr.headSha, base, pr: pr.number });
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
): Promise<Pick<CiServeJobState, "status" | "failure" | "report">> {
  const renew = held
    ? setInterval(() => {
        void acquireLease(place.group, held.holder, { cwd: opts.cwd, ttlMs: held.ttlMs, mode: "renew", token: held.lease.token, now: held.now }).catch(() => undefined);
      }, Math.max(1000, Math.floor(held.ttlMs / 3)))
    : undefined;
  renew?.unref?.();
  try {
    // The pull request's head is on the forge's refs/pull/<n>/head, the target's on the branch.
    tryGit(place.top, ["fetch", "--quiet", "--no-tags", "origin", t.job === "plan" ? `refs/pull/${t.pr}/head` : place.branch]);
    const hostEnv = { ...(opts.job?.hostEnv ?? process.env), GITHUB_REPOSITORY: opts.repo };
    const run = opts.run ?? ciRun;
    const r = await run({
      ...opts.job,
      hostEnv,
      cwd: opts.cwd,
      job: t.job,
      env: opts.env,
      forge: opts.forge,
      base: t.base,
      ...(t.job === "plan" ? { pr: t.pr } : {}),
      commit: t.commit,
      output: paths.report,
      runId: paths.runId,
      ...(paths.resume ? { resumeRecord: paths.resume } : {}),
    });
    const why = r.record.failure ? `${r.record.failure.code}: ${r.record.failure.reason}` : r.failure ? `${r.failure.phase}: ${r.failure.error.split("\n")[0]}` : undefined;
    return { status: r.status === "ok" ? "ok" : "fail", ...(why && r.status !== "ok" ? { failure: why } : {}), ...(r.report ? { report: r.report } : {}) };
  } catch (err) {
    return { status: "fail", failure: message(err) };
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
    case "error":
      return `error: ${e.message}`;
  }
}

// ── The command ──────────────────────────────────────────────────────────────

const USAGE =
  "chant ci serve --forge forgejo|github --repo <owner/repo> --env <env> [--interval <s>] [--max-jobs <n>] [--state <dir>] " +
  "[--author <login>]... [--once] [--rerun-failed] [--gate <name>] [--branch <name>] [--events-json] [--report-url <url>] [--no-status] [--status-url <url template>] " +
  "[--image <image>] [--before-script <line>]... [--pr-build] [--pr-build-command <line>] [--chant <command>] [--pass-env <NAME>]... [--secrets <file>] [--key <runner key.pem>]";

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
    const forge = args.forge;
    if (forge !== "forgejo" && forge !== "github") throw new CiRunError(`--forge names the forge ci serve polls: --forge forgejo|github${forge ? `, not ${JSON.stringify(forge)}` : ""}`);
    if (!args.ciRepo) throw new CiRunError("--repo names the repository whose pull requests ci serve polls: --repo <owner/repo>");
    if (!args.env) throw new CiRunError("--env names the environment the pipeline is for: --env <env>");
    for (const name of args.passEnv ?? []) if (!ENV_NAME.test(name)) throw new CiRunError(`--pass-env takes a variable's name, not ${JSON.stringify(name)}`);
    const intervalMs = ciServeInterval(args.interval);
    const fromFlag = args.key !== undefined;
    const runnerKey = fromFlag ? readFileSync(resolve(args.key!), "utf-8") : process.env[RUNNER_KEY_ENV] || undefined;
    // #4096: read once, so a loose or broken secrets file stops the serve before its first poll.
    const secrets = ciSecretsOf(args.ciSecrets);
    const hostEnv = { ...process.env, GITHUB_REPOSITORY: args.ciRepo };
    const client = forgeFromEnv(forge, hostEnv);
    const { status, warning } = ciStatusFromEnv({ forge, hostEnv, noStatus: args.noStatus, statusUrl: args.statusUrl });
    if (warning) console.error(formatWarning({ message: warning }));
    if (!client.openPullRequests || !client.branchHead) throw new CiRunError(`the ${forge} client cannot list pull requests`);
    const opts: CiServeOptions = {
      cwd: process.cwd(),
      forge,
      repo: args.ciRepo,
      env: args.env,
      client: { openPullRequests: client.openPullRequests.bind(client), branchHead: client.branchHead.bind(client) },
      ...(args.statePath ? { stateDir: isAbsolute(args.statePath) ? args.statePath : resolve(args.statePath) } : {}),
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
      log: (e) => console.error(e.type === "error" ? formatWarning({ message: formatCiServeEvent(e) }) : `ci serve: ${formatCiServeEvent(e)}`),
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
