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

/** The name of the entry `env` takes: itself, or a pull request environment's template. */
function entryName(map: Record<string, unknown>, env: string, options: StepEnvironmentOptions): string | undefined {
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
  const name = entryName(map as Record<string, unknown>, env, options);
  if (name === undefined) {
    const template = PR_ENV.test(env) ? options.template ?? (options.processEnv ?? process.env)[TEMPLATE_VAR] : undefined;
    const via = template ? `, nor its template ${template}` : "";
    return { error: `its \`${STEP_ENVIRONMENTS_KEY}\` names ${named.join(", ")}, and not ${env}${via}`, named };
  }
  const { [STEP_ENVIRONMENTS_KEY]: _map, ...rest } = step;
  return { step: { ...rest, ...((map as Record<string, Record<string, unknown>>)[name]) } as T };
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
 * caller that does not run the component can still read it. A component
 * with no such step comes back as the same object.
 */
export function componentForEnvironment<C extends ComponentShape>(
  component: C,
  env: string,
  options: StepEnvironmentOptions = {},
): { component: C; refusals: StepEnvironmentRefusal[] } {
  const refusals: StepEnvironmentRefusal[] = [];
  let changed = false;
  const walkPhase = (phase: PhaseShape): PhaseShape => {
    let touched = false;
    const steps = phase.steps.map((step) => {
      if (isPhase(step)) {
        const next = walkPhase(step);
        if (next !== step) touched = true;
        return next;
      }
      if (!isMap(step) || step.kind === "gate" || !hasStepEnvironments(step)) return step;
      const resolved = stepForEnvironment(step, env, options);
      if ("error" in resolved) {
        refusals.push(refusalOf({ component: component.name, phase: phase.phase, kind: String(step.kind) }, env, resolved));
        return step;
      }
      touched = true;
      return resolved.step;
    });
    const onFailure = phase.onFailure?.map(walkPhase);
    if (onFailure?.some((p, i) => p !== phase.onFailure![i])) touched = true;
    if (!touched) return phase;
    changed = true;
    return { ...phase, steps, ...(onFailure ? { onFailure } : {}) };
  };
  const walk = (phases: PhaseShape[] | undefined): PhaseShape[] | undefined => phases?.map(walkPhase);
  const deploy = walk(component.deploy)!;
  const verify = walk(component.verify);
  const rollback = walk(component.rollback);
  if (!changed) return { component, refusals };
  return {
    component: { ...component, deploy, ...(verify ? { verify } : {}), ...(rollback ? { rollback } : {}) },
    refusals,
  };
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
