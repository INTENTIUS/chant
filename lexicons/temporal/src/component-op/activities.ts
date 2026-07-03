/**
 * Generic capability-dispatch activities for the durable component path
 * (#589, epic #551). Two activities, both capability-agnostic — neither
 * branches on a component or capability `kind`; both dispatch purely through
 * the shared `CapabilityRegistry` (`@intentius/chant/components`), the same
 * registry the local interpret driver dispatches through.
 *
 *   - `runCapabilityStep`      — resolve a step's wiring against the
 *     accumulated `phaseOutputs`/`componentOutputs`, then run its capability.
 *   - `rollbackCapabilityStep` — same resolution, but calls the capability's
 *     `rollback` (a no-op record if the capability declares none — mirrors
 *     `driver.ts`'s `rollback-opted-out` reporting, logged rather than
 *     returned since an activity's return value only feeds the workflow's
 *     `phaseOutputs`, not its run-result rendering).
 *
 * These run in a real Node process (a Temporal activity, not the workflow
 * sandbox), so they can freely use the capability registry's real cloud
 * calls (child_process, fs, network) exactly like any other Op activity
 * (see ../op/activities/*.ts).
 *
 * The registry is built once per worker process (module-level cache) rather
 * than per activity invocation — capability plugin loading does dynamic
 * `import()`s that are wasteful to repeat on every step.
 */

import {
  buildCapabilityRegistry,
  resolveStepInput,
  type CapabilityRegistry,
  type DeployContext,
} from "@intentius/chant/components";

export interface CapabilityStepArgs {
  /** The step as authored (`{ kind, ...fields }`), including any unresolved wiring references. */
  step: Record<string, unknown>;
  /** Phase name the step belongs to (search-attribute/logging context; also the key `phaseOutputs` is grouped under). */
  phase: string;
  /** Component name this run belongs to. */
  component: string;
  /** Target environment name. Defaults to "local" — matching `runComponents`' default (../../../packages/core/src/components/cli-support.ts). */
  env?: string;
  /** Arbitrary environment config resolved by the caller (registry URLs, cluster names, ...) — mirrors `DeployContext.vars` / `InterpretRunOptions.vars` (../../../packages/core/src/components/driver.ts). */
  vars?: Record<string, unknown>;
  /** Prior steps' outputs within this component run, keyed by phase name — mirrors `driver.ts`'s `phaseOutputs`. */
  phaseOutputs: Record<string, Record<string, unknown>>;
  /** Other components' published outputs — mirrors `driver.ts`'s `componentOutputs`. */
  componentOutputs: Record<string, Record<string, unknown>>;
}

let cachedRegistry: Promise<CapabilityRegistry> | undefined;

/** Build (once) or return the cached capability registry for this worker process. */
function getRegistry(): Promise<CapabilityRegistry> {
  if (!cachedRegistry) cachedRegistry = buildCapabilityRegistry();
  return cachedRegistry;
}

/**
 * Run one capability step durably. Resolves the step's wiring
 * (`@Phase.field` / `@<component>.publish.*` / `stackOutput`) against the
 * outputs accumulated so far via the exact same `resolveStepInput` the local
 * executor calls (`@intentius/chant/components`), then dispatches to the
 * capability registered for `step.kind`. Returns the capability's output so
 * the calling workflow can merge it into `phaseOutputs`.
 */
export async function runCapabilityStep(args: CapabilityStepArgs): Promise<unknown> {
  const { kind, ...rest } = args.step;
  const registry = await getRegistry();
  const resolvedInput = resolveStepInput(rest, args.phaseOutputs, args.componentOutputs);
  const ctx: DeployContext = { env: args.env ?? "local", component: args.component, vars: args.vars };
  const capability = registry.resolve(kind as string);
  return capability.run(ctx, resolvedInput as never);
}

/**
 * Roll back one already-executed capability step durably — the Temporal
 * counterpart to `driver.ts`'s `rollbackExecuted`, called once per executed
 * step in reverse order by the generated workflow. Best-effort: a capability
 * with no `rollback` is a no-op (logged, not thrown) rather than failing the
 * unwind, matching the local executor's `"rollback-opted-out"` handling.
 */
export async function rollbackCapabilityStep(args: CapabilityStepArgs): Promise<void> {
  const { kind, ...rest } = args.step;
  const registry = await getRegistry();
  const resolvedInput = resolveStepInput(rest, args.phaseOutputs, args.componentOutputs);
  const ctx: DeployContext = { env: args.env ?? "local", component: args.component, vars: args.vars };
  const capability = registry.resolve(kind as string);
  if (!capability.rollback) {
    const reason = typeof (rest as Record<string, unknown>).noRollback === "string"
      ? (rest as Record<string, unknown>).noRollback
      : `capability "${kind as string}" declares no rollback and the step has no "noRollback" reason`;
    console.warn(`[rollback-opted-out] component="${args.component}" phase="${args.phase}" kind="${kind as string}": ${reason as string}`);
    return;
  }
  await capability.rollback(ctx, resolvedInput as never);
}
