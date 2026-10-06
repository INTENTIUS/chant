/**
 * A gate that asks a declared decision point (#3170): the declaration's
 * shape. What a run does when it reaches one is in `./gate-point-run.ts`.
 *
 * A plain gate is a pair of facts on the gate ledger: the run records a
 * pending fact, and `chant approve` records the resolution. A gate that names
 * a point asks it instead, the way the `decide` activity does (#2740): the
 * point's deciders (a table, a model, people) and its quorum decide, the
 * answer is an answer record in the workspace, and an open question is
 * answered with `chant workspace points answer` or through hud. The run then
 * passes the gate on that answer and writes the resolution itself, citing the
 * record. So the gate ledger and the workspace's decision history both show
 * the approval, and each names the other.
 *
 * This module imports nothing at run time, so the `gate` builder can check a
 * declaration without loading the ledger or the workspace.
 */

/**
 * The decision point a gate asks (#3170). `gate("apply", { point:
 * "prod-apply" })` is `{ name: "prod-apply" }`.
 */
export interface GatePoint {
  /** The point's name, as the workspace's points file declares it. */
  name: string;
  /**
   * Inputs besides the gate's own `gate.*` ones, by the point's input names.
   * A step-output reference resolves when the run reaches the gate. Only
   * inputs the point declares may be given.
   */
  inputs?: Record<string, unknown>;
  /** The answers that pass the gate. Default `[true]`: a noul point's yes. Any other answer fails the step. */
  pass?: Array<string | boolean>;
}

/** The answers a gate passes on when it names none: a noul point's yes. */
export const DEFAULT_GATE_POINT_PASS: ReadonlyArray<string | boolean> = [true];

/** A gate's `point` as a {@link GatePoint}, or undefined for a plain gate. */
export function gatePointOf(point: string | GatePoint | undefined): GatePoint | undefined {
  if (point === undefined) return undefined;
  return typeof point === "string" ? { name: point } : point;
}

const POINT_NAME = /^[a-z][a-z0-9-]*$/;

/** What is wrong with a gate's `point`, empty when nothing is. `withApproval` is whether the gate also declares `approval`. */
export function gatePointProblems(point: unknown, withApproval = false): string[] {
  const problems: string[] = [];
  if (withApproval) problems.push("a gate that asks a decision point takes its quorum from the point: give `approval` or `point`, not both");
  const p = typeof point === "string" ? { name: point } : point;
  if (p === null || typeof p !== "object" || Array.isArray(p)) return [...problems, "`point` is a decision point's name or { name, inputs?, pass? }"];
  const { name, inputs, pass, ...rest } = p as Record<string, unknown>;
  if (typeof name !== "string" || !POINT_NAME.test(name)) problems.push("`point.name` is a decision point's name: lower case letters, digits and hyphens, starting with a letter");
  if (inputs !== undefined && (inputs === null || typeof inputs !== "object" || Array.isArray(inputs))) problems.push("`point.inputs` is an object of input name to value");
  if (inputs && typeof inputs === "object") {
    const own = Object.keys(inputs).filter((k) => k in GATE_POINT_INPUTS);
    if (own.length > 0) problems.push(`\`point.inputs\` gives ${own.join(", ")}, which the gate passes itself`);
  }
  if (pass !== undefined && (!Array.isArray(pass) || pass.length === 0 || pass.some((a) => typeof a !== "string" && typeof a !== "boolean"))) {
    problems.push("`point.pass` is a non-empty list of the answers that pass the gate");
  }
  const extra = Object.keys(rest);
  if (extra.length > 0) problems.push(`\`point\` takes name, inputs and pass, not ${extra.join(", ")}`);
  return problems;
}

/**
 * What the run knows about the gate it reached: the fields the `status` read
 * contract lists a gate with, which a point reads as its `gate.*` inputs.
 */
export interface GatePointFacts {
  /** The op the gate is recorded under. */
  component: string;
  /** The gate's name. */
  name: string;
  /** The environment the run was started for, or null. */
  env: string | null;
  /** The plan the gate binds, or null when it binds none. */
  planDigest: string | null;
}

/** The `gate.*` inputs a gate passes to its point, each from a {@link GatePointFacts} field. */
export const GATE_POINT_INPUTS: Readonly<Record<string, keyof GatePointFacts>> = {
  "gate.component": "component",
  "gate.name": "name",
  "gate.env": "env",
  "gate.planDigest": "planDigest",
};

/**
 * The inputs a gate asks its point with: the `gate.*` inputs the point
 * declares, from `facts`, and the authored ones. A gate that binds a plan
 * asks a point that declares `gate.planDigest`, so each plan is its own
 * question and an answer for one plan never passes another: it throws
 * otherwise, naming the input to declare.
 */
export function gatePointInputs(point: string, declared: readonly string[], facts: GatePointFacts, authored: Record<string, unknown> = {}): Record<string, unknown> {
  if (facts.planDigest !== null && !declared.includes("gate.planDigest")) {
    throw new Error(
      `gate "${facts.name}" binds a plan and asks decision point ${point}, which does not declare the input gate.planDigest: ` +
        `declare it in the points file, so each plan is its own question and an answer for one plan never passes another`,
    );
  }
  const inputs: Record<string, unknown> = {};
  for (const [input, field] of Object.entries(GATE_POINT_INPUTS)) {
    if (declared.includes(input) && facts[field] !== null) inputs[input] = facts[field];
  }
  return { ...authored, ...inputs };
}

/**
 * What an answer record's `constrains` names a gate by: `gate:<op>/<gate>`,
 * with `@<env>` when the run names an environment. It is how the record
 * names the gate ledger entry that cites it.
 */
export function gateSubject(op: string, gate: string, env?: string | null): string {
  return `gate:${op}/${gate}${env ? `@${env}` : ""}`;
}
