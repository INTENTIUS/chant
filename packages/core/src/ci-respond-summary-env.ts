/**
 * The settings of `wave-refused: summary` (#5335) as a spec and as a job's
 * variables, apart from the model run in `./ci-respond-summary.ts`, so a
 * waves spec and the pipeline generators read them without loading the run.
 *
 * A generated job that posts `wave-refused` carries the settings as
 * `CHANT_WAVE_SUMMARY_*` variables and the model's key under its own name
 * ({@link waveSummaryJobEnv}), only when the mode is `summary`. With `diff`
 * or `off` the job carries none of them.
 */

/** The summary's settings as a product sets them. Every field is optional. */
export interface WaveSummarySpec {
  /** The model command, run through the shell with the prompt on stdin. Default: the review command with `--output-format json`. */
  command?: string;
  /** The variable holding the model's key, the one secret the command sees; on GitHub and Forgejo the secret of the same name. Default {@link WAVE_SUMMARY_KEY_ENV}. */
  keyEnv?: string;
  /** Minutes the command may run. Default {@link WAVE_SUMMARY_TIMEOUT_MINUTES}. */
  timeout?: number;
  /** The most summaries per day, counted on the ledger. Absent: no count limit. */
  maxRuns?: number;
  /** The most US dollars the summaries may cost per day, summed from their records. Absent: no money limit. */
  maxCostUsd?: number;
  /** The op the runs are recorded under. Default `<product>-refused-wave`. */
  name?: string;
  /** The ledger environment the runs are recorded under. Default `local`, as every agent's. */
  env?: string;
}

/** The variable holding the model's key unless `keyEnv` names another. */
export const WAVE_SUMMARY_KEY_ENV = "ANTHROPIC_API_KEY";

/** Minutes the command may run unless `timeout` says otherwise. */
export const WAVE_SUMMARY_TIMEOUT_MINUTES = 10;

/** The variables a job carries the settings in. */
export const WAVE_SUMMARY_ENV = {
  command: "CHANT_WAVE_SUMMARY_COMMAND",
  keyEnv: "CHANT_WAVE_SUMMARY_KEY_ENV",
  timeout: "CHANT_WAVE_SUMMARY_TIMEOUT",
  maxRuns: "CHANT_WAVE_SUMMARY_MAX_RUNS",
  maxCostUsd: "CHANT_WAVE_SUMMARY_MAX_COST_USD",
  name: "CHANT_WAVE_SUMMARY_NAME",
  env: "CHANT_WAVE_SUMMARY_ENV",
} as const;

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An op or ledger environment name. */
export const OP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Why `spec` is not the summary's settings, or undefined when it is. */
export function waveSummarySpecProblem(spec: unknown): string | undefined {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return "the summary's settings are an object";
  const s = spec as Record<string, unknown>;
  for (const key of Object.keys(s)) if (!(key in WAVE_SUMMARY_ENV)) return `the summary's settings name no field ${JSON.stringify(key)}; the fields are ${Object.keys(WAVE_SUMMARY_ENV).join(", ")}`;
  for (const key of ["command", "keyEnv", "name", "env"] as const) if (s[key] !== undefined && typeof s[key] !== "string") return `the summary's ${key} is a string`;
  if (s.name !== undefined && !OP_NAME.test(s.name as string)) return `the summary's name ${JSON.stringify(s.name)} is not an op name`;
  if (s.env !== undefined && !OP_NAME.test(s.env as string)) return `the summary's ledger environment ${JSON.stringify(s.env)} is not an environment name`;
  if (s.command !== undefined && ((s.command as string).trim() === "" || /[\r\n]/.test(s.command as string))) return "the summary's command is one line";
  if (s.keyEnv !== undefined && !VAR_NAME.test(s.keyEnv as string)) return `the summary's key variable ${JSON.stringify(s.keyEnv)} is not a variable name`;
  if (s.timeout !== undefined && !(Number.isInteger(s.timeout) && (s.timeout as number) >= 1 && (s.timeout as number) <= 360)) return "the summary's timeout is a whole number of minutes from 1 to 360";
  if (s.maxRuns !== undefined && !(Number.isInteger(s.maxRuns) && (s.maxRuns as number) >= 1)) return "the summary's maxRuns is a whole number of at least 1";
  if (s.maxCostUsd !== undefined && !(typeof s.maxCostUsd === "number" && Number.isFinite(s.maxCostUsd) && s.maxCostUsd > 0)) return "the summary's maxCostUsd is a number of US dollars above 0";
  return undefined;
}

/** The variables that carry `spec` to a job. Only the fields set. */
export function waveSummaryEnv(spec: WaveSummarySpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of Object.keys(WAVE_SUMMARY_ENV) as (keyof WaveSummarySpec)[]) {
    const v = spec[field];
    if (v !== undefined) out[WAVE_SUMMARY_ENV[field]] = String(v);
  }
  return out;
}

/**
 * What a generated job that posts `wave-refused` carries for the summary:
 * nothing unless `mode` is `summary`. Then the settings' variables
 * ({@link waveSummaryEnv}, always naming the key's variable) and, on GitHub and Forgejo, the model's key from
 * the secret of its name. A GitLab job reads the key as the CI/CD variable of
 * that name, which every job of the pipeline already has. Throws on settings
 * that are not settings.
 */
export function waveSummaryJobEnv(forge: "github" | "gitlab" | "forgejo", mode: string | undefined, spec: WaveSummarySpec = {}): Record<string, string> {
  if (mode !== "summary") return {};
  const problem = waveSummarySpecProblem(spec);
  if (problem) throw new Error(`waveSummary: ${problem}`);
  const key = spec.keyEnv ?? WAVE_SUMMARY_KEY_ENV;
  return { ...(forge === "gitlab" ? {} : { [key]: `\${{ secrets.${key} }}` }), ...waveSummaryEnv({ ...spec, keyEnv: key }) };
}
