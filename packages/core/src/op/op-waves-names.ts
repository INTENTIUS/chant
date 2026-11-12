/**
 * A product's own names in an Op waves pipeline (#5022), as the product
 * plan keeps them (#5003).
 *
 * Maintainer decision (2026-11-11, on #5000): chant keeps a product's
 * names. A product whose wave jobs live in its own workflow beside its plan
 * jobs (terragucci's `apply-wave-<k>` in `terragucci.yml`) hands the
 * generators the names, and they render them, so the product never renames
 * or edits what chant wrote:
 *
 * - `jobNames`: a name for each job the generator writes (a wave's job, its
 *   deciding, share and job group jobs, a split wave's plan, gate, apply and
 *   record jobs, the policy and evidence jobs, the apply status, stale,
 *   before-merge done and control jobs). Every `needs:`, `if:`, artifact
 *   `{job}` and `--from-job` follows it.
 * - `stageNames` (GitLab): a name for each stage.
 * - `artifactNames` (GitHub, Forgejo): the outcome, decision, saved plan and
 *   check claims artifacts, and the pattern a wave job downloads the
 *   earlier outcomes with.
 * - `workflowFile`, `runIf` and `dispatchInputs`: the jobs go in the
 *   product's workflow, each running only on a push `runIf` admits (or a
 *   before-merge or follow-on dispatch), and the dispatch inputs take the
 *   product's names so they never meet its own. On GitLab `runIf` joins
 *   every rule of every job.
 *
 * Left out, each is chant's, and the generators render as before.
 */

import type { OpWaveJob, OpWavesSpec } from "./op-waves";

/** What a job of an Op waves pipeline is (#5022), for {@link OpWavesJobNames}. */
export type OpWavesJobRole =
  | "wave"
  | "decide"
  | "share"
  | "group"
  | "plan"
  | "gate"
  | "apply"
  | "record"
  | "policy"
  | "evidence"
  | "apply-status"
  | "stale-notes"
  | "before-merge-done"
  | "control"
  | "resume";

/** One job the generator names (#5022). */
export interface OpWavesJobRef {
  /** The name chant gives it. A policy or evidence job's is the job it belongs to's name, as the product named it, with `-policy` or `-evidence`. */
  name: string;
  /**
   * `wave`: a wave's one job. `decide`, `share`, `group`: a wide wave's
   * deciding job, a share's job and a job group's (or a group share's)
   * job. `plan`, `gate`, `apply`, `record`: a split wave's jobs before merge
   * (`apply` with `share` or `group` for a wide wave's). `policy` (GitLab),
   * `evidence`: the jobs of a wave's checks. The rest are the jobs after
   * or beside the waves; `resume` (#5034) is the scheduled job that starts
   * a waiting wave's job again, `resume` in its own workflow on GitHub and
   * Forgejo and `<spec>-resume` on GitLab.
   */
  role: OpWavesJobRole;
  /** The wave's number from 1, and its name, on every job but the stale and control jobs and the before-merge done job. */
  wave?: number;
  waveName?: string;
  share?: number;
  group?: string;
  /** A job of the spec's `rest` wave. */
  rest?: true;
  /** A policy or evidence job: the name of the job it belongs to. */
  of?: string;
}

/** A product's job names (#5022): its name for a job, or undefined for chant's. */
export type OpWavesJobNames = (job: OpWavesJobRef) => string | undefined;

/** One GitLab stage the generator names (#5022). */
export interface OpWavesStageRef {
  /** The name chant gives it: `plans`, `wave-<k>-<wave name>`, `before-merge-done`, `control` or `resume`. */
  name: string;
  role: "plans" | "wave" | "before-merge-done" | "control" | "resume";
  wave?: number;
  waveName?: string;
}

/** A product's GitLab stage names (#5022): its name for a stage, or undefined for chant's. Two stages may share a name. */
export type OpWavesStageNames = (stage: OpWavesStageRef) => string | undefined;

/**
 * A product's artifact names (#5022, GitHub and Forgejo). `{job}` is the
 * job's name as the product named it, `{wave}` the wave's number.
 */
export interface OpWavesArtifactNames {
  /** A job's outcome file. Default `<spec>-{job}-outcome`. */
  outcome?: string;
  /** A wave's decision, which its share, apply and record jobs download. Default `<spec>-wave-{wave}-decision`. */
  decision?: string;
  /** A split wave's saved plan (#4987). Default `<spec>-wave-{wave}-plan`. */
  plan?: string;
  /** A job's check claims, for its evidence job (#4926). Default `<spec>-{job}-checks`. */
  checks?: string;
  /**
   * GitHub: the pattern a wave job downloads the earlier jobs' outcomes
   * with, such as `terragucci-report-apply-wave-*`. It has to match every
   * earlier outcome artifact. The jobs after the waves download every
   * artifact of the run, and so does every job on Forgejo. Default: every
   * artifact of the run.
   */
  earlier?: string;
}

/** The `workflow_dispatch` inputs of a waves workflow (#4984, #4992), by chant's name. */
export type OpWavesDispatchInput = "pr" | "head" | "digest" | "wave" | "commit";

/** The dispatch inputs' names, chant's unless the product gave its own (#5022). */
export function opWavesDispatchInputs(given: Partial<Record<OpWavesDispatchInput, string>> | undefined): Record<OpWavesDispatchInput, string> {
  const out = { pr: "pr", head: "head", digest: "digest", wave: "wave", commit: "commit" } as Record<OpWavesDispatchInput, string>;
  const seen = new Map<string, string>();
  for (const key of Object.keys(out) as OpWavesDispatchInput[]) {
    const v = given?.[key];
    if (given && key in given && (typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(v))) throw new Error(`dispatchInputs.${key} ${JSON.stringify(v)} is not an input name of letters, digits, _ and -, starting with a letter or _`);
    if (v !== undefined) out[key] = v;
    const other = seen.get(out[key]);
    if (other !== undefined) throw new Error(`dispatchInputs names two inputs ${out[key]}: ${other} and ${key}`);
    seen.set(out[key], key);
  }
  for (const key of Object.keys(given ?? {})) if (!(key in out)) throw new Error(`dispatchInputs.${key} is none of pr, head, digest, wave and commit`);
  return out;
}

/** Whether a product renamed any dispatch input (#5022). */
export function opWavesInputsRenamed(inputs: Record<OpWavesDispatchInput, string>): boolean {
  return Object.entries(inputs).some(([k, v]) => k !== v);
}

const ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The artifact names of a pipeline (#5022), from {@link OpWavesArtifactNames} or chant's. Throws on a template that cannot name one. */
export function opWavesArtifacts(spec: Pick<OpWavesSpec, "name">, given: OpWavesArtifactNames | undefined): {
  outcome(job: string): string;
  decision(wave: number): string;
  plan(wave: number): string;
  checks(job: string): string;
  earlier?: string;
} {
  const t = {
    outcome: given?.outcome ?? `${spec.name}-{job}-outcome`,
    decision: given?.decision ?? `${spec.name}-wave-{wave}-decision`,
    plan: given?.plan ?? `${spec.name}-wave-{wave}-plan`,
    checks: given?.checks ?? `${spec.name}-{job}-checks`,
  };
  const marks = { outcome: "{job}", decision: "{wave}", plan: "{wave}", checks: "{job}" } as const;
  for (const key of Object.keys(marks) as Array<keyof typeof marks>) {
    if (given?.[key] === undefined) continue;
    const v = t[key];
    if (!v.includes(marks[key]) || !ARTIFACT.test(v.replaceAll("{job}", "j").replaceAll("{wave}", "1"))) {
      throw new Error(`artifactNames.${key} ${JSON.stringify(v)} holds ${marks[key]} and is otherwise letters, digits, '.', '_' and '-'`);
    }
  }
  const distinct = new Set([t.outcome.replace("{job}", "x"), t.checks.replace("{job}", "x")]);
  if (distinct.size < 2) throw new Error(`artifactNames gives the outcome and the check claims one name, ${JSON.stringify(t.outcome)}`);
  if (t.decision === t.plan) throw new Error(`artifactNames gives the decision and the saved plan one name, ${JSON.stringify(t.plan)}`);
  const earlier = given?.earlier;
  if (earlier !== undefined && !/^[A-Za-z0-9._*-]+$/.test(earlier)) throw new Error(`artifactNames.earlier ${JSON.stringify(earlier)} is a pattern of letters, digits, '.', '_', '-' and '*'`);
  return {
    outcome: (job) => t.outcome.replaceAll("{job}", job),
    decision: (wave) => t.decision.replaceAll("{wave}", String(wave)),
    plan: (wave) => t.plan.replaceAll("{wave}", String(wave)),
    checks: (job) => t.checks.replaceAll("{job}", job),
    ...(earlier !== undefined ? { earlier } : {}),
  };
}

/** The file a waves workflow goes in (#5022): `workflowFile`, else `<spec>.yml`. */
export function opWavesWorkflowFile(spec: Pick<OpWavesSpec, "name">, file: string | undefined): string {
  if (file === undefined) return `${spec.name}.yml`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(file)) throw new Error(`workflowFile ${JSON.stringify(file)} is a workflow file's name, like terragucci.yml, in the forge's workflow directory`);
  return file;
}

/**
 * The file the resume workflow goes in (#5034, GitHub and Forgejo):
 * `resumeWorkflowFile`, such as terragucci's `terragucci-resume.yml`, else
 * `<spec>-resume.yml`. Refused when it is the waves' own file.
 */
export function opWavesResumeWorkflowFile(spec: Pick<OpWavesSpec, "name">, file: string | undefined, wavesFile: string): string {
  if (file === undefined) return `${spec.name}-resume.yml`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(file)) throw new Error(`resumeWorkflowFile ${JSON.stringify(file)} is a workflow file's name, like terragucci-resume.yml, in the forge's workflow directory`);
  if (file === wavesFile) throw new Error(`resumeWorkflowFile ${JSON.stringify(file)} is the waves' own workflow; the resume runs on a schedule of its own`);
  return file;
}

/**
 * The product's own jobs the first wave's jobs need (#5032), such as
 * terragucci's `check`: checked as job names of the forge, each once.
 * Absent or empty: none, and the jobs render as before.
 */
export function opWavesFirstWaveNeeds(given: readonly string[] | undefined, forge: "github" | "forgejo" | "gitlab"): string[] {
  if (given === undefined) return [];
  if (!Array.isArray(given)) throw new Error("firstWaveNeeds is a list of the product's job names");
  const github = forge !== "gitlab";
  for (const n of given) {
    const ok = typeof n === "string" && (github ? /^[A-Za-z_][A-Za-z0-9_-]*$/.test(n) : /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(n) && !GITLAB_KEYWORDS.has(n));
    if (!ok) throw new Error(`firstWaveNeeds names ${JSON.stringify(n)}, which is not a job name of letters, digits, _ and -${github ? ", starting with a letter or _" : ", and no GitLab keyword"}`);
  }
  if (new Set(given).size !== given.length) throw new Error(`firstWaveNeeds names a job twice: ${given.join(", ")}`);
  return [...given];
}

/**
 * The forge token a wave job's command step gets (#5044): with it, the
 * jobs that run only the default branch's code (a push's wave, deciding,
 * share and job group jobs; a split wave's gate and record jobs) hand their
 * command step the job's token as `GITHUB_TOKEN`, so the spec's `respond`
 * posts and a product's hooks can read the forge, and the job asks for
 * `permissions` on top of chant's own. A split wave's plan and applying jobs
 * run the change's code and never get it. GitHub and Forgejo only.
 */
export interface OpWavesCommandToken {
  /** GitHub's permission scopes the jobs ask for beside chant's own, such as `{ "pull-requests": "write", actions: "read" }`. `contents` and `id-token` are chant's. */
  permissions?: Record<string, "read" | "write">;
}

/** The GitHub permission scopes a product may add with {@link OpWavesCommandToken}. `contents` and `id-token` stay chant's. */
const COMMAND_TOKEN_SCOPES = new Set(["actions", "attestations", "checks", "deployments", "discussions", "issues", "packages", "pages", "pull-requests", "repository-projects", "security-events", "statuses"]);

/**
 * {@link OpWavesCommandToken}'s permissions, checked (#5044): each a scope
 * GitHub knows that chant does not set itself, `read` or `write`. Undefined
 * when there is no token to give. GitLab refuses it, since its jobs read
 * `CHANT_FORGE_TOKEN`, a CI/CD variable.
 */
export function opWavesCommandToken(token: OpWavesCommandToken | undefined, forge: "github" | "forgejo" | "gitlab"): Record<string, "read" | "write"> | undefined {
  if (token === undefined) return undefined;
  if (forge === "gitlab") throw new Error("commandToken gives a GitHub or Forgejo wave job its token; a GitLab job reads CHANT_FORGE_TOKEN, a CI/CD variable, so leave it out");
  if (token === null || typeof token !== "object" || Array.isArray(token)) throw new Error("commandToken is { permissions }");
  const permissions = token.permissions ?? {};
  if (permissions === null || typeof permissions !== "object" || Array.isArray(permissions)) throw new Error("commandToken.permissions maps a permission scope to read or write");
  for (const [scope, level] of Object.entries(permissions)) {
    if (scope === "contents" || scope === "id-token") throw new Error(`commandToken.permissions names ${scope}, which chant sets on the wave jobs itself`);
    if (!COMMAND_TOKEN_SCOPES.has(scope)) throw new Error(`commandToken.permissions names ${JSON.stringify(scope)}, which is not a GitHub permission scope`);
    if (level !== "read" && level !== "write") throw new Error(`commandToken.permissions.${scope} is ${JSON.stringify(level)}; give read or write`);
  }
  return { ...permissions };
}

/**
 * GitLab (#5045): the `cache:` a product gives the wave jobs that run the
 * wave's command, one entry or a list of them as GitLab takes them, such as
 * terragucci's `{ key: terragucci-terragrunt, paths: [.terragrunt-cache/] }`.
 * Each entry is a mapping with `paths` or `key`. Undefined when none.
 */
export function opWavesGitlabCache(cache: Record<string, unknown> | Array<Record<string, unknown>> | undefined): Record<string, unknown> | Array<Record<string, unknown>> | undefined {
  if (cache === undefined) return undefined;
  const entries = Array.isArray(cache) ? cache : [cache];
  if (entries.length === 0) throw new Error("cache is a GitLab cache entry or a list of them; leave it out for none");
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("cache holds GitLab cache entries, each a mapping such as { key, paths }");
    if (entry.paths === undefined && entry.key === undefined) throw new Error("a cache entry names its paths or its key");
  }
  return cache;
}

/** Refuse a product job of {@link opWavesFirstWaveNeeds} that is a job the generator writes (#5032). */
export function assertFirstWaveNeedsOutside(needs: readonly string[], jobs: Iterable<string>): void {
  const mine = new Set(jobs);
  for (const n of needs) if (mine.has(n)) throw new Error(`firstWaveNeeds names ${n}, a job of the waves themselves; name the product's own jobs, such as its check`);
}

/**
 * GitHub and Forgejo: the condition a first-wave job runs under with
 * {@link opWavesFirstWaveNeeds} (#5032). Each product job passed; in a
 * dispatched run (before merge), one that did not run is no hold, since a
 * product's check runs on its pushes and pull requests.
 */
export function githubFirstWaveIf(needs: readonly string[]): string {
  return ["!cancelled()", ...needs.map((n) => `(needs.${n}.result == 'success' || (github.event_name == 'workflow_dispatch' && needs.${n}.result == 'skipped'))`)].join(" && ");
}

const GITLAB_KEYWORDS = new Set(["default", "include", "stages", "variables", "workflow", "image", "services", "cache", "before_script", "after_script", "spec", "pages"]);

/** A job of a pipeline as {@link opWavesNamer} reads it: an `opWaveJobs` job, or a split one with its phase. */
type NamedJob = OpWaveJob & { phase?: "plan" | "gate" | "apply" | "record"; rest?: true };

/** What a job is, for its {@link OpWavesJobRef}. */
function roleOf(job: NamedJob): OpWavesJobRole {
  if (job.phase !== undefined) return job.phase;
  return job.kind === "share" && job.group !== undefined ? "group" : job.kind;
}

/**
 * The names of a pipeline's jobs (#5022): {@link OpWavesJobNames}, else
 * chant's. `name` gives one job's (the same each time it is asked),
 * `jobs` names a list of wave jobs and their `needs`, and `claim` keeps a
 * name the generator writes as it is. Throws on a name the forge cannot
 * take and on two jobs that share one.
 */
export function opWavesNamer(spec: Pick<OpWavesSpec, "waves">, forge: "github" | "forgejo" | "gitlab", given: OpWavesJobNames | undefined): {
  name(ref: OpWavesJobRef): string;
  jobs<T extends NamedJob>(jobs: readonly T[]): T[];
  claim(name: string): string;
} {
  const github = forge !== "gitlab";
  const byKey = new Map<string, string>();
  const owner = new Map<string, string>();
  const take = (key: string, name: string, what: string): string => {
    const other = owner.get(name);
    if (other !== undefined && other !== key) throw new Error(`the Op waves pipeline names two jobs ${name}: ${other.split("|")[1]} and ${what}`);
    owner.set(name, key);
    byKey.set(key, name);
    return name;
  };
  const name = (ref: OpWavesJobRef): string => {
    const key = `${ref.role}|${ref.name}`;
    const known = byKey.get(key);
    if (known !== undefined) return known;
    const mine = given?.(ref);
    if (mine !== undefined) {
      const ok = typeof mine === "string" && (github ? /^[A-Za-z_][A-Za-z0-9_-]*$/.test(mine) : /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(mine) && !GITLAB_KEYWORDS.has(mine));
      if (!ok) throw new Error(`jobNames gives the ${ref.role} job ${ref.name} the name ${JSON.stringify(mine)}, which is not a job name of letters, digits, _ and -, starting with a letter or _${github ? "" : " or a digit, and no GitLab keyword"}`);
    }
    return take(key, mine ?? ref.name, ref.name);
  };
  const restWave = spec.waves[spec.waves.length - 1]?.rest === true ? spec.waves.length : undefined;
  const jobs = <T extends NamedJob>(list: readonly T[]): T[] => {
    const renamed = new Map<string, string>();
    for (const job of list) {
      const ref: OpWavesJobRef = {
        name: job.jobName,
        role: roleOf(job),
        wave: job.wave,
        waveName: job.waveName,
        ...(job.share !== undefined ? { share: job.share } : {}),
        ...(job.group !== undefined ? { group: job.group } : {}),
        ...(job.rest || job.wave === restWave ? { rest: true as const } : {}),
      };
      renamed.set(job.jobName, name(ref));
    }
    return list.map((job) => ({ ...job, jobName: renamed.get(job.jobName)!, needs: job.needs.map((n) => renamed.get(n) ?? n) }));
  };
  return { name, jobs, claim: (n) => take(`claim|${n}`, n, n) };
}
