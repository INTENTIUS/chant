/**
 * The terraform lexicon's preset for an op wave's cost hold (#4545,
 * `holds.cost` on the spec): infracost over each root's plan document, the
 * `show -json` file `terraform-apply`'s plan names as `artifact.planJson`.
 *
 * ```ts
 * const spec = { ..., step: { kind: "terraform-apply", root: "{target}" }, holds: { cost: terraformCostHold({ approveAbove: 100 }) } };
 * ```
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
}

/** A cost hold that prices each root with infracost, waiting over `approveAbove` a month. `command` replaces infracost's argv; it must name `{planJson}`. */
export function terraformCostHold(options: { approveAbove: number; currency?: string; command?: string[] }): TerraformCostHold {
  const command = options.command ?? [...INFRACOST_ARGV];
  if (!command.some((a) => a.includes("{planJson}"))) throw new Error("terraformCostHold: the command must name {planJson}, the root's plan document");
  return { command, approveAbove: options.approveAbove, format: "infracost", ...(options.currency ? { currency: options.currency } : {}) };
}
