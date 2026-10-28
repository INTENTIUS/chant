/**
 * The settings half of op waves through capabilities (#4545): the `step` and
 * `holds` shapes and their checks. `./op-waves.ts` checks a spec with these,
 * and this file imports nothing at run time, so the spec module (and every
 * bundle that holds it: the gate decision, the stage hooks) stays without the
 * capability registry, the config loader and the policy runner that
 * `./op-waves-capability.ts` loads. See that file for the step and the holds.
 */

import type { OpWavesSpec } from "./op-waves";

/** A capability step a wave plans and applies each run through (#4545): `{ kind, ...input }`. */
export interface OpWaveStep {
  /** The capability's kind, such as `terraform-apply` or `pulumi-up`. */
  kind: string;
  /** The step's input. Each string has `{target}`, `{op}` and `{wave}` filled per run. */
  [field: string]: unknown;
}

/** The estimate's shape a cost hold reads. */
export const OP_WAVE_COST_FORMATS = ["infracost", "chant"] as const;
export type OpWaveCostFormat = (typeof OP_WAVE_COST_FORMATS)[number];

/** A cost hold (#4545): an estimator per run, and the monthly change over which the wave waits. */
export interface OpWaveCostHold {
  /**
   * Argv, run once per run that changes something. `{target}` and `{plan}`
   * (the run's plan file, as hooks get it) are filled in, and `{planJson}`
   * with the engine's plan document when the capability's plan names one
   * (`artifact.planJson`). It prints the estimate on standard output.
   */
  command: string[];
  /** The monthly change, summed over the wave's runs, above which the wave waits for a person. */
  approveAbove: number;
  /** `infracost`: `infracost breakdown --format json`'s document. `chant`: `{ "monthlyDelta": <number>, "currency"?: "<code>" }`. Default `infracost`. */
  format?: OpWaveCostFormat;
  /** The currency `approveAbove` is in, for the log and the digest. Default the estimate's, else `USD`. */
  currency?: string;
}

/** Holds a wave runs over its plans (#4545), read at base. */
export interface OpWaveHolds {
  /** Run the workspace's `ci.policy` at base over each run's change set: deny rules deny the run, hold rules hold it. */
  policy?: boolean;
  /** Price each run and hold the wave over a monthly change. */
  cost?: OpWaveCostHold;
}

/** The digest member a cost hold adds (#4545): no run has this name. */
export const OP_WAVE_COST_MEMBER = "(monthly cost)";

/** What is wrong with a spec's `step`, empty when nothing is. */
export function opWaveStepProblems(spec: Pick<OpWavesSpec, "step" | "plan" | "apply" | "planWave" | "applyWave" | "hooks" | "waves">): string[] {
  const step = spec.step as unknown;
  if (step === undefined) return [];
  if (step === null || typeof step !== "object" || Array.isArray(step)) return ["`step` must be { \"kind\": \"<capability>\", ...input }"];
  const problems: string[] = [];
  const kind = (step as { kind?: unknown }).kind;
  if (typeof kind !== "string" || kind.trim() === "") problems.push("`step.kind` must name a capability, such as \"terraform-apply\"");
  for (const key of ["plan", "apply", "planWave", "applyWave"] as const) {
    if (spec[key] !== undefined) problems.push(`\`step\` and \`${key}\` are both set; a wave plans and applies through its capability or through commands, so give one`);
  }
  if (spec.hooks?.apply?.runBy === "apply") problems.push("`hooks.apply.runBy: \"apply\"` hands the apply-stage hooks to an apply command, and a `step` has none; leave runBy as chant");
  for (const wave of spec.waves) {
    if (wave.discover) problems.push(`wave "${wave.name}" discovers its runs, which only \`planWave\` can report; a \`step\` plans the runs the spec lists`);
    if (wave.hooks?.apply?.runBy === "apply") problems.push(`wave "${wave.name}" hands its apply-stage hooks to an apply command, and a \`step\` has none`);
    for (const run of wave.runs ?? []) {
      const input = run.input as unknown;
      if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) problems.push(`wave "${wave.name}" run "${run.target}": \`input\` must be an object laid over the step's input`);
      if (input && typeof input === "object" && "kind" in input) problems.push(`wave "${wave.name}" run "${run.target}": \`input\` cannot change the step's kind`);
    }
  }
  return problems;
}

/** What is wrong with a spec's `holds`, empty when nothing is. */
export function opWaveHoldsProblems(holds: unknown): string[] {
  if (holds === undefined) return [];
  if (holds === null || typeof holds !== "object" || Array.isArray(holds)) return ["`holds` must be { \"policy\"?: true, \"cost\"?: {...} }"];
  const problems: string[] = [];
  for (const [key, value] of Object.entries(holds as Record<string, unknown>)) {
    if (key === "policy") {
      if (typeof value !== "boolean") problems.push("`holds.policy` must be true or false");
    } else if (key === "cost") {
      problems.push(...costHoldProblems(value));
    } else problems.push(`\`holds.${key}\` is not a setting; the ones there are holds.policy and holds.cost`);
  }
  return problems;
}

function costHoldProblems(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["`holds.cost` must be { \"command\": [...], \"approveAbove\": <number>, \"format\"?, \"currency\"? }"];
  const c = value as Record<string, unknown>;
  const problems: string[] = [];
  if (!Array.isArray(c.command) || c.command.length === 0 || !c.command.every((a) => typeof a === "string" && a !== "")) problems.push("`holds.cost.command` must be argv, a non-empty list of strings");
  if (typeof c.approveAbove !== "number" || !Number.isFinite(c.approveAbove) || c.approveAbove < 0) problems.push("`holds.cost.approveAbove` must be a monthly amount of 0 or more");
  if (c.format !== undefined && !(OP_WAVE_COST_FORMATS as readonly unknown[]).includes(c.format)) problems.push(`\`holds.cost.format\` must be ${OP_WAVE_COST_FORMATS.join(" or ")}`);
  if (c.currency !== undefined && (typeof c.currency !== "string" || !/^[A-Z]{3}$/.test(c.currency))) problems.push("`holds.cost.currency` must be a three-letter currency code, such as \"USD\"");
  for (const key of Object.keys(c)) if (!["command", "approveAbove", "format", "currency"].includes(key)) problems.push(`\`holds.cost.${key}\` is not a setting`);
  return problems;
}

/**
 * The holds wave rules take (#4545): the spec's at base, else the change's
 * when the base has none. `policy` is on when either one sets it, so a
 * change can add the hold and never drop it. Undefined when neither sets any.
 */
export function opWaveHoldsAt(atBase: OpWaveHolds | undefined, change: OpWaveHolds | undefined): OpWaveHolds | undefined {
  const policy = atBase?.policy === true || change?.policy === true;
  const cost = atBase !== undefined ? atBase.cost : change?.cost;
  if (!policy && !cost) return undefined;
  return { ...(policy ? { policy: true } : {}), ...(cost ? { cost } : {}) };
}
