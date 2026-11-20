/**
 * The terraform lexicon's preset for an op wave's cost hold (#4545,
 * `holds.cost` on the spec): infracost over each root's plan document, the
 * `show -json` file `terraform-apply`'s plan names as `artifact.planJson`.
 *
 * ```ts
 * const spec = { ..., step: { kind: "terraform-apply", root: "{target}" }, holds: { cost: terraformCostHold({ approveAbove: 100 }) } };
 * ```
 *
 * infracost reads a copy of the plan document with its sensitive values
 * replaced by `[redacted]` and runs without the forge tokens in its
 * environment. `redactEnv` names variables whose values are secret though the
 * plan does not mark them (a product's store values): each value is replaced
 * in the copy and the variable leaves infracost's environment. `dropEnv`
 * names more variables to leave out, such as a product's own token variables.
 * Both take names; the job's environment holds the values.
 *
 * The shape is core's `OpWaveCostHold`, written out here so the lexicon
 * builds against a core without it.
 */

/** infracost's own command over one plan document. */
export const INFRACOST_ARGV = ["infracost", "breakdown", "--path", "{planJson}", "--format", "json", "--log-level", "error"] as const;

export interface TerraformCostHold {
  command: string[];
  approveAbove: number;
  format: "infracost";
  currency?: string;
  redactEnv?: string[];
  dropEnv?: string[];
}

/** Names of environment variables only, so no secret value sits in the spec. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
function envNames(option: string, names: string[] | undefined): string[] | undefined {
  if (names === undefined) return undefined;
  if (!Array.isArray(names) || !names.every((n) => typeof n === "string" && ENV_NAME.test(n))) throw new Error(`terraformCostHold: ${option} is a list of environment variable names, never their values`);
  return names;
}

/** A cost hold that prices each root with infracost, waiting over `approveAbove` a month. `command` replaces infracost's argv; it must name `{planJson}`. */
export function terraformCostHold(options: { approveAbove: number; currency?: string; command?: string[]; redactEnv?: string[]; dropEnv?: string[] }): TerraformCostHold {
  const command = options.command ?? [...INFRACOST_ARGV];
  if (!command.some((a) => a.includes("{planJson}"))) throw new Error("terraformCostHold: the command must name {planJson}, the root's plan document");
  const redactEnv = envNames("redactEnv", options.redactEnv);
  const dropEnv = envNames("dropEnv", options.dropEnv);
  return { command, approveAbove: options.approveAbove, format: "infracost", ...(options.currency ? { currency: options.currency } : {}), ...(redactEnv ? { redactEnv } : {}), ...(dropEnv ? { dropEnv } : {}) };
}
