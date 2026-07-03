/**
 * Dynamic loader for the durable component → Temporal codegen (#589, epic
 * #551 §5/§8). The actual `serializeComponent` generator lives in
 * `@intentius/chant-lexicon-temporal` (`src/component-op/serializer.ts`),
 * mirroring `Temporal::Op` codegen — core never statically depends on the
 * Temporal lexicon, the same boundary `../op/activity-registry.ts`'s
 * `loadActivities`/`loadProfiles` already keep for Op activities.
 */

import type { DriverComponent } from "./driver";

/** Target environment (and env-config) baked into the generated workflow at compile time — see `serializeComponent`'s docstring in the Temporal lexicon for why this can't be resolved at workflow-run time instead. */
export interface ComponentTemporalCodegenOptions {
  env?: string;
  vars?: Record<string, unknown>;
}

export interface ComponentTemporalCodegen {
  /** Serialize one component into `{ "components/<name>/workflow.ts": "...", ... }`. */
  serializeComponent(component: DriverComponent, options?: ComponentTemporalCodegenOptions): Record<string, string>;
  /** Deterministic workflow function name for a component (mirrors the generated `export async function <fn>()`). */
  componentWorkflowFnName(componentName: string): string;
}

/**
 * Dynamically import the Temporal lexicon's component codegen. Throws a
 * friendly error if the lexicon is not installed — the durable component
 * path needs the generator even though discovery/local execution never do.
 */
export async function loadComponentTemporalCodegen(): Promise<ComponentTemporalCodegen> {
  try {
    // Variable specifier so tsc does not statically resolve the optional dep.
    const spec = "@intentius/chant-lexicon-temporal/component-op/serializer";
    return (await import(spec)) as unknown as ComponentTemporalCodegen;
  } catch (err) {
    throw new Error(
      "no durable component codegen available — install `@intentius/chant-lexicon-temporal` " +
        `to run components with --temporal (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
