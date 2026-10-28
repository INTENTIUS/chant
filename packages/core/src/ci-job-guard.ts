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
 *                      CI_COMMIT_REF_PROTECTED is "true".
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
 * The guard catches a hand edit, a dropped `environment:` or a mistyped
 * label. Someone who can edit the workflow can delete it too: the forge's
 * environment and runner settings and the cloud role's trust are what keep
 * a job out.
 */
import { isRunnerGroup, type CiRunner } from "./ci-jobs";

/** The variable the generated step carries its expectation in. */
export const JOB_GUARD_ENV = "CHANT_JOB_GUARD";

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
  /** GitLab: the tags the job's runner must carry. */
  runnerTags?: string[];
  /** GitHub and Forgejo: the runner must be self-hosted. */
  selfHosted?: boolean;
}

/** What the job sees. Undefined: the forge did not say. */
export interface JobSeen {
  /** The job's forge environment; null when the job runs in none. */
  forgeEnvironment?: string | null;
  /** Why the forge environment could not be read, when it could not. */
  forgeEnvironmentError?: string;
  ref?: string;
  refProtected?: string;
  runnerTags?: string[];
  runnerEnvironment?: string;
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
  /** The job's runner, as the spec gives it. */
  runner?: CiRunner;
  /** GitHub: the job may request an OIDC token (`id-token: write`), so the guard can read its environment. */
  idToken?: boolean;
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
    ...(input.forge === "gitlab" && labels.length > 0 ? { runnerTags: labels } : {}),
    ...(input.forge !== "gitlab" && labels.includes("self-hosted") ? { selfHosted: true } : {}),
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
  if (o.forgeEnvironment !== undefined && typeof o.forgeEnvironment !== "string") throw new Error(`${JOB_GUARD_ENV}.forgeEnvironment is not a name`);
  if (o.runnerTags !== undefined && (!Array.isArray(o.runnerTags) || o.runnerTags.some((t) => typeof t !== "string"))) throw new Error(`${JOB_GUARD_ENV}.runnerTags is not a list of tags`);
  return o as JobGuardSpec;
}

const shown = (v: string | null | undefined): string => (v === undefined || v === null || v === "" ? "none" : v);

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

  const branches = expect.branches.filter((b) => b !== "");
  if (branches.length === 0) out.problems.push("ref: the job names no branch to run from");
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
  if (!url || !bearer) throw new Error("the job may request no OIDC token (no ACTIONS_ID_TOKEN_REQUEST_URL); it needs permissions: id-token: write");
  const r = await fetchFn(`${url}&audience=${encodeURIComponent(JOB_GUARD_AUDIENCE)}`, { headers: { authorization: `bearer ${bearer}` } });
  if (!r.ok) throw new Error(`the OIDC token request answered ${r.status}`);
  const value = ((await r.json()) as { value?: unknown }).value;
  if (typeof value !== "string") throw new Error("the OIDC token request answered no token");
  return tokenClaims(value);
}

/** What the job sees, from the forge's variables, and on GitHub from its token's claims when the forge environment is to be checked. */
export async function jobSeen(expect: JobGuardSpec, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<JobSeen> {
  if (expect.forge === "gitlab") {
    return {
      forgeEnvironment: env.CI_ENVIRONMENT_NAME || null,
      ...(env.CI_COMMIT_REF_NAME !== undefined ? { ref: env.CI_COMMIT_REF_NAME } : {}),
      ...(env.CI_COMMIT_REF_PROTECTED !== undefined ? { refProtected: env.CI_COMMIT_REF_PROTECTED } : {}),
      ...(env.CI_RUNNER_TAGS !== undefined ? { runnerTags: runnerTagsOf(env.CI_RUNNER_TAGS) } : {}),
    };
  }
  const seen: JobSeen = { ...(env.GITHUB_REF !== undefined ? { ref: env.GITHUB_REF } : {}) };
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
 * The guard as one `node -e` program: the same checks as {@link checkJob},
 * {@link jobSeen} and {@link describeJobGuard}, reading {@link JOB_GUARD_ENV}.
 * Exits 1 with one line per value that differs. A test runs it against
 * {@link checkJob} so the two stay the same.
 */
export const JOB_GUARD_JS = [
  '"use strict";',
  `const E=process.env,A=${JSON.stringify(JOB_GUARD_AUDIENCE)};`,
  "const shown=(v)=>v===undefined||v===null||v===\"\"?\"none\":v;",
  `const fail=(m)=>{console.error("check-job: "+m);process.exit(1)};`,
  "let x;try{x=JSON.parse(E." + JOB_GUARD_ENV + "||\"\")}catch(e){fail(\"" + JOB_GUARD_ENV + " is not JSON\")}",
  "if(!x||![\"github\",\"gitlab\",\"forgejo\"].includes(x.forge)||!Array.isArray(x.branches))fail(\"" + JOB_GUARD_ENV + " is not a guard spec\");",
  'const tags=(r)=>{if(r===undefined)return undefined;const t=r.trim();if(t.startsWith("[")){try{const v=JSON.parse(t);if(Array.isArray(v))return v.map(String)}catch(e){}}return t===""?[]:t.split(",").map((s)=>s.trim()).filter((s)=>s!=="")};',
  'const claimsOf=(tok)=>{const p=tok.split(".")[1];if(!p)throw new Error("the forge\\u0027s OIDC token is not a JWT");const c=JSON.parse(Buffer.from(p.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf-8"));if(!c||typeof c!=="object")throw new Error("the forge\\u0027s OIDC token has no claims");return c};',
  "async function seenOf(){",
  'if(x.forge==="gitlab")return{forgeEnvironment:E.CI_ENVIRONMENT_NAME||null,ref:E.CI_COMMIT_REF_NAME,refProtected:E.CI_COMMIT_REF_PROTECTED,runnerTags:tags(E.CI_RUNNER_TAGS)};',
  "const s={ref:E.GITHUB_REF};let c;",
  'if(x.forge==="github"&&x.forgeEnvironment!==undefined){try{',
  'if(!E.ACTIONS_ID_TOKEN_REQUEST_URL||!E.ACTIONS_ID_TOKEN_REQUEST_TOKEN)throw new Error("the job may request no OIDC token (no ACTIONS_ID_TOKEN_REQUEST_URL); it needs permissions: id-token: write");',
  'const r=await fetch(E.ACTIONS_ID_TOKEN_REQUEST_URL+"&audience="+encodeURIComponent(A),{headers:{authorization:"bearer "+E.ACTIONS_ID_TOKEN_REQUEST_TOKEN}});',
  'if(!r.ok)throw new Error("the OIDC token request answered "+r.status);const v=(await r.json()).value;if(typeof v!=="string")throw new Error("the OIDC token request answered no token");',
  'c=claimsOf(v);s.forgeEnvironment=typeof c.environment==="string"&&c.environment!==""?c.environment:null}catch(e){s.forgeEnvironmentError=e&&e.message?e.message:String(e)}}',
  'const run=c&&typeof c.runner_environment==="string"?c.runner_environment:E.RUNNER_ENVIRONMENT;if(run)s.runnerEnvironment=run;return s}',
  "seenOf().then((s)=>{const P=[],C=[],S=[];const fe=x.forgeEnvironment;",
  'if(x.forge==="forgejo")S.push("forge environment (Forgejo has none)");',
  'else if(fe!==undefined){if(s.forgeEnvironmentError!==undefined)P.push("forge environment: expected "+fe+", and it could not be read: "+s.forgeEnvironmentError);else if(s.forgeEnvironment!==fe)P.push("forge environment: expected "+fe+", found "+shown(s.forgeEnvironment));else C.push("forge environment "+fe)}',
  'const b=x.branches.filter((v)=>v!=="");',
  'if(b.length===0)P.push("ref: the job names no branch to run from");',
  'else if(x.forge==="gitlab"){if(!s.ref||!b.includes(s.ref))P.push("ref: expected "+b.join(" or ")+", found "+shown(s.ref));else C.push("ref "+s.ref);',
  'if(s.refProtected!=="true")P.push("ref: expected a protected ref (CI_COMMIT_REF_PROTECTED true), found "+shown(s.refProtected));else C.push("protected ref")}',
  'else{const refs=b.map((v)=>"refs/heads/"+v);if(!s.ref||!refs.includes(s.ref))P.push("ref: expected "+refs.join(" or ")+", found "+shown(s.ref));else C.push("ref "+s.ref)}',
  'if(x.forge==="gitlab"){const w=x.runnerTags||[];if(w.length>0){const h=s.runnerTags;const miss=w.filter((t)=>!(h||[]).includes(t));',
  'if(h===undefined)P.push("runner: expected tags "+w.join(", ")+", and the job has no CI_RUNNER_TAGS");else if(miss.length>0)P.push("runner: expected tags "+w.join(", ")+", found "+(h.length?h.join(", "):"none"));else C.push("runner tags "+w.join(", "))}}',
  'else if(x.selfHosted){if(s.runnerEnvironment===undefined)S.push("runner (the runner says nothing about itself: no RUNNER_ENVIRONMENT)");else if(s.runnerEnvironment!=="self-hosted")P.push("runner: expected self-hosted, found "+s.runnerEnvironment);else C.push("self-hosted runner")}',
  'const at=(x.product||"chant")+" check-job: "+x.job;',
  'if(P.length>0){for(const p of P)console.error(at+": "+p);console.error(at+": this job does not run where the spec set it to run, so it stops before any credential is taken or code checked out");process.exit(1)}',
  'console.log(at+": "+(C.length?C.join(", "):"nothing to check")+(S.length?"; not checked: "+S.join(", "):""))',
  "}).catch((e)=>fail(e&&e.message?e.message:String(e)));",
].join("");

/** The shell line of the guard step: `node -e` from `/`, so no file of the checkout is in reach. */
export function jobGuardLine(): string {
  return `(cd / && node -e '${JOB_GUARD_JS}')`;
}

/** How the guard's lines name an op-wave job: `wave 2 (prod) of deploy`, `share 1 of job group eu of wave 2 (prod) of deploy`. */
export function opWaveJobLabel(spec: string, job: { kind: "wave" | "decide" | "share"; wave: number; waveName: string; share?: number; group?: string }): string {
  const wave = `wave ${job.wave} (${job.waveName}) of ${spec}`;
  const share = job.share !== undefined ? `share ${job.share} of ` : "";
  if (job.kind === "decide") return `the deciding job of ${wave}`;
  if (job.group !== undefined) return `${share}job group ${job.group} of ${wave}`;
  return `${share}${wave}`;
}
