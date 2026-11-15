/**
 * A TypeScript type for a chart's values when the chart ships no
 * `values.schema.json`, inferred from its `values.yaml` defaults.
 *
 * Every member is optional, since an override sets any subset. An object's
 * keys are the ones `values.yaml` lists and no others, so a misspelled key
 * fails to typecheck. A default that says nothing about its type becomes
 * `unknown`: a `null` or empty value (`key:` or `key: ~`) is `unknown`, an
 * empty object (`podAnnotations: {}`) a map of `unknown`, an empty list an
 * array of `unknown`. An empty string is still a string. Keys are quoted
 * when they are not identifiers and never renamed.
 *
 * Where the defaults would reject a valid values file, the type is wider:
 *
 * - A map Kubernetes lets take any key is an open map: `nodeSelector`, any
 *   key ending in `Labels` or `Annotations`, and `limits` and `requests`.
 * - A quantity (`cpu`, `memory`, `storage`, `ephemeral-storage`, or a string
 *   such as `100m` or `128Mi`) is `string | number`, since `cpu: 1` and
 *   `cpu: "1"` mean the same.
 * - A key that `values.yaml` has only as a comment (`# storageClass: ""`) is
 *   an optional `unknown` member of the object the comment sits in.
 * - A subchart's values are merged in under its name or alias, and `global`
 *   is an open map. A dependency whose values the caller does not have is an
 *   open map.
 * - The members of a wrapper key such as Istio's
 *   `_internal_defaults_do_not_set` are read as members of the root.
 */

import { tsPropertyKey } from "@intentius/chant/codegen/json-schema-to-ts";

/** A dependency of the chart, with the files of the subchart it names when the caller has them. */
export interface SubchartValues {
  /** The dependency's name in `Chart.yaml`, which the subchart's values sit under. */
  name: string;
  /** The `alias` in `Chart.yaml`, which replaces the name. */
  alias?: string;
  /** `condition` in `Chart.yaml`: comma-separated value paths that switch it. */
  condition?: string;
  /** The parsed `values.yaml` of the subchart, absent when the subchart is not bundled. */
  values?: unknown;
  /** The text of that `values.yaml`, for its commented keys. */
  text?: string;
  /** The subchart's own dependencies. */
  dependencies?: SubchartValues[];
  /** Whether the dependency has `tags`. */
  tags?: boolean;
}

export interface ValuesTypeOptions {
  /** The text of `values.yaml`, to read commented-out keys from. */
  text?: string;
  /** The chart's dependencies from `Chart.yaml`. */
  dependencies?: SubchartValues[];
  /** Dotted keys whose members are read as members of the root. */
  valuesRoot?: string[];
}

/** The wrapper Istio's charts nest their defaults in. It is always unwrapped. */
export const DEFAULT_VALUES_ROOTS = ["_internal_defaults_do_not_set"];

/** The type expression for a parsed `values.yaml` document. */
export function inferValuesType(values: unknown, options: ValuesTypeOptions = {}): string {
  const root = buildShape(values, options);
  if (root.kind === "unknown") return "Record<string, unknown>";
  return render(root, "");
}

type Scalar = "string" | "number" | "boolean" | "quantity";

type Shape =
  | { kind: "unknown" }
  | { kind: "scalar"; type: Scalar }
  | { kind: "array"; element: Shape }
  | { kind: "object"; members: Map<string, Shape>; open?: boolean }
  | { kind: "map"; of?: "scalar" | "quantity" }
  | { kind: "union"; shapes: Shape[] };

function buildShape(values: unknown, options: ValuesTypeOptions): Shape {
  let root = shape(values, "");
  if (root.kind !== "object" && !options.dependencies?.length) return root;
  if (options.text) root = withCommentedKeys(root, options.text);
  for (const path of [...DEFAULT_VALUES_ROOTS, ...(options.valuesRoot ?? [])]) root = unwrap(root, path.split("."));
  if (options.dependencies?.length) root = withDependencies(root, options.dependencies);
  return root;
}

const QUANTITY_KEYS = new Set(["cpu", "memory", "storage", "ephemeral-storage"]);
const QUANTITY_VALUE = /^\d+(\.\d+)?([mkKMGTPE]i?)$/;
const OPEN_MAP_KEY = /^(nodeSelector|labels|annotations)$|(Labels|Annotations|NodeSelector)$/;
const QUANTITY_MAP_KEYS = new Set(["limits", "requests"]);
/** A name that holds files or free-form settings: `grafana.ini`, `values.yaml`, a mesh config. */
const FREE_FORM_KEY = /\.(ini|ya?ml|json|conf|toml|properties)$|^meshConfig$/;
/** Kubernetes API fragments that a chart's defaults fill in only in part. */
const API_FRAGMENT_KEYS = new Set([
  "securityContext", "podSecurityContext", "containerSecurityContext", "strategy", "deploymentStrategy", "updateStrategy",
  "rollingUpdate", "affinity", "livenessProbe", "readinessProbe", "startupProbe", "lifecycle", "resources",
]);
/** Lists of API objects, whose elements a default fills in only in part. */
const API_LIST_KEYS = new Set([
  "tolerations", "topologySpreadConstraints", "env", "extraEnv", "volumes", "extraVolumes", "volumeMounts", "extraVolumeMounts",
  "initContainers", "extraContainers", "hostAliases", "imagePullSecrets",
]);

function isScalar(v: unknown): boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v instanceof Date;
}

function shape(value: unknown, key: string, element = false): Shape {
  if (value === null || value === undefined) return { kind: "unknown" };
  if (typeof value === "string") {
    return { kind: "scalar", type: QUANTITY_KEYS.has(key) || QUANTITY_VALUE.test(value) ? "quantity" : "string" };
  }
  if (typeof value === "number") return { kind: "scalar", type: QUANTITY_KEYS.has(key) ? "quantity" : "number" };
  if (typeof value === "boolean") return { kind: "scalar", type: "boolean" };
  if (value instanceof Date) return { kind: "scalar", type: "string" };
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "array", element: { kind: "unknown" } };
    return { kind: "array", element: value.map((v) => shape(v, key, true)).reduce(merge) };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return { kind: "map" };
    if (!element && FREE_FORM_KEY.test(key)) return { kind: "map" };
    if (!element && entries.every(([, v]) => isScalar(v) || v === null)) {
      if (OPEN_MAP_KEY.test(key)) return { kind: "map", of: "scalar" };
      if (QUANTITY_MAP_KEYS.has(key)) return { kind: "map", of: "quantity" };
    }
    const members = new Map(entries.map(([k, v]) => [k, shape(v, k)] as [string, Shape]));
    const fragment = element ? API_LIST_KEYS.has(key) : API_FRAGMENT_KEYS.has(key);
    // A resources block takes limits and requests, whichever the default lists.
    if (!element && key === "resources") {
      for (const k of ["limits", "requests"]) if (!members.has(k)) members.set(k, { kind: "map", of: "quantity" });
    }
    return { kind: "object", members, ...(fragment ? { open: true } : {}) };
  }
  return { kind: "unknown" };
}

/** Combine the shapes of two list elements: objects merge their keys, anything else unions. */
function merge(a: Shape, b: Shape): Shape {
  if (a.kind === "unknown" || b.kind === "unknown") return { kind: "unknown" };
  if (a.kind === "object" && b.kind === "object") {
    const members = new Map(a.members);
    for (const [k, s] of b.members) members.set(k, members.has(k) ? merge(members.get(k)!, s) : s);
    return { kind: "object", members, ...(a.open || b.open ? { open: true } : {}) };
  }
  if (a.kind === "scalar" && b.kind === "scalar") {
    if (a.type === b.type) return a;
    if (a.type === "quantity" && b.type !== "boolean") return a;
    if (b.type === "quantity" && a.type !== "boolean") return b;
  }
  if (a.kind === "map" && b.kind === "map") return a.of === b.of ? a : { kind: "map" };
  if (a.kind === "array" && b.kind === "array") return { kind: "array", element: merge(a.element, b.element) };
  const shapes = [...(a.kind === "union" ? a.shapes : [a]), ...(b.kind === "union" ? b.shapes : [b])];
  return { kind: "union", shapes };
}

/** The object at `path`, when the path runs through objects only. */
function objectAt(root: Shape, path: string[]): (Shape & { kind: "object" }) | undefined {
  let node: Shape = root;
  for (const key of path) {
    if (node.kind !== "object") return undefined;
    const next = node.members.get(key);
    if (!next) return undefined;
    node = next;
  }
  return node.kind === "object" ? node : undefined;
}

// Commented-out keys -------------------------------------------------------

const KEY_LINE = /^(\s*)(?:"([^"]+)"|'([^']+)'|([^\s#:'"\-[{][^:#\s]*)):(?:\s|$)/;
const PROSE_KEYS = new Set(["ref", "see", "note", "notes", "example", "examples", "default", "defaults", "warning", "todo", "reference", "docs", "e.g", "i.e"]);

/**
 * The keys a `values.yaml` lists only in comments. A run of `#` lines
 * (`##` lines are prose) is read as commented-out YAML: its least indented
 * keys belong to the object whose keys sit at the run's own indentation.
 */
export function commentedKeys(text: string): Array<{ parent: string[]; key: string }> {
  const lines = text.split(/\r?\n/);
  const found: Array<{ parent: string[]; key: string }> = [];
  const stack: Array<{ indent: number; key: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const comment = /^(\s*)#(?!#)/.exec(lines[i]);
    if (!comment) {
      const m = KEY_LINE.exec(lines[i]);
      if (m) {
        while (stack.length && stack[stack.length - 1].indent >= m[1].length) stack.pop();
        stack.push({ indent: m[1].length, key: m[2] ?? m[3] ?? m[4] });
      }
      continue;
    }
    const column = comment[1].length;
    const block: string[] = [];
    while (i < lines.length && /^\s*#(?!#)/.test(lines[i]) && /^(\s*)/.exec(lines[i])![1].length === column) {
      block.push(lines[i].replace(/^\s*#\s?/, ""));
      i++;
    }
    i--;
    const keyed = block.map((l) => KEY_LINE.exec(l)).filter((m): m is RegExpExecArray => m !== null);
    if (!keyed.length) continue;
    const least = Math.min(...keyed.map((m) => m[1].length));
    // The keys that enclose the comment, outermost first.
    const chain: string[] = [];
    let limit = column;
    for (let j = stack.length - 1; j >= 0; j--) {
      if (stack[j].indent < limit) {
        chain.unshift(stack[j].key);
        limit = stack[j].indent;
      }
    }
    for (const m of keyed) {
      if (m[1].length !== least) continue;
      const key = m[2] ?? m[3] ?? m[4];
      if (/^[A-Z]/.test(key) || PROSE_KEYS.has(key.toLowerCase()) || key.endsWith(".")) continue;
      found.push({ parent: chain, key });
    }
  }
  return found;
}

function withCommentedKeys(root: Shape, text: string): Shape {
  for (const { parent, key } of commentedKeys(text)) {
    const target = objectAt(root, parent);
    if (target && !target.members.has(key)) target.members.set(key, { kind: "unknown" });
  }
  return root;
}

// Wrapper roots ---------------------------------------------------------------

/** Move the members of the object at `path` up into the object that holds it. */
function unwrap(root: Shape, path: string[]): Shape {
  const holder = objectAt(root, path.slice(0, -1));
  const wrapper = objectAt(root, path);
  if (!holder || !wrapper) return root;
  holder.members.delete(path[path.length - 1]);
  for (const [k, s] of wrapper.members) holder.members.set(k, holder.members.has(k) ? merge(holder.members.get(k)!, s) : s);
  return root;
}

// Subcharts ---------------------------------------------------------------------

function withDependencies(root: Shape, dependencies: SubchartValues[]): Shape {
  const top: Shape & { kind: "object" } =
    root.kind === "object" ? root : { kind: "object", members: new Map() };
  for (const dep of dependencies) {
    const key = dep.alias ?? dep.name;
    const sub = subchartShape(dep);
    const existing = top.members.get(key);
    if (existing?.kind === "object" && sub.kind === "object") mergeInto(existing, sub);
    else if (existing?.kind === "object") existing.open = true;
    else if (!existing || existing.kind === "unknown") top.members.set(key, sub);
    for (const path of (dep.condition ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
      const parts = path.split(".");
      let holder = top;
      for (const part of parts.slice(0, -1)) {
        const next = holder.members.get(part);
        if (next?.kind === "object") holder = next;
        else if (!next) {
          const created: Shape & { kind: "object" } = { kind: "object", members: new Map() };
          holder.members.set(part, created);
          holder = created;
        } else break;
      }
      if (!holder.members.has(parts[parts.length - 1])) holder.members.set(parts[parts.length - 1], { kind: "unknown" });
    }
    if (dep.tags && !top.members.has("tags")) top.members.set("tags", { kind: "map" });
  }
  const global = top.members.get("global");
  if (!global) top.members.set("global", { kind: "map" });
  else if (global.kind === "object") global.open = true;
  return top;
}

/** The members of `from` that `into` lacks are added; shared objects merge. */
function mergeInto(into: Shape & { kind: "object" }, from: Shape & { kind: "object" }): void {
  if (from.open) into.open = true;
  for (const [k, s] of from.members) {
    const have = into.members.get(k);
    if (!have) into.members.set(k, s);
    else if (have.kind === "object" && s.kind === "object") mergeInto(have, s);
  }
}

function subchartShape(dep: SubchartValues): Shape {
  if (dep.values === undefined) return { kind: "map" };
  const sub = buildShape(dep.values, { text: dep.text, dependencies: dep.dependencies });
  return sub.kind === "object" ? sub : { kind: "map" };
}

function render(s: Shape, indent: string): string {
  switch (s.kind) {
    case "unknown":
      return "unknown";
    case "scalar":
      return s.type === "quantity" ? "string | number" : s.type;
    case "map":
      return s.of === "scalar" ? "Record<string, string | number | boolean>" : s.of === "quantity" ? "Record<string, string | number>" : "Record<string, unknown>";
    case "array": {
      const element = render(s.element, indent);
      return /^[A-Za-z]+$/.test(element) ? `${element}[]` : `Array<${element}>`;
    }
    case "union":
      return [...new Set(s.shapes.map((x) => render(x, indent)))].join(" | ");
    case "object": {
      const inner = indent + "  ";
      const lines = ["{"];
      for (const [key, member] of s.members) {
        lines.push(`${inner}${tsPropertyKey(key)}?: ${render(member, inner)};`);
      }
      if (s.open) lines.push(`${inner}[key: string]: unknown;`);
      lines.push(`${indent}}`);
      return lines.join("\n");
    }
  }
}
