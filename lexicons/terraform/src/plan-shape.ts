/**
 * The plan shape of a terraform-family root (#4436): what `terraform show
 * -json` says a plan does, without the values, in the form core's
 * `coveredRound` compares (#4419). `terraform-apply`'s `plan` returns it, and
 * terragucci calls it for the plan JSON of a note (terragucci#1268).
 *
 * Like `./change-set`, this module imports only `@intentius/chant` subpaths,
 * never the lexicon's entry point.
 */

import type { PlanShape, PlanShapeEntry, ShapeReplacement } from "@intentius/chant/components/covered-round";
import { normalizePlanShape } from "@intentius/chant/components/covered-round";
import { actionFor } from "./change-set";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** Whether an `after_unknown` value marks anything under it unknown. */
function marks(v: unknown): boolean {
  if (v === true) return true;
  if (Array.isArray(v)) return v.some(marks);
  if (isObject(v)) return Object.values(v).some(marks);
  return false;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && sameJson(a[k], b[k]));
  }
  return false;
}

/** Whether the value at `path` in an `after_unknown` tree is unknown: `true` at the path or on a prefix of it. */
function unknownAt(tree: unknown, path: unknown[]): boolean {
  let at: unknown = tree;
  for (const step of path) {
    if (at === true) return true;
    if (Array.isArray(at) && typeof step === "number") at = at[step];
    else if (isObject(at) && typeof step === "string") at = at[step];
    else return false;
  }
  return marks(at);
}

/**
 * How a change replaces its resource. A `replace_paths` entry names an
 * attribute whose change forces it. When every such attribute is unknown
 * after apply, the plan cannot say the value will differ, so the replacement
 * is `conditional`; one with a known forcing attribute is `true`. A delete
 * and create pair with no `replace_paths` (a tainted object, `-replace`) is
 * `true`. An update with none replaces nothing (`false`); a create or delete
 * has no replacement to state.
 */
function replacementFor(change: Json, action: string): ShapeReplacement | undefined {
  const paths = (Array.isArray(change.replace_paths) ? change.replace_paths : []).filter(Array.isArray) as unknown[][];
  if (paths.length > 0) return paths.every((p) => unknownAt(change.after_unknown, p)) ? "conditional" : "true";
  if (action === "replace") return "true";
  if (action === "update") return "false";
  return undefined;
}

export interface TerraformPlanShapeOptions {
  /** The inputs the plan was made without, as `<component>.<output>`. */
  unknownInputs?: string[];
  /** The inputs the plan read with a value, by reference. */
  knownInputs?: Record<string, unknown>;
}

/**
 * The shape of `planJson` (`terraform show -json`, from terraform, tofu or
 * choudoufu) for `member`.
 *
 * One entry per `resource_changes` item that is not `no-op` or `read`.
 * `logicalId` is the address, with `#<deposed>` for a deposed object. `type`
 * is the resource type. `properties` are the top-level attributes that differ
 * between `before` and `after` (on a create, those the plan sets or leaves
 * unknown), and `unknown` the ones `after_unknown` marks, so `unknown` is
 * within `properties`. A delete has no properties. Values never enter it, so
 * a sensitive attribute is only a name.
 */
export function terraformPlanShape(planJson: unknown, member: string, options: TerraformPlanShapeOptions = {}): PlanShape {
  const plan = isObject(planJson) ? planJson : {};
  const raw = Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
  const entries: PlanShapeEntry[] = [];
  for (const r of raw) {
    const rc = isObject(r) ? r : {};
    const change = isObject(rc.change) ? rc.change : {};
    const action = actionFor(change.actions);
    if (action === "no-op" || action === "read") continue;
    const address = String(rc.address ?? "");
    const before = isObject(change.before) ? change.before : {};
    const after = isObject(change.after) ? change.after : {};
    const afterUnknown = isObject(change.after_unknown) ? change.after_unknown : {};
    const properties: string[] = [];
    const unknown: string[] = [];
    if (action !== "delete" && action !== "forget") {
      for (const k of new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(afterUnknown)])) {
        const isUnknown = marks(afterUnknown[k]);
        const differs =
          action === "create"
            ? isUnknown || (after[k] !== undefined && after[k] !== null)
            : isUnknown || !sameJson(before[k] ?? null, after[k] ?? null);
        if (!differs) continue;
        properties.push(k);
        if (isUnknown) unknown.push(k);
      }
    }
    const replacement = replacementFor(change, action);
    entries.push({
      logicalId: typeof rc.deposed === "string" ? `${address}#${rc.deposed}` : address,
      action,
      ...(replacement ? { replacement } : {}),
      ...(typeof rc.type === "string" ? { type: rc.type } : {}),
      properties,
      unknown,
    });
  }
  return normalizePlanShape({
    member,
    entries,
    unknownInputs: options.unknownInputs ?? [],
    ...(options.knownInputs ? { knownInputs: options.knownInputs } : {}),
  });
}
