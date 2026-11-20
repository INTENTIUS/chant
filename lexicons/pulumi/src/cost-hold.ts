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
 * `redactEnv` names variables whose values are secret though the preview does
 * not mark them (a product's store values): each value is replaced in the
 * copy and the variable leaves the command's environment. `dropEnv` names
 * more variables to leave out, such as a product's own token variables. Both
 * take names; the job's environment holds the values.
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
  redactEnv?: string[];
  dropEnv?: string[];
}

/** Names of environment variables only, so no secret value sits in the spec. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
function envNames(option: string, names: string[] | undefined): string[] | undefined {
  if (names === undefined) return undefined;
  if (!Array.isArray(names) || !names.every((n) => typeof n === "string" && ENV_NAME.test(n))) throw new Error(`pulumiCostHold: ${option} is a list of environment variable names, never their values`);
  return names;
}

/** A cost hold that runs `command` over each stack's preview JSON, waiting over `approveAbove` a month. `command` must name `{planJson}`. */
export function pulumiCostHold(options: { approveAbove: number; command: string[]; format?: PulumiCostHold["format"]; currency?: string; redactEnv?: string[]; dropEnv?: string[] }): PulumiCostHold {
  const { command } = options;
  if (!Array.isArray(command) || command.length === 0 || !command.every((a) => typeof a === "string" && a !== "")) {
    throw new Error("pulumiCostHold: command is the estimator's argv, a non-empty list of strings; no estimator ships with the preset");
  }
  if (!command.some((a) => a.includes("{planJson}"))) throw new Error("pulumiCostHold: the command must name {planJson}, the stack's preview JSON");
  const redactEnv = envNames("redactEnv", options.redactEnv);
  const dropEnv = envNames("dropEnv", options.dropEnv);
  return { command, approveAbove: options.approveAbove, format: options.format ?? "chant", ...(options.currency ? { currency: options.currency } : {}), ...(redactEnv ? { redactEnv } : {}), ...(dropEnv ? { dropEnv } : {}) };
}
