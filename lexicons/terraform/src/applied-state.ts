/**
 * What applied, read from `show -json` of a plan made after the apply: its
 * `prior_state` is the state the apply left (chant#4445). choudoufu refuses a
 * bare `show` under a `live` block, since there is no state file to show, so
 * a post-apply plan is the one place its applied values can be read.
 *
 * `chant terraform report` (`./report.ts`) and the composed estate run
 * (`./compose/estate.ts`) both read through {@link priorStateValues}.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The `values` of the state a `show -json` holds: a plan's `prior_state`, or
 * a state's own `values` when it is a `show -json` of state. Undefined when
 * it holds neither.
 */
export function priorStateValues(show: unknown): Json | undefined {
  const root = isObject(show) ? show : {};
  const state = isObject(root.prior_state) ? root.prior_state : root;
  return isObject(state.values) ? state.values : undefined;
}

/** One resource of a state: its values and its sensitivity map. */
export interface StateResourceValues {
  values: Json;
  sensitive: Json;
}

/** Every resource of the state a `show -json` holds, by address. A deposed object is left out. */
export function stateResources(show: unknown): Map<string, StateResourceValues> {
  const out = new Map<string, StateResourceValues>();
  const walk = (mod: unknown): void => {
    if (!isObject(mod)) return;
    for (const r of Array.isArray(mod.resources) ? mod.resources : []) {
      if (!isObject(r) || typeof r.address !== "string" || r.deposed_key !== undefined) continue;
      out.set(r.address, { values: isObject(r.values) ? r.values : {}, sensitive: isObject(r.sensitive_values) ? r.sensitive_values : {} });
    }
    for (const c of Array.isArray(mod.child_modules) ? mod.child_modules : []) walk(c);
  };
  walk(priorStateValues(show)?.root_module);
  return out;
}

/** The outputs of the state a `show -json` holds, by name, each its value. */
export function stateOutputs(show: unknown): Record<string, unknown> {
  const outputs = priorStateValues(show)?.outputs;
  if (!isObject(outputs)) return {};
  return Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, isObject(v) && "value" in v ? v.value : v]));
}
