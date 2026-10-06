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
 */

import { tsPropertyKey } from "@intentius/chant/codegen/json-schema-to-ts";

/** The type expression for a parsed `values.yaml` document. */
export function inferValuesType(values: unknown): string {
  if (values === null || values === undefined) return "Record<string, unknown>";
  return render(shape(values), "");
}

type Shape =
  | { kind: "unknown" }
  | { kind: "scalar"; type: "string" | "number" | "boolean" }
  | { kind: "array"; element: Shape }
  | { kind: "object"; members: Map<string, Shape> }
  | { kind: "map" }
  | { kind: "union"; shapes: Shape[] };

function shape(value: unknown): Shape {
  if (value === null || value === undefined) return { kind: "unknown" };
  if (typeof value === "string") return { kind: "scalar", type: "string" };
  if (typeof value === "number") return { kind: "scalar", type: "number" };
  if (typeof value === "boolean") return { kind: "scalar", type: "boolean" };
  if (value instanceof Date) return { kind: "scalar", type: "string" };
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "array", element: { kind: "unknown" } };
    return { kind: "array", element: value.map(shape).reduce(merge) };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return { kind: "map" };
    return { kind: "object", members: new Map(entries.map(([k, v]) => [k, shape(v)])) };
  }
  return { kind: "unknown" };
}

/** Combine the shapes of two list elements: objects merge their keys, anything else unions. */
function merge(a: Shape, b: Shape): Shape {
  if (a.kind === "unknown" || b.kind === "unknown") return { kind: "unknown" };
  if (a.kind === "object" && b.kind === "object") {
    const members = new Map(a.members);
    for (const [k, s] of b.members) members.set(k, members.has(k) ? merge(members.get(k)!, s) : s);
    return { kind: "object", members };
  }
  if (a.kind === "scalar" && b.kind === "scalar" && a.type === b.type) return a;
  if (a.kind === "map" && b.kind === "map") return a;
  if (a.kind === "array" && b.kind === "array") return { kind: "array", element: merge(a.element, b.element) };
  const shapes = [...(a.kind === "union" ? a.shapes : [a]), ...(b.kind === "union" ? b.shapes : [b])];
  return { kind: "union", shapes };
}

function render(s: Shape, indent: string): string {
  switch (s.kind) {
    case "unknown":
      return "unknown";
    case "scalar":
      return s.type;
    case "map":
      return "Record<string, unknown>";
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
      lines.push(`${indent}}`);
      return lines.join("\n");
    }
  }
}
