/**
 * A step's inputs per environment (#5360): one component carries a release's
 * commit to each environment's own target.
 *
 * A step may carry `environments`, keyed by environment name, each entry a
 * map of the step's inputs for that environment:
 *
 *     {
 *       kind: "pulumi-up",
 *       dir: "infra/shop",
 *       environments: {
 *         dev: { stack: "acme/shop/dev" },
 *         staging: { stack: "acme/shop/staging" },
 *         prod: { stack: "acme/shop/prod" },
 *       },
 *     }
 *
 * Core resolves it for the run's environment before the capability sees the
 * input: the entry's keys replace the step's keys of the same name, one level
 * deep, and `environments` itself is removed. So `pulumi-up` takes its stack
 * this way, `terraform-apply` its `root` and `vars`, and any other engine
 * step whatever input picks its target. A step with no `environments` is
 * passed on as it is.
 *
 * The map is plain data in the composition, so it is the same in every
 * environment: `chant components promote --to staging` deploys the
 * component it loaded with the staging entry, and records it under staging;
 * `rollback` and `redeploy` pick the entry of the environment they act on.
 *
 * An environment the map does not name is refused before anything runs,
 * naming the environments it does name. A pull request's environment
 * `pr-<n>` takes the entry of its template environment, the one `pr-env up`
 * sets in `CHANT_ENV_TEMPLATE` (`ci.prEnvironment.template`); a template
 * that names a stack, `<project>/<stack>`, picks the entry its last segment
 * names. The step's own review-stack handling then runs on that entry, as
 * it does on a fixed stack.
 *
 * The callers resolve early, where the environment is known and before a
 * plan, a release pin or a run reads the steps: `chant run --components`
 * (./cli-support.ts), promote, rollback and redeploy
 * (../cli/handlers/promote.ts), a release cut's compile
 * (./release-compile.ts), and the fan-out a pull request's plan and `chant
 * components fan-out` derive (./fan-out-support.ts), whose declared reads
 * (./declared-reads.ts) a capability such as `pulumi-up` answers from the
 * resolved stack. A group's members reach `planGroup`, `groupReads` and
 * `groupFallback` resolved (./groups.ts), so terraform's composition reads
 * each member's resolved root. The driver refuses a component still carrying a
 * map that does not name its environment before its first wave
 * (`runInterpretDriver`), and each place that hands a capability its input
 * resolves the step again, which is a no-op on a resolved one.
 *
 * An environment's config and secret set (./environment-sets.ts, #5348)
 * picks its entry with {@link environmentEntryName}, the same lookup.
 *
 * ## Gate steps (#5401)
 *
 * A gate step takes `environments` too, naming the environments it applies
 * in: a list of names, or a map whose entries may set the gate's `gate`,
 * `description` and `timeout` there.
 *
 *     { kind: "gate", gate: "release", environments: ["staging", "prod"] }
 *
 * The same resolution reads it, with the same lookup (a pull request's
 * environment takes its template's entry). In an environment the gate
 * names, the gate stays, its entry merged over it and `environments`
 * removed. In any other, the gate is taken out of its phase and listed on
 * the phase's `skippedGates`, so every reader past this point (the release
 * gate's plan and binding, the gate names a promote prints, the driver)
 * sees only the gates that apply, and the driver records each skip
 * (`gateSkipped` on its step record, a `step-settle` with
 * `skip: "environment"`). A gate step with no `environments` applies in
 * every environment, as before. `chant build` refuses a gate that names an
 * environment the member does not declare ({@link unknownGateEnvironments}).
 *
 * This module imports only the release floors at run time.
 */

import { NEXT_RELEASE } from "../release-floors";

/** The step key that holds its inputs per environment. */
export const STEP_ENVIRONMENTS_KEY = "environments";

/**
 * The first chant that resolves a component step's `environments` for the
 * run's environment before its capability sees the input (#5360), for
 * `pulumi-up`'s stack, `terraform-apply`'s root and vars and every other
 * engine step, in `run --components`, promote, rollback, redeploy, a
 * release cut, and a pull request's plan, its declared reads and its groups.
 */
export const STEP_ENVIRONMENTS_FLOOR = NEXT_RELEASE;

/**
 * The first chant that applies a gate step only in the environments its
 * `environments` names (#5401): in any other the gate is skipped and the
 * skip recorded on the run's step records, its run events, the release
 * records and `chant workspace status`, and a promote's plan lists it; a
 * gate naming an environment the member does not declare fails `chant
 * build`.
 */
export const GATE_ENVIRONMENTS_FLOOR = NEXT_RELEASE;

/** The keys a gate step's `environments` entry may set (#5401). */
export const GATE_ENVIRONMENT_KEYS: readonly string[] = ["gate", "description", "timeout"];

/** A gate step that does not apply in the run's environment, as its phase lists it (#5401). */
export interface SkippedGate {
  /** The gate's name, as the step names it. */
  gate: string;
  /** The environments the gate applies in, in the order it names them. */
  environments: string[];
}

/** A skipped gate with the component and phase it sits in. */
export interface SkippedGateAt extends SkippedGate {
  component: string;
  phase: string;
}

/** The variable `pr-env up` sets to the pull request environment's template (`PR_ENV_TEMPLATE_VAR` in ./pr-environment.ts). */
const TEMPLATE_VAR = "CHANT_ENV_TEMPLATE";

/** A pull request's environment name (`isPrEnvironmentName` in ./pr-environment.ts). */
const PR_ENV = /^pr-[1-9][0-9]*$/;

/** A step's inputs per environment: environment name to the inputs that replace the step's own. */
export type StepEnvironments = Record<string, Record<string, unknown>>;

/** Where the environment and the pull request template come from. */
export interface StepEnvironmentOptions {
  /** A pull request environment's template. Default: `CHANT_ENV_TEMPLATE` from `processEnv`. */
  template?: string;
  /** Read for the template when none is given. Default: `process.env`. */
  processEnv?: Record<string, string | undefined>;
}

/** One step that cannot run in the environment, and why. */
export interface StepEnvironmentRefusal {
  component: string;
  phase: string;
  kind: string;
  env: string;
  /** The environments the step names, in the order it names them. Empty when the map is malformed. */
  named: string[];
  message: string;
}

/** Thrown when a step's `environments` does not name the run's environment. */
export class StepEnvironmentRefusedError extends Error {
  constructor(public readonly refusals: readonly StepEnvironmentRefusal[]) {
    super(refusals.map((r) => r.message).join("\n"));
    this.name = "StepEnvironmentRefusedError";
  }
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether `step` carries inputs per environment. */
export function hasStepEnvironments(step: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(step, STEP_ENVIRONMENTS_KEY);
}

/** The environments a step names, in the order it names them; empty for a step with none. */
export function stepEnvironmentNames(step: Record<string, unknown>): string[] {
  const map = step[STEP_ENVIRONMENTS_KEY];
  return isMap(map) ? Object.keys(map) : [];
}

/** Why the map itself cannot be read, or undefined. */
function malformed(map: unknown): string | undefined {
  if (!isMap(map) || Object.keys(map).length === 0) return "takes a map from environment name to the step's inputs there";
  for (const [env, entry] of Object.entries(map)) {
    if (!isMap(entry)) return `names ${env} with ${Array.isArray(entry) ? "a list" : typeof entry}, where it takes a map of the step's inputs`;
    for (const key of ["kind", STEP_ENVIRONMENTS_KEY]) {
      if (key in entry) return `sets \`${key}\` under ${env}, which is the same in every environment`;
    }
  }
  return undefined;
}

/**
 * The name of the entry `env` takes in a map keyed by environment name:
 * itself, or for a pull request environment `pr-<n>` its template's (the
 * template's name, or the last segment of a template that names a stack).
 * Undefined when the map names neither. A step's `environments` and an
 * environment's config and secret set (./environment-sets.ts, #5348) pick
 * their entry with it, so both read the run's environment the same way.
 */
export function environmentEntryName(map: Record<string, unknown>, env: string, options: StepEnvironmentOptions = {}): string | undefined {
  if (env in map) return env;
  if (!PR_ENV.test(env)) return undefined;
  const template = options.template ?? (options.processEnv ?? process.env)[TEMPLATE_VAR];
  if (!template) return undefined;
  if (template in map) return template;
  const last = template.split("/").pop();
  return last !== undefined && last in map ? last : undefined;
}

/**
 * `step` with its `environments` resolved for `env`, or the reason it
 * cannot run there. A step with no `environments` comes back as it is.
 */
export function stepForEnvironment<T extends Record<string, unknown>>(
  step: T,
  env: string,
  options: StepEnvironmentOptions = {},
): { step: T } | { error: string; named: string[] } {
  if (!hasStepEnvironments(step)) return { step };
  const map = step[STEP_ENVIRONMENTS_KEY];
  const bad = malformed(map);
  if (bad !== undefined) return { error: `its \`${STEP_ENVIRONMENTS_KEY}\` ${bad}`, named: [] };
  const named = Object.keys(map as Record<string, unknown>);
  const name = environmentEntryName(map as Record<string, unknown>, env, options);
  if (name === undefined) {
    const template = PR_ENV.test(env) ? options.template ?? (options.processEnv ?? process.env)[TEMPLATE_VAR] : undefined;
    const via = template ? `, nor its template ${template}` : "";
    return { error: `its \`${STEP_ENVIRONMENTS_KEY}\` names ${named.join(", ")}, and not ${env}${via}`, named };
  }
  const { [STEP_ENVIRONMENTS_KEY]: _map, ...rest } = step;
  return { step: { ...rest, ...((map as Record<string, Record<string, unknown>>)[name]) } as T };
}

/** A gate's name, from `gate` or the deprecated `signalName` (`gateName` in ../op/gate-name.ts). */
const gateNameOf = (step: Record<string, unknown>): string =>
  typeof step.gate === "string" ? step.gate : typeof step.signalName === "string" ? step.signalName : "";

/** A gate's `environments` as a map, or why it cannot be read. A list names environments with empty entries. */
function gateEnvironmentMap(value: unknown): { map: Record<string, Record<string, unknown>> } | { error: string } {
  if (Array.isArray(value)) {
    if (value.length === 0) return { error: "takes a list of environment names, or a map from environment name to the gate's keys there" };
    const seen = new Set<string>();
    for (const name of value) {
      if (typeof name !== "string" || name === "") return { error: `lists ${JSON.stringify(name)}, where it takes environment names` };
      if (seen.has(name)) return { error: `lists ${name} twice` };
      seen.add(name);
    }
    return { map: Object.fromEntries(value.map((name: string) => [name, {}])) };
  }
  if (!isMap(value) || Object.keys(value).length === 0) {
    return { error: "takes a list of environment names, or a map from environment name to the gate's keys there" };
  }
  for (const [env, entry] of Object.entries(value)) {
    if (!isMap(entry)) return { error: `names ${env} with ${Array.isArray(entry) ? "a list" : typeof entry}, where it takes a map of the gate's keys` };
    const other = Object.keys(entry).find((k) => !GATE_ENVIRONMENT_KEYS.includes(k));
    if (other !== undefined) return { error: `sets \`${other}\` under ${env}, where a gate's entry sets ${GATE_ENVIRONMENT_KEYS.map((k) => `\`${k}\``).join(", ")}` };
  }
  return { map: value as Record<string, Record<string, unknown>> };
}

/** The environments a gate step names, in the order it names them; empty for a gate with none or a malformed one. */
export function gateEnvironmentNames(step: Record<string, unknown>): string[] {
  if (!hasStepEnvironments(step)) return [];
  const read = gateEnvironmentMap(step[STEP_ENVIRONMENTS_KEY]);
  return "map" in read ? Object.keys(read.map) : [];
}

/**
 * A gate step resolved for `env` (#5401): the gate with its entry merged and
 * `environments` removed when it applies there, the skip when it does not,
 * or why its `environments` cannot be read. A gate with no `environments`
 * comes back as it is.
 */
export function gateForEnvironment<T extends Record<string, unknown>>(
  step: T,
  env: string,
  options: StepEnvironmentOptions = {},
): { step: T } | { skipped: SkippedGate } | { error: string; named: string[] } {
  if (!hasStepEnvironments(step)) return { step };
  const read = gateEnvironmentMap(step[STEP_ENVIRONMENTS_KEY]);
  if ("error" in read) return { error: `its \`${STEP_ENVIRONMENTS_KEY}\` ${read.error}`, named: [] };
  const name = environmentEntryName(read.map, env, options);
  if (name === undefined) return { skipped: { gate: gateNameOf(step), environments: Object.keys(read.map) } };
  const { [STEP_ENVIRONMENTS_KEY]: _map, ...rest } = step;
  return { step: { ...rest, ...read.map[name] } as T };
}

/**
 * A step's input with its `environments` resolved for `env`. Throws a
 * {@link StepEnvironmentRefusedError} when the step does not name it. For
 * the places that hand a capability its input; a resolved step comes back
 * as it is.
 */
export function stepInputForEnvironment<T extends Record<string, unknown>>(
  input: T,
  env: string,
  at: { component: string; phase: string; kind: string },
  options: StepEnvironmentOptions = {},
): T {
  const resolved = stepForEnvironment(input, env, options);
  if ("step" in resolved) return resolved.step;
  throw new StepEnvironmentRefusedError([refusalOf(at, env, resolved)]);
}

function refusalOf(at: { component: string; phase: string; kind: string }, env: string, failed: { error: string; named: string[] }): StepEnvironmentRefusal {
  return {
    ...at,
    env,
    named: failed.named,
    message: `component "${at.component}": its ${at.kind} step in phase "${at.phase}" can't run in ${env}: ${failed.error}`,
  };
}

interface PhaseShape {
  phase: string;
  steps: unknown[];
  onFailure?: PhaseShape[];
  /** The gates taken out of this phase for the run's environment (#5401). */
  skippedGates?: SkippedGate[];
}

interface ComponentShape {
  name: string;
  deploy: PhaseShape[];
  verify?: PhaseShape[];
  rollback?: PhaseShape[];
}

const isPhase = (s: unknown): s is PhaseShape => isMap(s) && typeof s.phase === "string" && Array.isArray(s.steps);

/**
 * `component` with every step's `environments` resolved for `env`, through
 * `deploy`, `verify`, `rollback`, nested phases and `onFailure`, and the
 * steps that cannot run there. A step that cannot is left as it is, so a
 * caller that does not run the component can still read it. A gate step
 * that does not apply in `env` is taken out of its phase and listed on the
 * phase's `skippedGates` and in `skippedGates` here (#5401). A component
 * with no such step comes back as the same object.
 */
export function componentForEnvironment<C extends ComponentShape>(
  component: C,
  env: string,
  options: StepEnvironmentOptions = {},
): { component: C; refusals: StepEnvironmentRefusal[]; skippedGates: SkippedGateAt[] } {
  const refusals: StepEnvironmentRefusal[] = [];
  const skippedGates: SkippedGateAt[] = [];
  let changed = false;
  const walkPhase = (phase: PhaseShape): PhaseShape => {
    let touched = false;
    const skippedHere: SkippedGate[] = [];
    const steps = phase.steps.flatMap((step) => {
      if (isPhase(step)) {
        const next = walkPhase(step);
        if (next !== step) touched = true;
        return [next];
      }
      if (!isMap(step) || !hasStepEnvironments(step)) return [step];
      const at = { component: component.name, phase: phase.phase, kind: String(step.kind) };
      if (step.kind === "gate") {
        const gate = gateForEnvironment(step, env, options);
        if ("error" in gate) {
          refusals.push(refusalOf({ ...at, kind: `gate "${gateNameOf(step)}"` }, env, gate));
          return [step];
        }
        touched = true;
        if ("step" in gate) return [gate.step];
        skippedHere.push(gate.skipped);
        skippedGates.push({ component: component.name, phase: phase.phase, ...gate.skipped });
        return [];
      }
      const resolved = stepForEnvironment(step, env, options);
      if ("error" in resolved) {
        refusals.push(refusalOf(at, env, resolved));
        return [step];
      }
      touched = true;
      return [resolved.step];
    });
    const onFailure = phase.onFailure?.map(walkPhase);
    if (onFailure?.some((p, i) => p !== phase.onFailure![i])) touched = true;
    if (!touched) return phase;
    changed = true;
    return {
      ...phase,
      steps,
      ...(onFailure ? { onFailure } : {}),
      ...(skippedHere.length > 0 ? { skippedGates: [...(phase.skippedGates ?? []), ...skippedHere] } : {}),
    };
  };
  const walk = (phases: PhaseShape[] | undefined): PhaseShape[] | undefined => phases?.map(walkPhase);
  const deploy = walk(component.deploy)!;
  const verify = walk(component.verify);
  const rollback = walk(component.rollback);
  if (!changed) return { component, refusals, skippedGates };
  return {
    component: { ...component, deploy, ...(verify ? { verify } : {}), ...(rollback ? { rollback } : {}) },
    refusals,
    skippedGates,
  };
}

/** The gate steps a component skips, read off its resolved phases' `skippedGates`, nested phases and `onFailure` included (#5401). */
export function skippedGatesOf(component: ComponentShape): SkippedGateAt[] {
  const out: SkippedGateAt[] = [];
  const walk = (phase: PhaseShape): void => {
    for (const s of phase.skippedGates ?? []) out.push({ component: component.name, phase: phase.phase, ...s });
    for (const step of phase.steps) if (isPhase(step)) walk(step);
    phase.onFailure?.forEach(walk);
  };
  for (const phases of [component.deploy, component.verify, component.rollback]) phases?.forEach(walk);
  return out;
}

/** One gate that names an environment the member does not declare (#5401). */
export interface UnknownGateEnvironment {
  component: string;
  phase: string;
  gate: string;
  /** The names it gives that are not declared. */
  unknown: string[];
  message: string;
}

/**
 * Every gate step whose `environments` names an environment outside
 * `declared`, or cannot be read, for `chant build` to refuse (#5401). A gate
 * that names a misspelt environment would otherwise be skipped in the one it
 * was meant for. `declared` holds the member's `environments`, its
 * pipeline's stages and each component's own `environments`.
 */
export function unknownGateEnvironments(components: readonly ComponentShape[], declared: ReadonlySet<string>): UnknownGateEnvironment[] {
  const out: UnknownGateEnvironment[] = [];
  const known = [...declared].sort();
  const knownText = known.length > 0 ? `the member declares ${known.join(", ")}` : "the member declares no environments";
  for (const component of components) {
    const walk = (phase: PhaseShape): void => {
      for (const step of phase.steps) {
        if (isPhase(step)) {
          walk(step);
          continue;
        }
        if (!isMap(step) || step.kind !== "gate" || !hasStepEnvironments(step)) continue;
        const gate = gateNameOf(step);
        const where = `component "${component.name}": gate "${gate}" in phase "${phase.phase}"`;
        const read = gateEnvironmentMap(step[STEP_ENVIRONMENTS_KEY]);
        if ("error" in read) {
          out.push({ component: component.name, phase: phase.phase, gate, unknown: [], message: `${where}: its \`${STEP_ENVIRONMENTS_KEY}\` ${read.error}` });
          continue;
        }
        const unknown = Object.keys(read.map).filter((name) => !declared.has(name));
        if (unknown.length > 0) {
          out.push({ component: component.name, phase: phase.phase, gate, unknown, message: `${where} names ${unknown.join(", ")} in \`${STEP_ENVIRONMENTS_KEY}\`, and ${knownText}` });
        }
      }
      phase.onFailure?.forEach(walk);
    };
    for (const phases of [component.deploy, component.verify, component.rollback]) phases?.forEach(walk);
  }
  return out;
}

/**
 * Every component resolved for `env`. Throws a
 * {@link StepEnvironmentRefusedError} naming each step that cannot run
 * there, with the environments it names, before anything runs.
 */
export function componentsForEnvironment<C extends ComponentShape>(components: readonly C[], env: string, options: StepEnvironmentOptions = {}): C[] {
  const refusals: StepEnvironmentRefusal[] = [];
  const out = components.map((c) => {
    const resolved = componentForEnvironment(c, env, options);
    refusals.push(...resolved.refusals);
    return resolved.component;
  });
  if (refusals.length > 0) throw new StepEnvironmentRefusedError(refusals);
  return out;
}
