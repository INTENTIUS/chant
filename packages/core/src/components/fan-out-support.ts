/**
 * Discovery-to-plan wiring for `chant components fan-out` (#2420).
 *
 * `./cli-support.ts` does this for `chant run --components`: the CLI handler
 * stays a thin dispatcher and the component-specific work lives beside the
 * rest of the component subsystem. This is the same seam for the fan-out, and
 * it exists mostly so the join can be tested against a real discovery result
 * without a CLI, a git repo or a cloud.
 *
 * Nothing here decides anything. `componentsForUnits` joins the stack-level
 * change signal to components, `planFanOut` derives the order, and both live
 * in ./fan-out.ts. This finds the components those two need and hands them
 * over.
 */

import { resolveComponentTargets } from "./cli-support";
import { applyConfigDefaults } from "./config-defaults";
import { buildCapabilityRegistry } from "./capability-plugin-loader";
import { componentsForUnits, planFanOut, type ChangedUnits, type ComponentChangeSignal, type FanOutPlan } from "./fan-out";
import type { CapabilityRegistry } from "./capability";
import type { DriverComponent } from "./driver";
import type { BuildParamProvenance } from "../provenance";
import { loadChantConfig, type ChantConfig } from "../config";

export interface DeriveFanOutOptions {
  /** Project root to discover `*.component.ts` under. */
  path: string;
  /** The stack-level change signal, from `lifecycle affected` or from a caller who already had one. */
  units: ChangedUnits;
  sandbox?: boolean;
  /** chant #1108 — this invocation's resolved build-time parameters, so a `params.*` reference in a component file resolves. */
  buildParams?: BuildParamProvenance[];
  /** Already-loaded project config, when the caller read it for its own reasons. */
  config?: ChantConfig;
}

export interface DerivedFanOut {
  success: boolean;
  /**
   * Every component in the project, config defaults applied. The full set, not
   * the selection: ordering a subset is only possible against the whole graph
   * (./fan-out.ts), and the runner needs the unselected ones to work out what
   * a failure blocks.
   */
  components: DriverComponent[];
  /** What the stack-level signal meant in component terms, `unclaimed` included. */
  signal: ComponentChangeSignal;
  plan: FanOutPlan;
  error?: string;
}

const EMPTY_PLAN: FanOutPlan = { order: [], waves: [], skipped: [], seeds: [], indeterminate: [], digest: "" };
const EMPTY_SIGNAL: ComponentChangeSignal = { changed: [], indeterminate: [], unclaimed: [] };

/**
 * Discover the project's components and derive the fan-out for `units`.
 *
 * Selection is `"all"`'s, borrowed wholesale from `resolveComponentTargets`, so
 * a component a build parameter turned off (`enabled: false`, chant #1522) sits
 * out of a fan-out exactly as it sits out of `chant run --components all`. Two
 * commands disagreeing about which components exist would be worse than either
 * answer on its own.
 *
 * Resolves with `success: false` and an `error` rather than throwing on a
 * discovery failure; a cycle or an unknown `dependsOn` still throws out of
 * `planFanOut`, which is #2417's "refuse by name, before anything is selected".
 */
export async function deriveFanOut(options: DeriveFanOutOptions): Promise<DerivedFanOut> {
  const resolved = await resolveComponentTargets(options.path, "all", options.sandbox, options.buildParams);
  if (!resolved.success) {
    return { success: false, components: [], signal: EMPTY_SIGNAL, plan: EMPTY_PLAN, error: resolved.error };
  }

  const { config } = options.config ? { config: options.config } : await loadChantConfig(options.path);
  const components = resolved.targets.map((component) => applyConfigDefaults(component, config));

  const signal = componentsForUnits(components, options.units);
  const plan = planFanOut({
    components,
    changed: signal.changed,
    ...(signal.indeterminate.length > 0 ? { indeterminate: signal.indeterminate } : {}),
  });

  return { success: true, components, signal, plan };
}

/**
 * The capability registry a fan-out dispatches through — the project's own,
 * built exactly the way `runComponents` builds it, so a fan-out and a
 * `chant run --components` of the same component reach the same leaves.
 */
export async function fanOutRegistry(path: string, config?: ChantConfig): Promise<CapabilityRegistry> {
  const resolved = config ?? (await loadChantConfig(path)).config;
  return buildCapabilityRegistry({ plugins: resolved.capabilities, lexicons: resolved.lexicons });
}
