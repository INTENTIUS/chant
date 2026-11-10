/**
 * Which checks a job outside the check's own may sign (#4926): `chant ci
 * evidence sign --from-job <job>`, the evidence job after a wave job.
 *
 * The wave job runs the change's code, so whatever could sign in it could
 * sign a check that never passed, and a wave that trades cloud credentials
 * can request no signing token after the trade anyway. The evidence job runs
 * none of that code. It reads the wave job's own record from the forge
 * (./pr-forge-reads.ts `runJobs`) with the job token and signs a check only
 * when:
 *
 * - the job it names ran in this run, for this commit: a job of another run
 *   or commit refuses the whole command;
 * - the forge reports the check's step (GitHub, Forgejo) or job (GitLab,
 *   which reports no steps) finished with `success`. Change code can fail or
 *   pass its own steps, but it cannot make the forge report a passing policy
 *   step whose command failed;
 * - with `claims`, the step's claim file (./ci-evidence-claims.ts) says the
 *   check passed. Its claim, such as the policy rows, is what the statement
 *   digests.
 *
 * Each check signed carries `source: { run, job, step }`, the ids it relied
 * on, so a verifier can look them up.
 *
 * A job it reads that has not finished is waited for, up to
 * {@link FROM_JOB_WAIT_MS} (#4978): `chant run resume` retries a GitLab
 * wave job's evidence job with the wave job, and the two may start
 * together.
 */

import type { ForgeReads, RunJob } from "./pr-forge-reads";
import { commitAndTree, noRunnerIdentity, recordChecks, runnerEvidenceSigner, signChecks, type CheckSource } from "./workspace/trust/check-evidence";
import { EVIDENCE_SOURCES_ENV, parseEvidenceSources, readCheckClaimFile, type EvidenceSourceSpec } from "./ci-evidence-claims";

/** What {@link checksFromJob} reads. */
export interface ChecksFromJobInput {
  reads: Pick<ForgeReads, "runJobs">;
  /** This run's id: `GITHUB_RUN_ID`, `CI_PIPELINE_ID`. */
  run: number;
  /** This run's commit: `GITHUB_SHA`, `CI_COMMIT_SHA`. */
  sha: string;
  /** The job the checks ran in, by name. */
  fromJob: string;
  checks: readonly string[];
  /** Each check's job and step; a check with none is read from `fromJob`'s own result. */
  sources?: Readonly<Record<string, EvidenceSourceSpec>>;
  /** The directory of the jobs' claim files. Without it, a check needs only its step's success and signs no claim. */
  claims?: string;
  /**
   * How long to wait for a job it reads that has not finished (#4978), in
   * milliseconds, reading the run's jobs again every `pollMs` (default 15
   * seconds). A GitLab evidence job retried with its wave job can start
   * before the new try ends. Default 0: a job not finished is not signed.
   */
  waitMs?: number;
  pollMs?: number;
  /** For tests: in place of a timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** What may be signed, and what not and why. */
export type ChecksFromJob =
  | { sign: Array<{ check: string; claim?: string; source: CheckSource }>; skipped: Array<{ check: string; reason: string }> }
  | { refused: string };

const SUCCESS = "success";

/** Whether the forge reports `job` passed: GitHub's and Forgejo's conclusion, GitLab's status. */
function jobPassed(job: RunJob): boolean {
  return job.conclusion !== undefined ? job.conclusion === SUCCESS : job.status === SUCCESS;
}

/**
 * The run's jobs once every job the checks read has finished, or as they
 * are when `waitMs` runs out (#4978). A job not in the run is left to
 * {@link checksFromJob} to refuse.
 */
async function settledJobs(input: ChecksFromJobInput): Promise<RunJob[]> {
  const names = new Set(input.checks.map((c) => input.sources?.[c]?.job ?? input.fromJob));
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const poll = Math.max(1, input.pollMs ?? 15_000);
  let left = input.waitMs ?? 0;
  for (;;) {
    const jobs = await input.reads.runJobs(input.run);
    const going = jobs.some((j) => names.has(j.name) && !j.done);
    if (!going || left <= 0) return jobs;
    await sleep(Math.min(poll, left));
    left -= poll;
  }
}

/** The checks the run's record lets this job sign (#4926), or why the job it names does not count at all. */
export async function checksFromJob(input: ChecksFromJobInput): Promise<ChecksFromJob> {
  const jobs = await settledJobs(input);
  const found = new Map<string, RunJob | string>();
  const jobNamed = (name: string): RunJob | string => {
    const had = found.get(name);
    if (had !== undefined) return had;
    const named = jobs.filter((j) => j.name === name);
    let got: RunJob | string;
    if (named.length === 0) got = `run ${input.run} has no job named ${name}`;
    else if (named.length > 1) got = `run ${input.run} has ${named.length} jobs named ${name}, so which one ran the check is not known`;
    else {
      const j = named[0]!;
      if (j.run !== undefined && j.run !== input.run) got = `job ${name} (${j.id}) belongs to run ${j.run}, not this run ${input.run}`;
      else if (j.headSha === undefined) got = `the forge names no commit for job ${name} (${j.id}), so it cannot be bound to ${input.sha.slice(0, 12)}`;
      else if (j.headSha !== input.sha) got = `job ${name} (${j.id}) ran for commit ${j.headSha.slice(0, 12)}, not this run's ${input.sha.slice(0, 12)}`;
      else got = j;
    }
    found.set(name, got);
    return got;
  };
  const sign: Array<{ check: string; claim?: string; source: CheckSource }> = [];
  const skipped: Array<{ check: string; reason: string }> = [];
  for (const check of input.checks) {
    const spec = input.sources?.[check] ?? {};
    const name = spec.job ?? input.fromJob;
    const job = jobNamed(name);
    if (typeof job === "string") return { refused: job };
    if (!job.done) {
      skipped.push({ check, reason: `job ${name} has not finished (${job.status})` });
      continue;
    }
    let step: string | undefined;
    if (spec.step !== undefined) {
      if (!job.steps) {
        skipped.push({ check, reason: `the forge lists no steps for job ${name}` });
        continue;
      }
      const s = job.steps.filter((x) => x.name === spec.step);
      if (s.length !== 1) {
        skipped.push({ check, reason: s.length === 0 ? `job ${name} has no step named ${JSON.stringify(spec.step)}` : `job ${name} has ${s.length} steps named ${JSON.stringify(spec.step)}` });
        continue;
      }
      if (s[0]!.conclusion !== SUCCESS) {
        skipped.push({ check, reason: `step ${JSON.stringify(spec.step)} of job ${name} concluded ${s[0]!.conclusion ?? s[0]!.status}` });
        continue;
      }
      step = spec.step;
    } else if (!jobPassed(job)) {
      skipped.push({ check, reason: `job ${name} ended ${job.conclusion ?? job.status}` });
      continue;
    }
    let claim: string | undefined;
    if (input.claims !== undefined) {
      const file = readCheckClaimFile(input.claims, check);
      if ("problem" in file) {
        skipped.push({ check, reason: file.problem });
        continue;
      }
      if (!file.passed) {
        skipped.push({ check, reason: `job ${name}'s claim file says ${check} did not pass` });
        continue;
      }
      claim = file.claim;
    }
    sign.push({ check, ...(claim !== undefined ? { claim } : {}), source: { run: input.run, job: job.id, ...(step ? { step } : {}) } });
  }
  return { sign, skipped };
}

/** What {@link signFromJob} does in a job. */
export interface SignFromJobInput {
  repo: string;
  /** The commit whose `.chant/trust.json` lists the runner identities. */
  base: string;
  fromJob: string;
  checks: readonly string[];
  claims?: string;
  /** The commit to sign. Default: the run's commit. It must be the run's commit. */
  at?: string;
  reads: Pick<ForgeReads, "runJobs">;
  env?: NodeJS.ProcessEnv;
  /** The runner key in place of `CHANT_RUNNER_KEY`. */
  key?: string;
  push?: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** How long to wait for an unfinished job it reads (#4978). Default {@link FROM_JOB_WAIT_MS}. */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How long `sign --from-job` waits for a job it reads to finish (#4978): a
 * GitLab `<wave job>-evidence` retried with its wave job by `chant run
 * resume` may start before the wave job's new try ends. 30 minutes.
 */
export const FROM_JOB_WAIT_MS = 30 * 60_000;

/** What {@link signFromJob} signed and skipped, or why it refused. */
export type SignFromJobResult =
  | { signed: Array<{ check: string; runner: string; commit: string; tree: string; source: CheckSource }>; skipped: Array<{ check: string; reason: string }>; pushWarning?: string }
  | { refused: string };

/**
 * `chant ci evidence sign --from-job` (#4926): this run's id and commit from
 * the job's environment (`GITHUB_RUN_ID` and `GITHUB_SHA` on GitHub and
 * Forgejo, `CI_PIPELINE_ID` and `CI_COMMIT_SHA` on GitLab), the sources from
 * `CHANT_EVIDENCE_SOURCES`, the checks {@link checksFromJob} allows, signed
 * with the job's runner identity and pushed. Without a runner identity it
 * signs nothing and says so, as `sign` does.
 */
export async function signFromJob(input: SignFromJobInput): Promise<SignFromJobResult> {
  const env = input.env ?? process.env;
  const log = input.log ?? ((line: string) => console.error(line));
  const rawRun = env.GITHUB_RUN_ID ?? env.CI_PIPELINE_ID;
  const sha = env.GITHUB_SHA ?? env.CI_COMMIT_SHA;
  if (!rawRun || !/^\d+$/.test(rawRun) || !sha) return { refused: "--from-job reads this run from the job's environment: GITHUB_RUN_ID and GITHUB_SHA, or CI_PIPELINE_ID and CI_COMMIT_SHA" };
  let commit: string;
  try {
    commit = commitAndTree(input.repo, input.at ?? sha).commit;
  } catch {
    return { refused: `${input.at ?? sha} is not a commit in this checkout; fetch the run's commit first` };
  }
  if (commit !== sha) return { refused: `--at names ${commit.slice(0, 12)}, and this run is for ${sha.slice(0, 12)}; --from-job signs only the run's own commit` };
  const parsed = parseEvidenceSources(env[EVIDENCE_SOURCES_ENV]);
  if ("problem" in parsed) return { refused: parsed.problem };
  const decided = await checksFromJob({
    reads: input.reads,
    run: Number(rawRun),
    sha,
    fromJob: input.fromJob,
    checks: input.checks,
    sources: parsed.sources,
    ...(input.claims !== undefined ? { claims: input.claims } : {}),
    waitMs: input.waitMs ?? FROM_JOB_WAIT_MS,
    ...(input.pollMs !== undefined ? { pollMs: input.pollMs } : {}),
    ...(input.sleep ? { sleep: input.sleep } : {}),
  });
  if ("refused" in decided) return decided;
  for (const s of decided.skipped) log(`ci evidence: ${s.check} not signed: ${s.reason}`);
  if (decided.sign.length === 0) return { signed: [], skipped: decided.skipped };
  const signer = await runnerEvidenceSigner(input.repo, input.base, { env, ...(input.key ? { key: input.key } : {}), ...(input.fetch ? { fetch: input.fetch } : {}) });
  if (!signer) {
    log(`ci evidence: ${noRunnerIdentity()}, so no check was signed`);
    return { signed: [], skipped: [...decided.skipped, ...decided.sign.map((s) => ({ check: s.check, reason: noRunnerIdentity() }))] };
  }
  const signed = await signChecks(input.repo, commit, decided.sign, signer);
  const pushed = await recordChecks(input.repo, signed, { push: input.push !== false });
  const bySource = new Map(decided.sign.map((s) => [s.check, s.source]));
  for (const s of signed) log(`ci evidence: signed ${s.check} at ${s.commit.slice(0, 12)} as ${s.runner}, from job ${bySource.get(s.check)!.job}${bySource.get(s.check)!.step ? ` step ${JSON.stringify(bySource.get(s.check)!.step)}` : ""} of run ${rawRun}`);
  const warning = input.push !== false && !pushed.pushed ? pushed.pushWarning : undefined;
  if (warning) log(`ci evidence: the evidence is attached here, and the push did not land: ${warning}`);
  return {
    signed: signed.map((s) => ({ check: s.check, runner: s.runner, commit: s.commit, tree: s.tree, source: bySource.get(s.check)! })),
    skipped: decided.skipped,
    ...(warning ? { pushWarning: warning } : {}),
  };
}
