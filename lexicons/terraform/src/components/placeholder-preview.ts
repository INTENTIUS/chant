/**
 * Previewing a root whose `vars` read outputs not known yet (#4463).
 *
 * terraform takes no unknown variable, so such a root used to get no plan at
 * pull-request time, only a hole. Now it is planned with a stand-in for each
 * variable that holds no value yet, typed from the root's own `variable`
 * block ({@link terraformPlaceholder}). Every attribute and output the
 * stand-ins drive is then marked unknown after apply in the plan JSON
 * ({@link markPlaceholderDriven}) before the change set, the shape and the
 * planned outputs are read from it, so no stand-in value reaches the note or
 * the digest. The member's change-set part lists the variables under
 * `placeholders`.
 *
 * What a stand-in drives is read from the plan's own `configuration`: an
 * attribute whose expression references `var.<name>`, through module inputs
 * too, plus any string attribute or output whose planned value carries
 * {@link TERRAFORM_UNKNOWN_MARK}. A value that reaches an attribute another
 * way (a number through a `local`) is not marked; the fresh plan at apply
 * then differs from the preview and asks for an approval of its own, which
 * costs a round and never applies a change nobody approved.
 *
 * A preview is not possible when a variable that holds the unknown read is
 * not declared, when the unknown sits inside a larger value, when a `count`
 * or `for_each` reads a stand-in (the preview would show a count the real
 * value does not have), or when the placeholder plan fails, say on a
 * `validation` block. The member then stays a hole, as before, and the
 * hole's reason says why (the 2026-10-25 ruling on #4463).
 */

import type { ChangeSetHole } from "@intentius/chant/change-set";

/** The marker every string stand-in carries, so a reader can tell it from a real value. */
export const TERRAFORM_UNKNOWN_MARK = "known-after-apply";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** Split `text` on `sep` where no bracket is open. */
function splitTop(text: string, sep: string | RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' && text[i - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && (typeof sep === "string" ? c === sep : sep.test(c))) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/** `name(inner)` read off a type expression, or `undefined` when it is not one. */
function call(type: string, name: string): string | undefined {
  const m = type.match(new RegExp(`^${name}\\s*\\(([\\s\\S]*)\\)$`));
  return m ? m[1]!.trim() : undefined;
}

/**
 * A stand-in for a variable of `type`, a Terraform type expression as the
 * `variable` block writes it (`string`, `list(string)`, `object({ id = string })`).
 *
 * - `string`, `any` or no type: {@link TERRAFORM_UNKNOWN_MARK}.
 * - `number`: 0. `bool`: false.
 * - `list(...)`, `set(...)`: an empty list. `map(...)`: an empty map.
 * - `tuple([a, b])`: one stand-in per element type.
 * - `object({ a = t })`: one stand-in per attribute, `optional(t)` read as `t`.
 *
 * An empty collection plans no element, so a resource that iterates one
 * plans none; the fresh plan at apply then asks for its own approval.
 */
export function terraformPlaceholder(type: string | undefined): unknown {
  const t = (type ?? "").trim().replace(/^\$\{([\s\S]*)\}$/, "$1").trim();
  if (t === "" || t === "any" || t === "string") return TERRAFORM_UNKNOWN_MARK;
  if (t === "number") return 0;
  if (t === "bool") return false;
  const optional = call(t, "optional");
  if (optional !== undefined) return terraformPlaceholder(splitTop(optional, ",")[0]);
  if (call(t, "list") !== undefined || call(t, "set") !== undefined) return [];
  if (call(t, "map") !== undefined) return {};
  const tuple = call(t, "tuple");
  if (tuple !== undefined) {
    const inner = tuple.replace(/^\[([\s\S]*)\]$/, "$1");
    return splitTop(inner, ",").map((e) => terraformPlaceholder(e));
  }
  const object = call(t, "object");
  if (object !== undefined) {
    const inner = object.replace(/^\{([\s\S]*)\}$/, "$1");
    const out: Record<string, unknown> = {};
    for (const attr of splitTop(inner, /[,\n]/)) {
      const at = attr.indexOf("=");
      if (at < 0) continue;
      const name = attr.slice(0, at).trim().replace(/^"(.*)"$/, "$1");
      out[name] = terraformPlaceholder(attr.slice(at + 1));
    }
    return out;
  }
  return TERRAFORM_UNKNOWN_MARK;
}

const containsUndefined = (v: unknown): boolean =>
  v === undefined || (Array.isArray(v) ? v.some(containsUndefined) : isObject(v) ? Object.values(v).some(containsUndefined) : false);

/** The variables a preview gives stand-ins, and the `vars` it plans with. */
export interface PlaceholderVars {
  /** The variable names given a stand-in, sorted. */
  placeholders: string[];
  /** The step's `vars` with each of them replaced by its stand-in. */
  vars: Record<string, unknown>;
}

/**
 * The stand-ins for a step's `vars` (#4463): each variable whose value is
 * `undefined` (a `stackOutput()` read with nothing to read yet) gets
 * {@link terraformPlaceholder} of its declared type. Returns why instead when
 * no preview can be made: no variable holds the unknown read, one that does
 * is not declared in the root, or the unknown sits inside a larger value.
 */
export function placeholderVars(vars: Record<string, unknown> | undefined, declared: ReadonlyMap<string, { type?: string }>): PlaceholderVars | string {
  const given = vars ?? {};
  const placeholders: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(given)) {
    if (value === undefined) {
      const decl = declared.get(name);
      if (!decl) return `var.${name} holds the unknown read and the root declares no variable "${name}" to type a stand-in from`;
      placeholders.push(name);
      out[name] = terraformPlaceholder(decl.type);
    } else if (containsUndefined(value)) {
      return `the unknown read sits inside var.${name}, which a stand-in cannot fill in part`;
    } else out[name] = value;
  }
  if (placeholders.length === 0) return "no variable of the step holds the unknown read";
  return { placeholders: placeholders.sort(), vars: out };
}

/** Every `references` entry under an expression, at any depth (nested blocks are arrays of expression objects). */
function referencesIn(expr: unknown, out: string[] = []): string[] {
  if (Array.isArray(expr)) for (const e of expr) referencesIn(e, out);
  else if (isObject(expr)) {
    if (Array.isArray(expr.references)) for (const r of expr.references) if (typeof r === "string") out.push(r);
    for (const [k, v] of Object.entries(expr)) if (k !== "references" && k !== "constant_value") referencesIn(v, out);
  }
  return out;
}

const readsVar = (expr: unknown, vars: ReadonlySet<string>): boolean =>
  referencesIn(expr).some((r) => {
    const m = r.match(/^var\.([^.[]+)/);
    return m !== null && vars.has(m[1]!);
  });

/** What the stand-ins drive, from the plan's configuration. */
interface Driven {
  /** `<module path>|<mode>.<type>.<name>` to the top-level attributes a stand-in drives. */
  attributes: Map<string, Set<string>>;
  /** Root outputs whose expression reads a stand-in. */
  outputs: Set<string>;
  /** A `count` or `for_each` that reads a stand-in, by address: the preview cannot say how many. */
  expansions: string[];
}

const resourceKey = (modulePath: string, mode: string, type: string, name: string): string => `${modulePath}|${mode === "data" ? "data." : ""}${type}.${name}`;

function walkModule(mod: unknown, path: string, vars: ReadonlySet<string>, driven: Driven): void {
  if (!isObject(mod) || vars.size === 0) return;
  const at = (address: string) => (path ? `${path}.${address}` : address);
  for (const r of Array.isArray(mod.resources) ? mod.resources : []) {
    if (!isObject(r)) continue;
    const mode = String(r.mode ?? "managed");
    const address = String(r.address ?? `${r.type}.${r.name}`);
    if (readsVar(r.count_expression, vars) || readsVar(r.for_each_expression, vars)) driven.expansions.push(at(address));
    const exprs = isObject(r.expressions) ? r.expressions : {};
    const attrs = new Set(Object.entries(exprs).filter(([, e]) => readsVar(e, vars)).map(([k]) => k));
    if (attrs.size > 0) driven.attributes.set(resourceKey(path, mode, String(r.type), String(r.name)), attrs);
  }
  for (const [name, c] of Object.entries(isObject(mod.module_calls) ? mod.module_calls : {})) {
    if (!isObject(c)) continue;
    if (readsVar(c.count_expression, vars) || readsVar(c.for_each_expression, vars)) driven.expansions.push(at(`module.${name}`));
    const exprs = isObject(c.expressions) ? c.expressions : {};
    const inputs = new Set(Object.entries(exprs).filter(([, e]) => readsVar(e, vars)).map(([k]) => k));
    walkModule(c.module, at(`module.${name}`), inputs, driven);
  }
  if (path === "") {
    for (const [name, o] of Object.entries(isObject(mod.outputs) ? mod.outputs : {})) {
      if (isObject(o) && readsVar(o.expression, vars)) driven.outputs.add(name);
    }
  }
}

const carriesMark = (v: unknown): boolean =>
  typeof v === "string" ? v.includes(TERRAFORM_UNKNOWN_MARK) : Array.isArray(v) ? v.some(carriesMark) : isObject(v) ? Object.values(v).some(carriesMark) : false;

/** A `resource_changes` item's key in {@link Driven.attributes}: its module path without instance keys. */
function changeKey(rc: Json): string {
  const modulePath = typeof rc.module_address === "string" ? rc.module_address.replace(/\[[^\]]*\]/g, "") : "";
  return resourceKey(modulePath, String(rc.mode ?? "managed"), String(rc.type), String(rc.name));
}

/** What {@link markPlaceholderDriven} returns. */
export type MarkedPlan = { plan: unknown } | { refused: string };

/**
 * `planJson` (`show -json` of the placeholder plan) with every attribute and
 * root output the stand-ins for `placeholders` drive marked unknown after
 * apply, their planned values dropped. Returns why instead when a `count` or
 * `for_each` reads a stand-in. The input is not changed.
 */
export function markPlaceholderDriven(planJson: unknown, placeholders: readonly string[]): MarkedPlan {
  const plan = structuredClone(isObject(planJson) ? planJson : {}) as Json;
  const driven: Driven = { attributes: new Map(), outputs: new Set(), expansions: [] };
  const config = isObject(plan.configuration) ? plan.configuration : {};
  walkModule(config.root_module, "", new Set(placeholders), driven);
  if (driven.expansions.length > 0) {
    return { refused: `the count or for_each of ${[...new Set(driven.expansions)].sort().join(", ")} reads a stand-in, so the preview cannot say how many instances there are` };
  }
  for (const r of Array.isArray(plan.resource_changes) ? plan.resource_changes : []) {
    if (!isObject(r) || !isObject(r.change)) continue;
    const change = r.change;
    const after = isObject(change.after) ? change.after : undefined;
    const attrs = new Set(driven.attributes.get(changeKey(r)) ?? []);
    for (const [k, v] of Object.entries(after ?? {})) if (carriesMark(v)) attrs.add(k);
    if (attrs.size === 0) continue;
    const afterUnknown = isObject(change.after_unknown) ? change.after_unknown : {};
    for (const k of attrs) {
      afterUnknown[k] = true;
      if (after) delete after[k];
    }
    change.after_unknown = afterUnknown;
  }
  const outputChanges = isObject(plan.output_changes) ? plan.output_changes : {};
  const plannedOutputs = isObject(plan.planned_values) && isObject(plan.planned_values.outputs) ? plan.planned_values.outputs : {};
  for (const [name, o] of Object.entries(outputChanges)) if (isObject(o) && carriesMark(o.after)) driven.outputs.add(name);
  for (const [name, o] of Object.entries(plannedOutputs)) if (isObject(o) && carriesMark(o.value)) driven.outputs.add(name);
  for (const name of driven.outputs) {
    const o = isObject(outputChanges[name]) ? (outputChanges[name] as Json) : (outputChanges[name] = {} as Json);
    delete o.after;
    o.after_unknown = true;
    delete plannedOutputs[name];
  }
  return { plan };
}

/** The hole a root keeps when its preview is not possible: the old reason, and why there is no preview. */
export function waitingHole(root: string, unresolved: readonly string[], why?: string): ChangeSetHole {
  return {
    address: root,
    type: "terraform_root",
    reason: `inputs from ${unresolved.join(", ")}; planned again once they apply${why ? `; no preview: ${why}` : ""}`,
  };
}
