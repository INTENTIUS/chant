/**
 * The runner-start statement (#4147): a provisioner's signed word that it
 * started a runner for one CI job, which the job checks before it runs.
 *
 * A persistent self-hosted runner keeps files and processes between jobs,
 * so a plan job that ran a pull request's code can leave something behind
 * for the next apply. An apply job that requires this statement refuses to
 * run, before it trades for any credentials, on a runner that no trusted
 * provisioner says it started for this job.
 *
 * It differs from the Op-run statement (#4044, ./workspace/trust/op-run-statement.ts)
 * in three ways. It is signed before the job runs, not when a run settles.
 * The provisioner that starts the runner signs it, so the key never enters
 * the job. And it names the CI job, run and attempt, so a statement issued
 * for one job does not verify in another.
 *
 * The statement is an in-toto Statement v1 in a DSSE envelope
 * (./workspace/trust/dsse.ts), signed with an Ed25519 key that
 * `.chant/trust.json` lists under `runners`, whose principal holds the
 * `runner` role there, the same keys and role a ci tag needs (#4031):
 *
 * - `subject`: the commit the job runs, by `digest.gitCommit`.
 * - `predicate`: the signer's principal; `ci` with the system (`github`,
 *   `gitlab`, `forgejo`), the repository, and the run, attempt and job ids;
 *   `runner` with the runner's name and `singleJob: true`; and `issuedAt`.
 *
 * The job finds it in `CHANT_RUNNER_START` (the envelope's JSON) or in the
 * file `CHANT_RUNNER_START_FILE` names, else in
 * {@link DEFAULT_RUNNER_START_FILE}. The job's own ids come from the forge's
 * variables ({@link ciJobFromEnv}).
 *
 * This module needs only `node:crypto` and `node:fs`, so a bundled stage can
 * import it alone:
 *
 * ```ts
 * import { verifyRunnerStartForJob } from "@intentius/chant/runner-start";
 *
 * const trust = JSON.parse(readFileSync(".chant/trust.json", "utf8"));
 * const v = verifyRunnerStartForJob({ runners: trust.runners ?? [], roles: trust.roles ?? {} });
 * if (v.status !== "verified") throw new Error(v.reason);
 * ```
 *
 * `chant ci runner-start verify` and `chant ci run --require-runner-start`
 * read the runners and roles from `.chant/trust.json` at base, which also
 * drops a runner entry the signers file lists (./workspace/trust/policy.ts).
 * A caller that passes trust.json's lists itself skips that check.
 */

import { readFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { IN_TOTO_PAYLOAD_TYPE, signEnvelope, verifyEnvelope, type DsseEnvelope } from "./workspace/trust/dsse";

export const RUNNER_START_PREDICATE = "https://intentius.io/chant/runner-start/v1";

/** The in-toto Statement v1 type, as ./workspace/trust/evidence.ts has it. */
const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";

/** The role a runner-start statement's signer must hold in `.chant/trust.json`, as for a ci tag (#4031). */
export const RUNNER_START_SIGNER_ROLE = "runner";

/** The variable that holds the statement's envelope as JSON. */
export const RUNNER_START_ENV = "CHANT_RUNNER_START";

/** The variable that names a file holding the envelope, in place of {@link DEFAULT_RUNNER_START_FILE}. */
export const RUNNER_START_FILE_ENV = "CHANT_RUNNER_START_FILE";

/** Where the job looks for the envelope when neither variable is set. */
export const DEFAULT_RUNNER_START_FILE = "/run/chant/runner-start.json";

export type CiSystem = "github" | "gitlab" | "forgejo";

/** The CI job a runner was started for, or the job reading the statement. */
export interface CiJobIdentity {
  system: CiSystem;
  /** `owner/name` on GitHub and Forgejo, the project path on GitLab. */
  repo: string;
  /** The run: `GITHUB_RUN_ID`, or `CI_PIPELINE_ID` on GitLab. */
  run: string;
  /** The run's attempt: `GITHUB_RUN_ATTEMPT`. GitLab gives a retried job a new job id, so it is always `1` there. */
  attempt: string;
  /** The job: `GITHUB_JOB`, the job's key in the workflow, or `CI_JOB_ID` on GitLab. */
  job: string;
  /** The full commit id the job runs: `GITHUB_SHA`, or `CI_COMMIT_SHA`. */
  commit: string;
  /**
   * The runner's name: `RUNNER_NAME` on GitHub and Forgejo. Required there,
   * since `GITHUB_JOB` repeats across a matrix's jobs and the runner's name
   * tells them apart. Not compared on GitLab, where `CI_JOB_ID` is unique.
   */
  runner?: string;
}

export interface RunnerStartStatement {
  _type: typeof STATEMENT_TYPE;
  subject: [{ name: string; digest: { gitCommit: string } }];
  predicateType: typeof RUNNER_START_PREDICATE;
  predicate: {
    signer: string;
    ci: { system: CiSystem; repo: string; run: string; attempt: string; job: string };
    runner: { name?: string; singleJob: true };
    issuedAt: string;
  };
}

/** A key that may sign the statement, as `.chant/trust.json` lists it under `runners`. */
export interface RunnerStartKey {
  principal: string;
  /** `ssh-ed25519 <base64>`. */
  key: string;
}

/** Whoever signs: the provisioner's key and the principal `.chant/trust.json` lists it for. */
export interface RunnerStartSigner {
  principal: string;
  key: KeyObject;
  publicKey: string;
}

const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SYSTEMS: readonly CiSystem[] = ["github", "gitlab", "forgejo"];

/** The job the forge's variables name, or why they name none. GitHub's names are also Forgejo's; `FORGEJO_ACTIONS` or `GITEA_ACTIONS` marks Forgejo, as in ./notify.ts. */
export function ciJobFromEnv(env: Record<string, string | undefined> = process.env): { ok: true; job: CiJobIdentity } | { ok: false; reason: string } {
  const need = (names: readonly string[]): string | undefined => {
    const missing = names.filter((n) => !env[n]);
    return missing.length > 0 ? `the job's environment does not set ${missing.join(", ")}` : undefined;
  };
  if (env.GITLAB_CI === "true" || env.CI_PIPELINE_ID) {
    const gap = need(["CI_PROJECT_PATH", "CI_PIPELINE_ID", "CI_JOB_ID", "CI_COMMIT_SHA"]);
    if (gap) return { ok: false, reason: gap };
    return { ok: true, job: { system: "gitlab", repo: env.CI_PROJECT_PATH!, run: env.CI_PIPELINE_ID!, attempt: "1", job: env.CI_JOB_ID!, commit: env.CI_COMMIT_SHA! } };
  }
  if (env.GITHUB_ACTIONS === "true" || env.FORGEJO_ACTIONS === "true" || env.GITEA_ACTIONS === "true") {
    const system: CiSystem = env.FORGEJO_ACTIONS === "true" || env.GITEA_ACTIONS === "true" ? "forgejo" : "github";
    const gap = need(["GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_JOB", "GITHUB_SHA"]);
    if (gap) return { ok: false, reason: gap };
    return {
      ok: true,
      job: {
        system,
        repo: env.GITHUB_REPOSITORY!,
        run: env.GITHUB_RUN_ID!,
        attempt: env.GITHUB_RUN_ATTEMPT || "1",
        job: env.GITHUB_JOB!,
        commit: env.GITHUB_SHA!,
        ...(env.RUNNER_NAME ? { runner: env.RUNNER_NAME } : {}),
      },
    };
  }
  return { ok: false, reason: "this is not a GitHub, Forgejo or GitLab job: none of GITHUB_ACTIONS, FORGEJO_ACTIONS, GITEA_ACTIONS or GITLAB_CI is set" };
}

/** Why `job` cannot be signed for, or undefined. */
function jobProblem(job: CiJobIdentity): string | undefined {
  if (!SYSTEMS.includes(job.system)) return `the CI system is ${JSON.stringify(job.system)}, not github, gitlab or forgejo`;
  for (const field of ["repo", "run", "attempt", "job"] as const) {
    if (typeof job[field] !== "string" || job[field].length === 0) return `the job names no ${field}`;
  }
  if (!FULL_COMMIT.test(job.commit)) return `the job's commit ${JSON.stringify(job.commit)} is not a full commit id`;
  if (job.system !== "gitlab" && !job.runner) return `a ${job.system} job needs the runner's name, since GITHUB_JOB repeats across a matrix's jobs`;
  return undefined;
}

/** The statement `signer` signs for a runner started for `job`. Throws for a job it cannot name. */
export function buildRunnerStartStatement(job: CiJobIdentity, signer: string, issuedAt: Date = new Date()): RunnerStartStatement {
  const problem = jobProblem(job);
  if (problem) throw new Error(`no runner-start statement: ${problem}`);
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: job.commit, digest: { gitCommit: job.commit } }],
    predicateType: RUNNER_START_PREDICATE,
    predicate: {
      signer,
      ci: { system: job.system, repo: job.repo, run: job.run, attempt: job.attempt, job: job.job },
      runner: { ...(job.runner ? { name: job.runner } : {}), singleJob: true },
      issuedAt: issuedAt.toISOString(),
    },
  };
}

/** The envelope the provisioner hands the runner, signed with its key. */
export function signRunnerStart(job: CiJobIdentity, signer: RunnerStartSigner, issuedAt: Date = new Date()): DsseEnvelope {
  const statement = buildRunnerStartStatement(job, signer.principal, issuedAt);
  return signEnvelope(IN_TOTO_PAYLOAD_TYPE, Buffer.from(JSON.stringify(statement), "utf8"), signer.key, signer.publicKey);
}

export type RunnerStartVerdict =
  | { status: "verified"; signer: string; keyid: string; issuedAt: string; reason: string }
  | { status: "missing" | "invalid" | "untrusted" | "mismatch" | "stale"; reason: string };

const normalise = (name: string): string => name.normalize("NFKC").trim().toLowerCase();
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).every((k) => keys.includes(k));
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** The statement in `raw`, or why it is not one. Strict, so a verifier never acts on a field it does not know. */
function parseStatement(raw: unknown): RunnerStartStatement | string {
  if (!isObject(raw) || !onlyKeys(raw, ["_type", "subject", "predicateType", "predicate"])) return "not a statement with only _type, subject, predicateType and predicate";
  if (raw._type !== STATEMENT_TYPE) return `_type is not ${STATEMENT_TYPE}`;
  if (raw.predicateType !== RUNNER_START_PREDICATE) return `predicateType is not ${RUNNER_START_PREDICATE}`;
  const subject = raw.subject;
  if (!Array.isArray(subject) || subject.length !== 1) return "subject is not one commit";
  const s = subject[0];
  if (!isObject(s) || !onlyKeys(s, ["name", "digest"]) || !isObject(s.digest) || !onlyKeys(s.digest, ["gitCommit"])) return "subject is not one commit";
  if (typeof s.name !== "string" || !FULL_COMMIT.test(s.name) || s.digest.gitCommit !== s.name) return "the subject is not a full commit id named by itself";
  const p = raw.predicate;
  if (!isObject(p) || !onlyKeys(p, ["signer", "ci", "runner", "issuedAt"])) return "predicate has fields other than signer, ci, runner and issuedAt";
  if (!isText(p.signer)) return "predicate.signer is missing";
  const ci = p.ci;
  if (!isObject(ci) || !onlyKeys(ci, ["system", "repo", "run", "attempt", "job"])) return "predicate.ci has fields other than system, repo, run, attempt and job";
  if (!SYSTEMS.includes(ci.system as CiSystem)) return "predicate.ci.system is not github, gitlab or forgejo";
  for (const field of ["repo", "run", "attempt", "job"] as const) if (!isText(ci[field])) return `predicate.ci.${field} is missing`;
  const runner = p.runner;
  if (!isObject(runner) || !onlyKeys(runner, ["name", "singleJob"]) || runner.singleJob !== true) return "predicate.runner does not say singleJob: true";
  if (runner.name !== undefined && !isText(runner.name)) return "predicate.runner.name is not a name";
  if (!isText(p.issuedAt) || Number.isNaN(Date.parse(p.issuedAt))) return "predicate.issuedAt is not a time";
  return raw as unknown as RunnerStartStatement;
}

export interface VerifyRunnerStartInput {
  /** The envelope, as JSON text or parsed. Undefined when the job found none. */
  envelope: unknown;
  /** The job reading it. */
  job: CiJobIdentity;
  /** `runners` from `.chant/trust.json` at base. */
  runners: readonly RunnerStartKey[];
  /** `roles` from `.chant/trust.json` at base. */
  roles: Readonly<Record<string, readonly string[]>>;
  /** Refuse a statement issued longer ago than this. Default: no limit, since a statement names one job attempt. */
  maxAgeSeconds?: number;
  now?: Date;
}

/**
 * Verify a runner-start statement for `job`: a signature by a key listed
 * under `runners` whose principal holds the `runner` role, over a statement
 * for this system, repository, run, attempt, job, commit and, on GitHub and
 * Forgejo, runner. Never throws.
 */
export function verifyRunnerStart(input: VerifyRunnerStartInput): RunnerStartVerdict {
  const { job } = input;
  const what = `the ${job.system} job ${job.job} of run ${job.run} (attempt ${job.attempt})`;
  if (input.envelope === undefined || input.envelope === null || input.envelope === "") {
    return { status: "missing", reason: `${what} has no runner-start statement: no provisioner says this runner was started for it` };
  }
  let envelope = input.envelope;
  if (typeof envelope === "string") {
    try {
      envelope = JSON.parse(envelope);
    } catch {
      return { status: "invalid", reason: `${what}: the runner-start statement is not JSON` };
    }
  }
  const v = verifyEnvelope(envelope, input.runners);
  if (!v.ok) return { status: v.code === "envelope-untrusted" ? "untrusted" : "invalid", reason: `${what}: ${v.reason}` };
  if (!(input.roles[RUNNER_START_SIGNER_ROLE] ?? []).some((p) => normalise(p) === normalise(v.principal))) {
    return { status: "untrusted", reason: `${what}: the statement is signed by ${v.principal}'s key, and ${v.principal} holds no ${RUNNER_START_SIGNER_ROLE} role in .chant/trust.json at base` };
  }
  if (v.payloadType !== IN_TOTO_PAYLOAD_TYPE) return { status: "invalid", reason: `${what}: payload type ${v.payloadType} is not ${IN_TOTO_PAYLOAD_TYPE}` };
  let raw: unknown;
  try {
    raw = JSON.parse(v.payload.toString("utf8"));
  } catch {
    return { status: "invalid", reason: `${what}: the statement's payload is not JSON` };
  }
  const parsed = parseStatement(raw);
  if (typeof parsed === "string") return { status: "invalid", reason: `${what}: the payload is not a ${RUNNER_START_PREDICATE} statement: ${parsed}` };
  const p = parsed.predicate;
  if (p.signer !== v.principal) return { status: "invalid", reason: `${what}: the statement names signer ${JSON.stringify(p.signer)}, but ${v.principal}'s key signed it` };
  const differs: string[] = [];
  if (p.ci.system !== job.system) differs.push(`it is for a ${p.ci.system} job`);
  if (p.ci.repo !== job.repo) differs.push(`it is for repository ${p.ci.repo}`);
  if (p.ci.run !== job.run) differs.push(`it is for run ${p.ci.run}`);
  if (p.ci.attempt !== job.attempt) differs.push(`it is for attempt ${p.ci.attempt}`);
  if (p.ci.job !== job.job) differs.push(`it is for job ${p.ci.job}`);
  const commit = parsed.subject[0].name;
  if (commit !== job.commit) differs.push(`it is for commit ${commit.slice(0, 12)}, and the job runs ${job.commit.slice(0, 12)}`);
  if (job.system !== "gitlab") {
    if (!p.runner.name) differs.push("it names no runner, and a job id alone does not tell a matrix's jobs apart");
    else if (!job.runner) differs.push(`it is for runner ${p.runner.name}, and the job's environment names no runner (RUNNER_NAME)`);
    else if (p.runner.name !== job.runner) differs.push(`it is for runner ${p.runner.name}, and this is ${job.runner}`);
  }
  if (differs.length > 0) return { status: "mismatch", reason: `${what}: the runner-start statement signed by ${v.principal} is for another job: ${differs.join("; ")}` };
  if (input.maxAgeSeconds !== undefined) {
    const age = ((input.now ?? new Date()).getTime() - Date.parse(p.issuedAt)) / 1000;
    if (age > input.maxAgeSeconds) return { status: "stale", reason: `${what}: the runner-start statement was issued ${Math.round(age)}s ago, more than ${input.maxAgeSeconds}s` };
  }
  return { status: "verified", signer: v.principal, keyid: v.keyid, issuedAt: p.issuedAt, reason: `runner started for this job, signed by ${v.principal} (${RUNNER_START_SIGNER_ROLE})` };
}

/** The envelope's JSON the job was given: `CHANT_RUNNER_START`, else the file `CHANT_RUNNER_START_FILE` names, else {@link DEFAULT_RUNNER_START_FILE}. Undefined when there is none. */
export function readRunnerStart(env: Record<string, string | undefined> = process.env, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): string | undefined {
  const inline = env[RUNNER_START_ENV];
  if (inline) return inline;
  try {
    return readFile(env[RUNNER_START_FILE_ENV] || DEFAULT_RUNNER_START_FILE);
  } catch {
    return undefined;
  }
}

/**
 * One call for a job: find its statement ({@link readRunnerStart}), name the
 * job from the forge's variables ({@link ciJobFromEnv}) and verify one
 * against the other ({@link verifyRunnerStart}). Never throws.
 */
export function verifyRunnerStartForJob(input: {
  runners: readonly RunnerStartKey[];
  roles: Readonly<Record<string, readonly string[]>>;
  env?: Record<string, string | undefined>;
  /** The commit the job runs, in place of the forge's variable. */
  commit?: string;
  readFile?: (path: string) => string;
  maxAgeSeconds?: number;
  now?: Date;
}): RunnerStartVerdict {
  const env = input.env ?? process.env;
  const named = ciJobFromEnv(env);
  if (!named.ok) return { status: "missing", reason: `no job to check a runner-start statement for: ${named.reason}` };
  const job = input.commit ? { ...named.job, commit: input.commit } : named.job;
  return verifyRunnerStart({
    envelope: readRunnerStart(env, input.readFile),
    job,
    runners: input.runners,
    roles: input.roles,
    ...(input.maxAgeSeconds !== undefined ? { maxAgeSeconds: input.maxAgeSeconds } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}
