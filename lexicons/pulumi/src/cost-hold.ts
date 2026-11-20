/**
 * The pulumi lexicon's preset for an op wave's cost hold (#5341,
 * `holds.cost` on the spec): a command the user names, run over each stack's
 * preview JSON. `pulumi-up`'s plan writes that document (`steps`,
 * `diagnostics`, `changeSummary`, the shape `pulumi preview --json` prints)
 * and names it as `artifact.planJson`, which a wave hands the command as
 * `{planJson}`.
 *
 * ```ts
 * const spec = { ..., step: { kind: "pulumi-up", stack: "{target}" }, holds: { cost: pulumiCostHold({ approveAbove: 100, command: ["./price-preview", "{planJson}"] }) } };
 * ```
 *
 * The command reads a copy of the preview with its secrets replaced by
 * `[redacted]` and runs without the forge tokens in its environment.
 * No estimator ships with it. The command prints the estimate on standard
 * output in `format`: `{ "monthlyDelta": <number>, "currency"?: "<code>" }`
 * for `chant` (the default), or infracost's JSON for `infracost`. The hold
 * only adds an approval when the sum is over `approveAbove`; it never lets a
 * plan apply without one. It is off until a spec sets it.
 *
 * The shape is core's `OpWaveCostHold` and matches `terraformCostHold`'s,
 * written out here so the lexicon builds against a core without it.
 */

export interface PulumiCostHold {
  command: string[];
  approveAbove: number;
  format: "chant" | "infracost";
  currency?: string;
}

/** A cost hold that runs `command` over each stack's preview JSON, waiting over `approveAbove` a month. `command` must name `{planJson}`. */
export function pulumiCostHold(options: { approveAbove: number; command: string[]; format?: PulumiCostHold["format"]; currency?: string }): PulumiCostHold {
  const { command } = options;
  if (!Array.isArray(command) || command.length === 0 || !command.every((a) => typeof a === "string" && a !== "")) {
    throw new Error("pulumiCostHold: command is the estimator's argv, a non-empty list of strings; no estimator ships with the preset");
  }
  if (!command.some((a) => a.includes("{planJson}"))) throw new Error("pulumiCostHold: the command must name {planJson}, the stack's preview JSON");
  return { command, approveAbove: options.approveAbove, format: options.format ?? "chant", ...(options.currency ? { currency: options.currency } : {}) };
}
