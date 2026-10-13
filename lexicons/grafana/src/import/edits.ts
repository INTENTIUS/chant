/**
 * What the importer did to a dashboard on the way to TypeScript, as edits
 * to its JSON.
 *
 * Every key the importer leaves out, and every value it writes in another
 * form, is one edit, and every edit that changes what Grafana does comes
 * with an import warning. The round-trip test applies the edits to the
 * source dashboard and expects the rebuilt dashboard to equal the result
 * (after `normalizeDashboard`), which is how it checks that nothing is
 * dropped without a warning.
 */

import { isObject } from "./normalize";

type Json = Record<string, unknown>;

export type ImportEdit =
  /** The value at `path` (a JSON pointer) is not carried. */
  | { readonly op: "remove"; readonly path: string }
  /** The value at `path` is written as `value`. */
  | { readonly op: "replace"; readonly path: string; readonly value: unknown }
  /** Every string in the dashboard has `from` replaced by `to` (an `__inputs` constant filled in). */
  | { readonly op: "substitute"; readonly from: string; readonly to: string }
  /** `value` is added at the front of `templating.list` (an `__inputs` datasource as a variable). */
  | { readonly op: "prependVariable"; readonly value: Json };

/** `/a/b/0` as its unescaped segments. */
export function pointerSegments(path: string): string[] {
  if (path === "") return [];
  return path
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** A JSON pointer from segments. */
export function pointer(...segments: Array<string | number>): string {
  return segments.map((s) => `/${String(s).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

function substitute(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((v) => substitute(v, from, to));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, from, to)]));
  return value;
}

const REMOVED = Symbol("removed");

function parentOf(root: unknown, segments: string[]): unknown {
  let node = root;
  for (const s of segments.slice(0, -1)) {
    if (Array.isArray(node)) node = node[Number(s)];
    else if (isObject(node)) node = node[s];
    else return undefined;
  }
  return node;
}

function sweep(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== REMOVED).map(sweep);
  if (isObject(value)) {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) if (v !== REMOVED) out[k] = sweep(v);
    return out;
  }
  return value;
}

/**
 * The dashboard with the edits applied: substitutions first, then
 * replacements and removals (all by pointers into the original), then the
 * prepended variables.
 */
export function applyEdits(dashboard: Json, edits: readonly ImportEdit[]): Json {
  let doc = structuredClone(dashboard) as unknown;
  for (const e of edits) if (e.op === "substitute") doc = substitute(doc, e.from, e.to);
  for (const e of edits) {
    if (e.op !== "replace" && e.op !== "remove") continue;
    const segments = pointerSegments(e.path);
    const parent = parentOf(doc, segments);
    const last = segments[segments.length - 1];
    const value = e.op === "replace" ? e.value : REMOVED;
    if (Array.isArray(parent)) parent[Number(last)] = value;
    else if (isObject(parent)) parent[last] = value;
  }
  const out = sweep(doc) as Json;
  const prepend = edits.filter((e): e is Extract<ImportEdit, { op: "prependVariable" }> => e.op === "prependVariable").map((e) => e.value);
  if (prepend.length > 0) {
    const templating = isObject(out.templating) ? out.templating : {};
    const list = Array.isArray(templating.list) ? templating.list : [];
    out.templating = { ...templating, list: [...prepend, ...list] };
  }
  return out;
}
