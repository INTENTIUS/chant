/**
 * The apply-job guard (#4624): the first step of each op-wave job checks
 * that the job runs where the spec set it to run, and stops it otherwise,
 * before any token is traded and before the checkout.
 *
 * What the job is expected to see is written into the job when the pipeline
 * is rendered, as JSON in {@link JOB_GUARD_ENV}: the guard reads no file of
 * the commit it runs on. What it sees comes from the forge:
 *
 *   forge environment  GitHub: the `environment` claim of an OIDC token the
 *                      guard requests for its own audience
 *                      ({@link JOB_GUARD_AUDIENCE}), decodes and drops. GitHub
 *                      sets no variable with the job's environment, so a job
 *                      that may request no token is not checked for it.
 *                      GitLab: CI_ENVIRONMENT_NAME. Forgejo has no
 *                      environments: not checked.
 *   ref                GitHub and Forgejo: GITHUB_REF is refs/heads/<branch>
 *                      for one of the branches the waves apply from. GitLab:
 *                      CI_COMMIT_REF_NAME is one of them, and
 *                      CI_COMMIT_REF_PROTECTED is "true". With
 *                      `defaultBranch` (#5032) the repository's default
 *                      branch is one of them, by the name the forge gives
 *                      at run time: GitLab's CI_DEFAULT_BRANCH, and on
 *                      GitHub and Forgejo CHANT_DEFAULT_BRANCH, which the
 *                      job sets from github.event.repository.default_branch.
 *   runner             GitLab: CI_RUNNER_TAGS holds each of the job's tags.
 *                      GitHub and Forgejo expose no labels, only whether the
 *                      runner is self-hosted: when the job's labels include
 *                      `self-hosted`, the token's runner_environment claim,
 *                      else RUNNER_ENVIRONMENT, is `self-hosted`. Neither
 *                      set: not checked.
 *
 * The generated step runs {@link jobGuardLine}: `node -e` from `/`, as the
 * cloud trade does, so no file of the checkout is in reach and the guard
 * needs nothing installed. `chant ci check-job` (and so a product's bin,
 * `plywood ci check-job`, `terragucci ci check-job`) runs the same check
 * from the same variable, through {@link checkJob}, for a product that
 * renders its own jobs. The lines name the product from its words.
 *
 * A refusal exits chant's `misplaced` (9), as does a variable the guard
 * cannot read. GitLab's op-wave jobs allow exit 1 as a failure the next wave
 * runs after, and 9 is outside that set, so a refused job fails and the
 * waves after it stop.
 *
 * The guard catches a hand edit, a dropped `environment:` or a mistyped
 * label. Someone who can edit the workflow can delete it too: the forge's
 * environment and runner settings and the cloud role's trust are what keep
 * a job out.
 *
 * Before merge (#4984): a waves workflow with a before-merge mode carries
 * `beforeMerge: { op }`. A run started for an open pull request's head
 * names it in `CHANT_BEFORE_MERGE_PR`, `CHANT_BEFORE_MERGE_HEAD` and
 * `CHANT_BEFORE_MERGE_DIGEST` (./op/before-merge.ts), and still runs on one
 * of the spec's branches. The guard then fetches `chant/lifecycle` into a
 * directory of its own, with the job's token (GitHub and Forgejo
 * `GITHUB_TOKEN`, GitLab `CI_JOB_TOKEN`), reads the decision for that head,
 * and admits the run only when the pull request and the digest are the
 * decision's and the decision's fields still give its digest. A job of a
 * workflow without the mode refuses any run that names a head.
 *
 * A follow-on run (#4992, ./op/follow-on-run.ts): a job of a `rest` wave
 * carries `rest: <its wave number>`. A run the rest wave's record job
 * started names a later wave in `CHANT_WAVES_WAVE`, with the same decision
 * (admitted as above, so a follow-on for another head or digest is refused)
 * or, for a push, the pushed commit in `CHANT_WAVES_COMMIT`. The guard
 * admits it only in a job of the rest wave and only for a wave after it; any
 * other job refuses a run that names either variable.
 *
 * #4998: and only for the wave the newest record job of its chain started.
 * The guard reads the follow-on records of the op (`_waves/<op>.follow-on.json`
 * on `chant/lifecycle`, as it reads the decisions) and admits the run when
 * the entry for its decided head, or a push's commit, names the run's wave
 * and, before merge, the run's decision digest. A wave started by hand past
 * the one the chain reached is refused, though each wave's gate would ask.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunnerGroup, type CiRunner } from "./ci-jobs";
import { CHANT_EXIT } from "./exit-codes";
import { BEFORE_MERGE_DIGEST_ENV, BEFORE_MERGE_HEAD_ENV, BEFORE_MERGE_PR_ENV, beforeMergePath, beforeMergeProblems, beforeMergeRunFromEnv, isBeforeMergeRun, parseBeforeMerge, type BeforeMergeRecord, type BeforeMergeRun } from "./op/before-merge";
import { followOnPath, followOnProblems, followOnRecordProblems, followOnRunFromEnv, OP_WAVES_COMMIT_ENV, OP_WAVES_WAVE_ENV, parseFollowOn, type FollowOnRecord, type FollowOnRun } from "./op/follow-on-run";

/** The variable the generated step carries its expectation in. */
export const JOB_GUARD_ENV = "CHANT_JOB_GUARD";

/**
 * The variable a GitHub or Forgejo job carries the repository's default
 * branch in (#5032), from `github.event.repository.default_branch`. GitLab
 * sets `CI_DEFAULT_BRANCH` itself.
 */
export const JOB_DEFAULT_BRANCH_ENV = "CHANT_DEFAULT_BRANCH";

/** The job variable that sets {@link JOB_DEFAULT_BRANCH_ENV} on GitHub and Forgejo (#5032). */
export const GITHUB_DEFAULT_BRANCH_ENV: Record<string, string> = { [JOB_DEFAULT_BRANCH_ENV]: "${{ github.event.repository.default_branch }}" };

/** The audience of the token the guard requests on GitHub, which no cloud role should trust. */
export const JOB_GUARD_AUDIENCE = "chant-check-job";

export type JobGuardForge = "github" | "gitlab" | "forgejo";

/** Where a job is expected to run, as the step carries it. */
export interface JobGuardSpec {
  forge: JobGuardForge;
  /** The job, as the lines name it: `wave 2 (prod) of deploy`. */
  job: string;
  /** The product the lines speak for (`chant`, `plywood`). Default `chant`. */
  product?: string;
  /** The forge environment the job runs in. Unset: not checked. */
  forgeEnvironment?: string;
  /** The branches the job may run from. */
  branches: string[];
  /** The job may also run from the repository's default branch, by the name the forge gives at run time (#5032). */
  defaultBranch?: true;
  /** GitLab: the tags the job's runner must carry. */
  runnerTags?: string[];
  /** GitHub and Forgejo: the runner must be self-hosted. */
  selfHosted?: boolean;
  /** The waves have a before-merge mode (#4984): a run that names a head runs only as op `op`'s recorded decision. */
  beforeMerge?: { op: string };
  /** The job is one of the `rest` wave's (#4992), rendered as this wave: a follow-on run may name a later one. */
  rest?: number;
}

/** What the job sees. Undefined: the forge did not say. */
export interface JobSeen {
  /** The job's forge environment; null when the job runs in none. */
  forgeEnvironment?: string | null;
  /** Why the forge environment could not be read, when it could not. */
  forgeEnvironmentError?: string;
  ref?: string;
  refProtected?: string;
  /** The repository's default branch, as the forge names it (#5032). Read only when the spec has `defaultBranch`. */
  defaultBranch?: string;
  runnerTags?: string[];
  runnerEnvironment?: string;
  /** The decision the run names (#4984), from its variables. */
  beforeMerge?: BeforeMergeRun;
  /** The recorded decision for that head; null when there is none. Read only when the spec has a before-merge mode. */
  beforeMergeRecord?: BeforeMergeRecord | null;
  /** Why the decisions could not be read, when they could not. */
  beforeMergeError?: string;
  /** The follow-on variables the run names (#4992). */
  followOn?: FollowOnRun;
  /** The follow-on record of the run's chain (#4998); null when there is none. Read only for a follow-on the rest wave's job would admit. */
  followOnRecord?: FollowOnRecord | null;
  /** Why the follow-on records could not be read, when they could not. */
  followOnError?: string;
}

export interface JobGuardResult {
  /** One line per value that does not match, naming the expected and found values. */
  problems: string[];
  /** What was checked and matched. */
  checked: string[];
  /** What the forge does not expose, so was not checked. */
  skipped: string[];
}

/** What a generator knows about one job. */
export interface JobGuardInput {
  forge: JobGuardForge;
  job: string;
  product?: string;
  /** The forge environment's name, when the job has one. */
  environment?: string;
  /** The branches the job runs from. */
  branches: readonly string[];
  /** The job also runs from the repository's default branch, whatever the forge calls it (#5032). */
  defaultBranch?: boolean;
  /** The job's runner, as the spec gives it. */
  runner?: CiRunner;
  /** GitHub: the job may request an OIDC token (`id-token: write`), so the guard can read its environment. */
  idToken?: boolean;
  /** The waves' before-merge mode (#4984), with the op its decisions are recorded under. */
  beforeMerge?: { op: string };
  /** The job is one of the `rest` wave's (#4992), whose number this is. */
  rest?: number;
}

/**
 * The expectation a generator writes into a job. GitHub checks the forge
 * environment only in a job that may request a token; Forgejo never does.
 */
export function jobGuardSpec(input: JobGuardInput): JobGuardSpec {
  const labels = input.runner === undefined ? [] : typeof input.runner === "string" ? [input.runner] : isRunnerGroup(input.runner) ? [...(input.runner.labels ?? [])] : [...input.runner];
  const readsEnvironment = input.forge === "gitlab" || (input.forge === "github" && input.idToken === true);
  return {
    forge: input.forge,
    job: input.job,
    ...(input.product && input.product !== "chant" ? { product: input.product } : {}),
    ...(input.environment !== undefined && readsEnvironment ? { forgeEnvironment: input.environment } : {}),
    branches: [...input.branches],
    ...(input.defaultBranch === true ? { defaultBranch: true as const } : {}),
    ...(input.forge === "gitlab" && labels.length > 0 ? { runnerTags: labels } : {}),
    ...(input.forge !== "gitlab" && labels.includes("self-hosted") ? { selfHosted: true } : {}),
    ...(input.beforeMerge ? { beforeMerge: { op: input.beforeMerge.op } } : {}),
    ...(input.rest !== undefined ? { rest: input.rest } : {}),
  };
}

/** Read {@link JOB_GUARD_ENV}'s JSON, refusing one that is not a guard spec. */
export function parseJobGuardSpec(raw: string | undefined): JobGuardSpec {
  if (raw === undefined || raw.trim() === "") throw new Error(`${JOB_GUARD_ENV} is not set; the generated step carries the job's expectation in it`);
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error(`${JOB_GUARD_ENV} is not JSON`);
  }
  const o = v as Partial<JobGuardSpec> | null;
  if (!o || typeof o !== "object") throw new Error(`${JOB_GUARD_ENV} is not an object`);
  if (o.forge !== "github" && o.forge !== "gitlab" && o.forge !== "forgejo") throw new Error(`${JOB_GUARD_ENV}.forge is ${JSON.stringify(o.forge)}; give github, gitlab or forgejo`);
  if (typeof o.job !== "string" || o.job === "") throw new Error(`${JOB_GUARD_ENV}.job names no job`);
  if (!Array.isArray(o.branches) || o.branches.some((b) => typeof b !== "string")) throw new Error(`${JOB_GUARD_ENV}.branches is not a list of branches`);
  if (o.defaultBranch !== undefined && o.defaultBranch !== true) throw new Error(`${JOB_GUARD_ENV}.defaultBranch is true or absent`);
  if (o.forgeEnvironment !== undefined && typeof o.forgeEnvironment !== "string") throw new Error(`${JOB_GUARD_ENV}.forgeEnvironment is not a name`);
  if (o.runnerTags !== undefined && (!Array.isArray(o.runnerTags) || o.runnerTags.some((t) => typeof t !== "string"))) throw new Error(`${JOB_GUARD_ENV}.runnerTags is not a list of tags`);
  if (o.beforeMerge !== undefined && (typeof o.beforeMerge !== "object" || o.beforeMerge === null || typeof o.beforeMerge.op !== "string")) throw new Error(`${JOB_GUARD_ENV}.beforeMerge is { op }`);
  if (o.rest !== undefined && (!Number.isInteger(o.rest) || o.rest < 1)) throw new Error(`${JOB_GUARD_ENV}.rest is the rest wave's number`);
  return o as JobGuardSpec;
}

const shown = (v: string | null | undefined): string => (v === undefined || v === null || v === "" ? "none" : v);

/** The variable the guard reads the default branch from (#5032). */
const defaultBranchVar = (forge: JobGuardForge): string => (forge === "gitlab" ? "CI_DEFAULT_BRANCH" : JOB_DEFAULT_BRANCH_ENV);

/** The tags CI_RUNNER_TAGS lists: a JSON array, or a comma-separated list. */
export function runnerTagsOf(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t.startsWith("[")) {
    try {
      const v = JSON.parse(t) as unknown;
      if (Array.isArray(v)) return v.map(String);
    } catch {
      // fall through to the plain list
    }
  }
  return t === "" ? [] : t.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/** A JWT's claims, without checking its signature: the token came from the forge a moment ago and is used for nothing else. */
export function tokenClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new Error("the forge's OIDC token is not a JWT");
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  const claims = JSON.parse(json) as unknown;
  if (!claims || typeof claims !== "object") throw new Error("the forge's OIDC token has no claims");
  return claims as Record<string, unknown>;
}

/** Compare what the job sees with what the spec expects. */
export function checkJob(expect: JobGuardSpec, seen: JobSeen): JobGuardResult {
  const out: JobGuardResult = { problems: [], checked: [], skipped: [] };
  const fe = expect.forgeEnvironment;
  if (expect.forge === "forgejo") out.skipped.push("forge environment (Forgejo has none)");
  else if (fe !== undefined) {
    if (seen.forgeEnvironmentError !== undefined) out.problems.push(`forge environment: expected ${fe}, and it could not be read: ${seen.forgeEnvironmentError}`);
    else if (seen.forgeEnvironment !== fe) out.problems.push(`forge environment: expected ${fe}, found ${shown(seen.forgeEnvironment)}`);
    else out.checked.push(`forge environment ${fe}`);
  }

  // #5032: the repository's default branch, by the name the forge gives this run, beside the named ones.
  const named = expect.branches.filter((b) => b !== "");
  const def = expect.defaultBranch ? (seen.defaultBranch ?? "").trim() : "";
  const branches = def !== "" && !named.includes(def) ? [def, ...named] : named;
  if (branches.length === 0) out.problems.push(expect.defaultBranch ? `ref: the job runs from the default branch, and the forge names none (no ${defaultBranchVar(expect.forge)})` : "ref: the job names no branch to run from");
  else if (expect.forge === "gitlab") {
    if (!seen.ref || !branches.includes(seen.ref)) out.problems.push(`ref: expected ${branches.join(" or ")}, found ${shown(seen.ref)}`);
    else out.checked.push(`ref ${seen.ref}`);
    if (seen.refProtected !== "true") out.problems.push(`ref: expected a protected ref (CI_COMMIT_REF_PROTECTED true), found ${shown(seen.refProtected)}`);
    else out.checked.push("protected ref");
  } else {
    const refs = branches.map((b) => `refs/heads/${b}`);
    if (!seen.ref || !refs.includes(seen.ref)) out.problems.push(`ref: expected ${refs.join(" or ")}, found ${shown(seen.ref)}`);
    else out.checked.push(`ref ${seen.ref}`);
  }

  // #4984: a run started for an open pull request's head runs only as the decision recorded for it.
  const run = seen.beforeMerge;
  if (run && isBeforeMergeRun(run)) {
    if (!expect.beforeMerge) out.problems.push(`before merge: the run names pull request ${run.pr ?? "none"}'s head ${run.head ?? "none"}, and this job applies only the pushes to its branches`);
    else if (seen.beforeMergeError !== undefined) out.problems.push(`before merge: the decisions on chant/lifecycle could not be read: ${seen.beforeMergeError}`);
    else {
      const problems = beforeMergeProblems(expect.beforeMerge.op, run, seen.beforeMergeRecord ?? undefined);
      if (problems.length > 0) out.problems.push(...problems);
      else out.checked.push(`before merge: pull request ${run.pr}'s decided head ${run.head!.slice(0, 12)}`);
    }
  }

  // #4992: a follow-on run of the rest wave, admitted in the rest wave's jobs alone and for a later wave.
  const bmRun = run !== undefined && isBeforeMergeRun(run);
  const follow = followOnProblems(expect.rest, seen.followOn ?? {}, bmRun);
  out.problems.push(...follow.problems);
  if (follow.checked) {
    // #4998: and only for the wave the newest record job of its chain started.
    const key = (bmRun ? run!.head : seen.followOn?.commit) ?? "";
    const rec = !expect.beforeMerge
      ? ["follow-on: this job names no op whose follow-on records it reads, so it admits no follow-on"]
      : seen.followOnError !== undefined
        ? [`follow-on: the follow-on records on chant/lifecycle could not be read: ${seen.followOnError}`]
        : followOnRecordProblems(expect.beforeMerge.op, seen.followOn!.wave!, key, bmRun ? (run!.digest ?? "") : undefined, seen.followOnRecord);
    if (rec.length > 0) out.problems.push(...rec);
    else out.checked.push(follow.checked);
  }

  if (expect.forge === "gitlab") {
    const want = expect.runnerTags ?? [];
    if (want.length > 0) {
      const have = seen.runnerTags;
      const missing = want.filter((t) => !(have ?? []).includes(t));
      if (have === undefined) out.problems.push(`runner: expected tags ${want.join(", ")}, and the job has no CI_RUNNER_TAGS`);
      else if (missing.length > 0) out.problems.push(`runner: expected tags ${want.join(", ")}, found ${have.length ? have.join(", ") : "none"}`);
      else out.checked.push(`runner tags ${want.join(", ")}`);
    }
  } else if (expect.selfHosted) {
    if (seen.runnerEnvironment === undefined) out.skipped.push("runner (the runner says nothing about itself: no RUNNER_ENVIRONMENT)");
    else if (seen.runnerEnvironment !== "self-hosted") out.problems.push(`runner: expected self-hosted, found ${seen.runnerEnvironment}`);
    else out.checked.push("self-hosted runner");
  }
  return out;
}

/** Ask GitHub for an OIDC token for {@link JOB_GUARD_AUDIENCE} and return its claims; the token itself is dropped. */
async function githubClaims(env: NodeJS.ProcessEnv, fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error("the job may request no OIDC token (no ACTIONS_ID_TOKEN_REQUEST_URL); it needs the id-token: write permission");
  const r = await fetchFn(`${url}&audience=${encodeURIComponent(JOB_GUARD_AUDIENCE)}`, { headers: { authorization: `bearer ${bearer}` } });
  if (!r.ok) throw new Error(`the OIDC token request answered ${r.status}`);
  const value = ((await r.json()) as { value?: unknown }).value;
  if (typeof value !== "string") throw new Error("the OIDC token request answered no token");
  return tokenClaims(value);
}

/** What the job sees, from the forge's variables, and on GitHub from its token's claims when the forge environment is to be checked. */
export async function jobSeen(expect: JobGuardSpec, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch, readLifecycle: LifecycleFileReader = lifecycleFileByGit): Promise<JobSeen> {
  const seen = await forgeSeen(expect, env, fetchFn);
  // #4992: the follow-on variables, whatever else the run names.
  const follow = followOnRunFromEnv(env);
  if (follow.wave !== undefined || follow.commit !== undefined) seen.followOn = follow;
  // #4984: the decision a run names, read only when the spec has a before-merge mode.
  const run = beforeMergeRunFromEnv(env);
  const bm = isBeforeMergeRun(run);
  if (bm) {
    seen.beforeMerge = run;
    if (expect.beforeMerge && run.head) {
      try {
        const text = readLifecycle(expect.forge, env, beforeMergePath(expect.beforeMerge.op));
        seen.beforeMergeRecord = parseBeforeMerge(text).heads[run.head] ?? null;
      } catch (e) {
        seen.beforeMergeError = (e as Error).message;
      }
    }
  }
  // #4998: the record of the run's chain, read only for a follow-on the rest wave's job would admit.
  const key = bm ? run.head : follow.commit;
  if (expect.beforeMerge && key && followOnProblems(expect.rest, follow, bm).checked !== undefined) {
    try {
      seen.followOnRecord = parseFollowOn(readLifecycle(expect.forge, env, followOnPath(expect.beforeMerge.op))).chains[key] ?? null;
    } catch (e) {
      seen.followOnError = (e as Error).message;
    }
  }
  return seen;
}

/** Reads one file of `chant/lifecycle` as the remote has it; null when the branch has no such file (#4984). */
export type LifecycleFileReader = (forge: JobGuardForge, env: NodeJS.ProcessEnv, path: string) => string | null;

/** The repository's git URL and the job token's basic credentials, as the guard fetches with them (#4984). */
export function guardRemote(forge: JobGuardForge, env: NodeJS.ProcessEnv): { url: string; user: string; token: string } {
  if (forge === "gitlab") {
    if (!env.CI_SERVER_URL || !env.CI_PROJECT_PATH) throw new Error("the job names no repository (no CI_SERVER_URL or CI_PROJECT_PATH)");
    return { url: `${env.CI_SERVER_URL.replace(/\/+$/, "")}/${env.CI_PROJECT_PATH}.git`, user: "gitlab-ci-token", token: env.CI_JOB_TOKEN ?? "" };
  }
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY) throw new Error("the job names no repository (no GITHUB_SERVER_URL or GITHUB_REPOSITORY)");
  return { url: `${env.GITHUB_SERVER_URL.replace(/\/+$/, "")}/${env.GITHUB_REPOSITORY}.git`, user: "x-access-token", token: env.GITHUB_TOKEN ?? "" };
}

/**
 * {@link LifecycleFileReader} through git: `chant/lifecycle` fetched at depth
 * one into a directory of the guard's own, outside the checkout, with the
 * token as a basic credential header, and the file shown from it. The
 * `node -e` program does the same.
 */
export const lifecycleFileByGit: LifecycleFileReader = (forge, env, path) => {
  const remote = guardRemote(forge, env);
  const dir = mkdtempSync(join(tmpdir(), "chant-guard-"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf-8", env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
  const init = git(["init", "-q"]);
  if (init.status !== 0) throw new Error(`git init failed: ${(init.stderr || "").trim()}`);
  const auth = `Authorization: Basic ${Buffer.from(`${remote.user}:${remote.token}`).toString("base64")}`;
  const fetched = git(["-c", `http.extraHeader=${auth}`, "fetch", "-q", "--depth=1", remote.url, "refs/heads/chant/lifecycle"]);
  if (fetched.status !== 0) throw new Error(`could not fetch chant/lifecycle: ${(fetched.stderr || "").trim().split("\n").pop()}`);
  const shown = git(["show", `FETCH_HEAD:${path}`]);
  return shown.status === 0 ? shown.stdout : null;
};

/** What the forge's own variables and token say, before the decision is read. */
async function forgeSeen(expect: JobGuardSpec, env: NodeJS.ProcessEnv, fetchFn: typeof fetch): Promise<JobSeen> {
  // #5032: the default branch, read only when the spec runs from it.
  const def = expect.defaultBranch ? env[defaultBranchVar(expect.forge)] : undefined;
  const defaultBranch = def !== undefined && def.trim() !== "" ? { defaultBranch: def.trim() } : {};
  if (expect.forge === "gitlab") {
    return {
      ...defaultBranch,
      forgeEnvironment: env.CI_ENVIRONMENT_NAME || null,
      ...(env.CI_COMMIT_REF_NAME !== undefined ? { ref: env.CI_COMMIT_REF_NAME } : {}),
      ...(env.CI_COMMIT_REF_PROTECTED !== undefined ? { refProtected: env.CI_COMMIT_REF_PROTECTED } : {}),
      ...(env.CI_RUNNER_TAGS !== undefined ? { runnerTags: runnerTagsOf(env.CI_RUNNER_TAGS) } : {}),
    };
  }
  const seen: JobSeen = { ...(env.GITHUB_REF !== undefined ? { ref: env.GITHUB_REF } : {}), ...defaultBranch };
  let claims: Record<string, unknown> | undefined;
  if (expect.forge === "github" && expect.forgeEnvironment !== undefined) {
    try {
      claims = await githubClaims(env, fetchFn);
      seen.forgeEnvironment = typeof claims.environment === "string" && claims.environment !== "" ? claims.environment : null;
    } catch (e) {
      seen.forgeEnvironmentError = (e as Error).message;
    }
  }
  const runner = typeof claims?.runner_environment === "string" ? claims.runner_environment : env.RUNNER_ENVIRONMENT;
  if (runner) seen.runnerEnvironment = runner;
  return seen;
}

/** The lines the guard prints, and whether the job may go on. */
export function describeJobGuard(expect: JobGuardSpec, result: JobGuardResult): { ok: boolean; out: string[]; err: string[] } {
  const at = `${expect.product ?? "chant"} check-job: ${expect.job}`;
  if (result.problems.length > 0) {
    return {
      ok: false,
      out: [],
      err: [...result.problems.map((p) => `${at}: ${p}`), `${at}: this job does not run where the spec set it to run, so it stops before any credential is taken or code checked out`],
    };
  }
  const skipped = result.skipped.length ? `; not checked: ${result.skipped.join(", ")}` : "";
  return { ok: true, out: [`${at}: ${result.checked.length ? result.checked.join(", ") : "nothing to check"}${skipped}`], err: [] };
}

/**
 * The before-merge part of the `node -e` program (#4984): the run's three
 * variables, the read of `chant/lifecycle` as {@link lifecycleFileByGit}
 * does it, the decision entry as {@link parseBeforeMerge} keeps it, and the
 * lines of {@link beforeMergeProblems}, digest included. No single quote,
 * since the program is one shell word in single quotes.
 */
const BM_PATH = beforeMergePath("\u0000").split("\u0000") as [string, string];
/** Each apostrophe in the program's strings as `'`, since the whole program is one single-quoted shell word. */
const noQuote = (s: string): string => s.replace(/'/g, "\\u0027");
const BEFORE_MERGE_JS = [
  `const bmV=[${JSON.stringify(BEFORE_MERGE_PR_ENV)},${JSON.stringify(BEFORE_MERGE_HEAD_ENV)},${JSON.stringify(BEFORE_MERGE_DIGEST_ENV)}].map((k)=>String(E[k]||"").trim());`,
  'const bmRun={};if(bmV[0])bmRun.pr=bmV[0];if(bmV[1])bmRun.head=bmV[1];if(bmV[2])bmRun.digest=bmV[2];const bmOn=Boolean(bmV[0]||bmV[1]||bmV[2]);',
  "const SHA=/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;",
  String.raw`const bmRead=(file)=>{const cp=require("child_process"),fs=require("fs"),os=require("os"),pa=require("path");let url,user,tok;`,
  String.raw`if(x.forge==="gitlab"){if(!E.CI_SERVER_URL||!E.CI_PROJECT_PATH)throw new Error("the job names no repository (no CI_SERVER_URL or CI_PROJECT_PATH)");url=E.CI_SERVER_URL.replace(/\/+$/,"")+"/"+E.CI_PROJECT_PATH+".git";user="gitlab-ci-token";tok=E.CI_JOB_TOKEN||""}`,
  String.raw`else{if(!E.GITHUB_SERVER_URL||!E.GITHUB_REPOSITORY)throw new Error("the job names no repository (no GITHUB_SERVER_URL or GITHUB_REPOSITORY)");url=E.GITHUB_SERVER_URL.replace(/\/+$/,"")+"/"+E.GITHUB_REPOSITORY+".git";user="x-access-token";tok=E.GITHUB_TOKEN||""}`,
  String.raw`const d=fs.mkdtempSync(pa.join(os.tmpdir(),"chant-guard-"));const g=(a)=>cp.spawnSync("git",a,{cwd:d,encoding:"utf-8",env:Object.assign({},E,{GIT_TERMINAL_PROMPT:"0"})});`,
  String.raw`const i=g(["init","-q"]);if(i.status!==0)throw new Error("git init failed: "+String(i.stderr||"").trim());`,
  String.raw`const f=g(["-c","http.extraHeader=Authorization: Basic "+Buffer.from(user+":"+tok).toString("base64"),"fetch","-q","--depth=1",url,"refs/heads/chant/lifecycle"]);`,
  String.raw`if(f.status!==0)throw new Error("could not fetch chant/lifecycle: "+String(f.stderr||"").trim().split("\n").pop());`,
  String.raw`const o=g(["show","FETCH_HEAD:"+file]);return o.status===0?o.stdout:null};`,
  String.raw`const bmEntry=(t,h)=>{let v;try{v=JSON.parse(t===null?"null":t)}catch(e){return null}const hs=v&&typeof v==="object"&&v.version===1?v.heads:undefined;if(!hs||typeof hs!=="object"||!SHA.test(h))return null;const e=hs[h];`,
  String.raw`if(!e||typeof e!=="object"||e.head!==h||!Number.isInteger(e.pr)||e.pr<1||typeof e.base!=="string"||!SHA.test(e.base)||typeof e.at!=="string"||typeof e.by!=="string"||typeof e.digest!=="string")return null;`,
  String.raw`if(e.through!==undefined&&(!Number.isInteger(e.through)||e.through<1))return null;const r={pr:e.pr,head:h,base:e.base,at:e.at,by:e.by,digest:e.digest};if(e.through!==undefined)r.through=e.through;return r};`,
  `const bmSeen=(s)=>{if(!bmOn)return s;s.beforeMerge=bmRun;if(!x.beforeMerge||!bmRun.head)return s;try{s.rec=bmEntry(bmRead(${JSON.stringify(BM_PATH[0])}+x.beforeMerge.op+${JSON.stringify(BM_PATH[1])}),bmRun.head)}catch(e){s.bmErr=e&&e.message?e.message:String(e)}return s};`,
  'const shownJ=(v)=>v===undefined||v===""?"none":JSON.stringify(v);',
  String.raw`const bmProblems=(op,r,rec)=>{const p=[];if(!r.pr||!/^[1-9][0-9]{0,9}$/.test(r.pr))p.push("before merge: the run's pull request "+shownJ(r.pr)+" is not a number");`,
  String.raw`if(!r.head||!SHA.test(r.head))p.push("before merge: the run's head "+shownJ(r.head)+" is not a commit sha");`,
  String.raw`if(!r.digest||!/^sha256:[0-9a-f]{64}$/.test(r.digest))p.push("before merge: the run's digest "+shownJ(r.digest)+" is not a sha256 digest");`,
  String.raw`if(p.length)return p;const h=r.head.slice(0,12);if(!rec)return["before merge: no decision on chant/lifecycle names head "+h+" of "+op+", so this run applies nothing"];`,
  String.raw`if(rec.pr!==Number(r.pr))p.push("before merge: the decision for head "+h+" is pull request "+rec.pr+"'s, not "+r.pr+"'s");`,
  String.raw`if(rec.digest!==r.digest)p.push("before merge: the run carries digest "+r.digest+", and the decision for head "+h+" has "+rec.digest);`,
  String.raw`const dg="sha256:"+require("crypto").createHash("sha256").update(JSON.stringify(["chant-before-merge/1",op,rec.pr,rec.head,rec.base,rec.through===undefined?0:rec.through,rec.at,rec.by])).digest("hex");`,
  String.raw`if(dg!==rec.digest)p.push("before merge: the decision for head "+h+" was changed after it was made: its fields give another digest");return p};`,
].map(noQuote);

const FO_PATH = followOnPath("\u0000").split("\u0000") as [string, string];
/**
 * The follow-on part of the program (#4992): the run's two variables and the lines of {@link followOnProblems}, and
 * (#4998) the read of the chain's record and the lines of {@link followOnRecordProblems}. After {@link BEFORE_MERGE_JS},
 * whose `SHA`, `bmRead` and decision variables it reads.
 */
const FOLLOW_ON_JS = [
  `const foV=[${JSON.stringify(OP_WAVES_WAVE_ENV)},${JSON.stringify(OP_WAVES_COMMIT_ENV)}].map((k)=>String(E[k]||"").trim());const foRun={};if(foV[0])foRun.wave=foV[0];if(foV[1])foRun.commit=foV[1];`,
  String.raw`const foProblems=(rest,r,bm)=>{const w=r.wave,c=r.commit;`,
  String.raw`if(rest===undefined){if(w===undefined&&c===undefined)return{p:[]};return{p:["follow-on: the run names wave "+(w===undefined?"none":w)+" and commit "+(c===undefined?"none":c)+", and this job is none of the rest wave's, which alone runs in a follow-on"]}}`,
  String.raw`if(w===undefined||w===String(rest)){if(c===undefined)return{p:[]};return{p:["follow-on: the run names the commit "+c+" and no wave after wave "+rest+", so it is no follow-on"]}}`,
  String.raw`if(!/^[1-9][0-9]{0,5}$/.test(w)||Number(w)<=rest)return{p:["follow-on: the run's wave "+JSON.stringify(w)+" is no wave after wave "+rest]};`,
  String.raw`if(bm){if(c!==undefined)return{p:["follow-on: a follow-on of a decided head checks out that head, and the run names the commit "+c+" too"]};return{p:[],c:"follow-on wave "+w}}`,
  String.raw`if(c===undefined||!SHA.test(c))return{p:["follow-on: a push's follow-on names the commit it goes on with, and the run's "+(c===undefined?"none":JSON.stringify(c))+" is not a commit sha"]};`,
  String.raw`return{p:[],c:"follow-on wave "+w+" at "+c.slice(0,12)}};`,
  // #4998: the record of the run's chain, as parseFollowOn keeps an entry, and the lines of followOnRecordProblems.
  String.raw`const foEntry=(t,k)=>{let v;try{v=JSON.parse(t===null?"null":t)}catch(e){return null}const cs=v&&typeof v==="object"&&v.version===1?v.chains:undefined;if(!cs||typeof cs!=="object"||!SHA.test(k))return null;const e=cs[k];const W=(n,m)=>Number.isInteger(n)&&n>=m;`,
  String.raw`if(!e||typeof e!=="object"||e.key!==k||!W(e.wave,2)||!W(e.from,1)||typeof e.run!=="string"||typeof e.at!=="string")return null;`,
  String.raw`if((e.digest!==undefined&&typeof e.digest!=="string")||(e.pr!==undefined&&!W(e.pr,1))||(e.commit!==undefined&&(typeof e.commit!=="string"||!SHA.test(e.commit)))||!e.outcomes||typeof e.outcomes!=="object")return null;return e};`,
  `const foSeen=(s)=>{const k=bmOn?bmRun.head:foRun.commit;if(!x.beforeMerge||!k||foProblems(x.rest,foRun,bmOn).c===undefined)return s;try{s.foRec=foEntry(bmRead(${JSON.stringify(FO_PATH[0])}+x.beforeMerge.op+${JSON.stringify(FO_PATH[1])}),k)}catch(e){s.foErr=e&&e.message?e.message:String(e)}return s};`,
  String.raw`const foRecProblems=(op,w,k,dg,rec)=>{const what=dg!==undefined?"head":"commit";const sh=k.slice(0,12);if(!rec)return["follow-on: no record job of "+op+" started a follow-on for "+what+" "+sh+", so this run applies nothing"];const p=[];`,
  String.raw`if(String(rec.wave)!==w)p.push("follow-on: the newest record job of "+op+" for "+what+" "+sh+" started wave "+rec.wave+", and this run names wave "+w);`,
  String.raw`if(dg!==undefined&&rec.digest!==dg)p.push("follow-on: wave "+rec.wave+" of "+what+" "+sh+" was started for the decision with digest "+(rec.digest===undefined?"none":rec.digest)+", and the run carries "+dg);return p};`,
].map(noQuote);

/**
 * The guard as one `node -e` program: the same checks as {@link checkJob},
 * {@link jobSeen} and {@link describeJobGuard}, reading {@link JOB_GUARD_ENV}.
 * Exits chant's `misplaced` (9) with one line per value that differs, and
 * when the variable holds no spec it can read. A test runs it against
 * {@link checkJob} so the two stay the same.
 *
 * `defaultBranch` (#5032) gives the program that also reads the default
 * branch, for a spec with `defaultBranch`; a job without it carries the
 * program as it was.
 */
function jobGuardProgram(defaultBranch: boolean): string {
  const branchLines = defaultBranch
    ? [
        `const b=x.branches.filter((v)=>v!=="");const DV=x.forge==="gitlab"?"CI_DEFAULT_BRANCH":${JSON.stringify(JOB_DEFAULT_BRANCH_ENV)};const D=x.defaultBranch?String(E[DV]||"").trim():"";if(D!==""&&!b.includes(D))b.unshift(D);`,
        'if(b.length===0)P.push(x.defaultBranch?"ref: the job runs from the default branch, and the forge names none (no "+DV+")":"ref: the job names no branch to run from");',
      ]
    : ['const b=x.branches.filter((v)=>v!=="");', 'if(b.length===0)P.push("ref: the job names no branch to run from");'];
  return [
  '"use strict";',
  `const E=process.env,A=${JSON.stringify(JOB_GUARD_AUDIENCE)};`,
  "const shown=(v)=>v===undefined||v===null||v===\"\"?\"none\":v;",
  `const fail=(m)=>{console.error("check-job: "+m);process.exit(${CHANT_EXIT.misplaced})};`,
  "let x;try{x=JSON.parse(E." + JOB_GUARD_ENV + "||\"\")}catch(e){fail(\"" + JOB_GUARD_ENV + " is not JSON\")}",
  "if(!x||![\"github\",\"gitlab\",\"forgejo\"].includes(x.forge)||!Array.isArray(x.branches))fail(\"" + JOB_GUARD_ENV + " is not a guard spec\");",
  'const tags=(r)=>{if(r===undefined)return undefined;const t=r.trim();if(t.startsWith("[")){try{const v=JSON.parse(t);if(Array.isArray(v))return v.map(String)}catch(e){}}return t===""?[]:t.split(",").map((s)=>s.trim()).filter((s)=>s!=="")};',
  'const claimsOf=(tok)=>{const p=tok.split(".")[1];if(!p)throw new Error("the forge\\u0027s OIDC token is not a JWT");const c=JSON.parse(Buffer.from(p.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf-8"));if(!c||typeof c!=="object")throw new Error("the forge\\u0027s OIDC token has no claims");return c};',
  ...BEFORE_MERGE_JS,
  ...FOLLOW_ON_JS,
  "async function seenOf(){",
  'if(x.forge==="gitlab")return foSeen(bmSeen({forgeEnvironment:E.CI_ENVIRONMENT_NAME||null,ref:E.CI_COMMIT_REF_NAME,refProtected:E.CI_COMMIT_REF_PROTECTED,runnerTags:tags(E.CI_RUNNER_TAGS)}));',
  "const s={ref:E.GITHUB_REF};let c;",
  'if(x.forge==="github"&&x.forgeEnvironment!==undefined){try{',
  'if(!E.ACTIONS_ID_TOKEN_REQUEST_URL||!E.ACTIONS_ID_TOKEN_REQUEST_TOKEN)throw new Error("the job may request no OIDC token (no ACTIONS_ID_TOKEN_REQUEST_URL); it needs the id-token: write permission");',
  'const r=await fetch(E.ACTIONS_ID_TOKEN_REQUEST_URL+"&audience="+encodeURIComponent(A),{headers:{authorization:"bearer "+E.ACTIONS_ID_TOKEN_REQUEST_TOKEN}});',
  'if(!r.ok)throw new Error("the OIDC token request answered "+r.status);const v=(await r.json()).value;if(typeof v!=="string")throw new Error("the OIDC token request answered no token");',
  'c=claimsOf(v);s.forgeEnvironment=typeof c.environment==="string"&&c.environment!==""?c.environment:null}catch(e){s.forgeEnvironmentError=e&&e.message?e.message:String(e)}}',
  'const run=c&&typeof c.runner_environment==="string"?c.runner_environment:E.RUNNER_ENVIRONMENT;if(run)s.runnerEnvironment=run;return foSeen(bmSeen(s))}',
  "seenOf().then((s)=>{const P=[],C=[],S=[];const fe=x.forgeEnvironment;",
  'if(x.forge==="forgejo")S.push("forge environment (Forgejo has none)");',
  'else if(fe!==undefined){if(s.forgeEnvironmentError!==undefined)P.push("forge environment: expected "+fe+", and it could not be read: "+s.forgeEnvironmentError);else if(s.forgeEnvironment!==fe)P.push("forge environment: expected "+fe+", found "+shown(s.forgeEnvironment));else C.push("forge environment "+fe)}',
  ...branchLines,
  'else if(x.forge==="gitlab"){if(!s.ref||!b.includes(s.ref))P.push("ref: expected "+b.join(" or ")+", found "+shown(s.ref));else C.push("ref "+s.ref);',
  'if(s.refProtected!=="true")P.push("ref: expected a protected ref (CI_COMMIT_REF_PROTECTED true), found "+shown(s.refProtected));else C.push("protected ref")}',
  'else{const refs=b.map((v)=>"refs/heads/"+v);if(!s.ref||!refs.includes(s.ref))P.push("ref: expected "+refs.join(" or ")+", found "+shown(s.ref));else C.push("ref "+s.ref)}',
  ...[
    String.raw`if(s.beforeMerge){const r=s.beforeMerge;if(!x.beforeMerge)P.push("before merge: the run names pull request "+(r.pr||"none")+"'s head "+(r.head||"none")+", and this job applies only the pushes to its branches");`,
    String.raw`else if(s.bmErr!==undefined)P.push("before merge: the decisions on chant/lifecycle could not be read: "+s.bmErr);`,
    String.raw`else{const Q=bmProblems(x.beforeMerge.op,r,s.rec||undefined);if(Q.length)P.push(...Q);else C.push("before merge: pull request "+r.pr+"'s decided head "+r.head.slice(0,12))}}`,
  ].map(noQuote),
  "{const F=foProblems(x.rest,foRun,bmOn);P.push(...F.p);if(F.c){const G=!x.beforeMerge?[\"follow-on: this job names no op whose follow-on records it reads, so it admits no follow-on\"]:s.foErr!==undefined?[\"follow-on: the follow-on records on chant/lifecycle could not be read: \"+s.foErr]:foRecProblems(x.beforeMerge.op,foRun.wave,(bmOn?bmRun.head:foRun.commit)||\"\",bmOn?(bmRun.digest||\"\"):undefined,s.foRec);if(G.length)P.push(...G);else C.push(F.c)}}",
  'if(x.forge==="gitlab"){const w=x.runnerTags||[];if(w.length>0){const h=s.runnerTags;const miss=w.filter((t)=>!(h||[]).includes(t));',
  'if(h===undefined)P.push("runner: expected tags "+w.join(", ")+", and the job has no CI_RUNNER_TAGS");else if(miss.length>0)P.push("runner: expected tags "+w.join(", ")+", found "+(h.length?h.join(", "):"none"));else C.push("runner tags "+w.join(", "))}}',
  'else if(x.selfHosted){if(s.runnerEnvironment===undefined)S.push("runner (the runner says nothing about itself: no RUNNER_ENVIRONMENT)");else if(s.runnerEnvironment!=="self-hosted")P.push("runner: expected self-hosted, found "+s.runnerEnvironment);else C.push("self-hosted runner")}',
  'const at=(x.product||"chant")+" check-job: "+x.job;',
  'if(P.length>0){for(const p of P)console.error(at+": "+p);console.error(at+": this job does not run where the spec set it to run, so it stops before any credential is taken or code checked out");process.exit(' + CHANT_EXIT.misplaced + ")}",
  'console.log(at+": "+(C.length?C.join(", "):"nothing to check")+(S.length?"; not checked: "+S.join(", "):""))',
  "}).catch((e)=>fail(e&&e.message?e.message:String(e)));",
].join("");
}

/** The guard as one `node -e` program; see {@link jobGuardProgram}. */
export const JOB_GUARD_JS = jobGuardProgram(false);

/** The same program for a spec with `defaultBranch` (#5032), which also reads the default branch. */
export const JOB_GUARD_DEFAULT_BRANCH_JS = jobGuardProgram(true);

/**
 * The shell line of the guard step: `node -e` from `/`, so no file of the
 * checkout is in reach. #5032: a spec with `defaultBranch` gets the program
 * that reads the default branch.
 */
export function jobGuardLine(spec?: Pick<JobGuardSpec, "defaultBranch">): string {
  return `(cd / && node -e '${spec?.defaultBranch ? JOB_GUARD_DEFAULT_BRANCH_JS : JOB_GUARD_JS}')`;
}

/** How the guard's lines name an op-wave job: `wave 2 (prod) of deploy`, `share 1 of job group eu of wave 2 (prod) of deploy`. */
export function opWaveJobLabel(spec: string, job: { kind: "wave" | "decide" | "share"; wave: number; waveName: string; share?: number; group?: string }): string {
  const wave = `wave ${job.wave} (${job.waveName}) of ${spec}`;
  const share = job.share !== undefined ? `share ${job.share} of ` : "";
  if (job.kind === "decide") return `the deciding job of ${wave}`;
  if (job.group !== undefined) return `${share}job group ${job.group} of ${wave}`;
  return `${share}${wave}`;
}
