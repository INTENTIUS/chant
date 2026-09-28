/**
 * JSON Schema (draft-07, the subset cog emits) to TypeScript declarations.
 *
 * Each vendored schema, with its correction overlay applied, becomes one
 * module under `src/schema/`: one exported type per entry in `definitions`,
 * with the schema's descriptions as doc comments. `required` is kept, so the types say what the schema says; the
 * entity props wrap panel options in `DeepPartial` where Grafana fills the
 * rest in on import.
 */

import type { SchemaName } from "../pin";

interface Node {
  type?: string | string[];
  $ref?: string;
  enum?: unknown[];
  const?: unknown;
  oneOf?: Node[];
  anyOf?: Node[];
  allOf?: Node[];
  items?: Node | Node[];
  properties?: Record<string, Node>;
  additionalProperties?: boolean | Node;
  required?: string[];
  description?: string;
  deprecated?: boolean;
  default?: unknown;
  [key: string]: unknown;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Keys written quoted even though they are identifiers. The repo's egress
 * scan (test/egress-catalogue.ts) reads a bare `fetch` as a call to the
 * global, and the dashboard schema has an action option named `fetch`.
 */
const QUOTED_KEYS = new Set(["fetch"]);

/** `dataquery` -> `Dataquery`: every exported type starts upper-case. */
export function typeName(defName: string): string {
  return defName.charAt(0).toUpperCase() + defName.slice(1);
}

function refName(ref: string): string {
  const m = /^#\/definitions\/(.+)$/.exec(ref);
  if (!m) throw new Error(`schema-types: only local #/definitions refs are supported, got "${ref}"`);
  return typeName(m[1]);
}

function literal(value: unknown): string {
  return JSON.stringify(value);
}

function paren(t: string): string {
  return /[|&]/.test(t) && !/^\{[\s\S]*\}$/.test(t) ? `(${t})` : t;
}

function union(parts: string[]): string {
  const uniq = [...new Set(parts)];
  if (uniq.includes("unknown")) return "unknown";
  return uniq.length === 0 ? "never" : uniq.join(" | ");
}

function docComment(node: Node, indent: string): string[] {
  const lines: string[] = [];
  const text = typeof node.description === "string" ? node.description.trim() : "";
  const deprecated = node.deprecated === true || typeof node["x-deprecation-message"] === "string";
  if (!text && !deprecated) return lines;
  lines.push(`${indent}/**`);
  for (const raw of text ? text.replace(/\*\//g, "*\\/").split("\n") : []) {
    const l = raw.trimEnd();
    lines.push(`${indent} *${l ? ` ${l}` : ""}`);
  }
  if (deprecated) {
    const msg = typeof node["x-deprecation-message"] === "string" ? ` ${String(node["x-deprecation-message"])}` : "";
    lines.push(`${indent} * @deprecated${msg.replace(/\*\//g, "*\\/")}`);
  }
  lines.push(`${indent} */`);
  return lines;
}

function objectType(node: Node, indent: string): string {
  const props = node.properties ?? {};
  const required = new Set(node.required ?? []);
  const inner = `${indent}  `;
  const lines: string[] = ["{"];
  for (const [key, child] of Object.entries(props)) {
    lines.push(...docComment(child, inner));
    const k = IDENT.test(key) && !QUOTED_KEYS.has(key) ? key : JSON.stringify(key);
    lines.push(`${inner}${k}${required.has(key) ? "" : "?"}: ${tsType(child, inner)};`);
  }
  const ap = node.additionalProperties;
  if (ap !== undefined && ap !== false) {
    const t = ap === true || Object.keys(ap).length === 0 ? "unknown" : tsType(ap, inner);
    lines.push(`${inner}[key: string]: ${Object.keys(props).length > 0 ? "unknown" : t};`);
  }
  lines.push(`${indent}}`);
  return lines.length === 2 ? "Record<string, never>" : lines.join("\n");
}

/**
 * A branch that only constrains which keys are present (`{ required: [...] }`),
 * like the overlay's "a panel has a `type` or a `libraryPanel`". It says
 * nothing about the shape, so the type ignores it and validation enforces it.
 */
function constraintOnly(branches: Node[] | undefined): boolean {
  return Array.isArray(branches) && branches.every((b) => Object.keys(b).every((k) => k === "required"));
}

/** The TypeScript type for one schema node. */
export function tsType(node: Node | boolean | undefined, indent = ""): string {
  if (node === undefined || node === true) return "unknown";
  if (node === false) return "never";
  if (node.$ref) return refName(node.$ref);
  if (node.const !== undefined) return literal(node.const);
  if (Array.isArray(node.enum)) return union(node.enum.map(literal));
  if (node.oneOf && !constraintOnly(node.oneOf)) return union(node.oneOf.map((n) => paren(tsType(n, indent))));
  if (node.anyOf && !constraintOnly(node.anyOf)) return union(node.anyOf.map((n) => paren(tsType(n, indent))));
  if (node.allOf) return node.allOf.map((n) => paren(tsType(n, indent))).join(" & ");

  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  if (types.length === 0) return node.properties ? objectType(node, indent) : "unknown";
  return union(
    types.map((t) => {
      switch (t) {
        case "string":
          return "string";
        case "number":
        case "integer":
          return "number";
        case "boolean":
          return "boolean";
        case "null":
          return "null";
        case "array": {
          if (Array.isArray(node.items)) return `[${node.items.map((n) => tsType(n, indent)).join(", ")}]`;
          return `${paren(tsType(node.items, indent))}[]`;
        }
        case "object": {
          if (node.properties) return objectType(node, indent);
          const ap = node.additionalProperties;
          if (ap === false) return "Record<string, never>";
          if (ap === undefined || ap === true || Object.keys(ap).length === 0) return "Record<string, unknown>";
          return `Record<string, ${tsType(ap, indent)}>`;
        }
        default:
          return "unknown";
      }
    }),
  );
}

export interface GeneratedModule {
  /** Module source, ready to write. */
  source: string;
  /** Exported type names, in definition order. */
  types: string[];
}

/** One schema file to one TypeScript module. */
export function schemaModule(name: SchemaName, schema: Record<string, unknown>, extra: string[] = []): GeneratedModule {
  const defs = (schema.definitions ?? {}) as Record<string, Node>;
  const out: string[] = [
    "// Code generated by chant generate from the vendored Grafana schema",
    `// src/spec/schemas/${name}.jsonschema.json (see src/pin.ts) and its correction`,
    "// overlay in src/spec/overlay/ (see src/spec/overlay.ts). DO NOT EDIT.",
    "/* eslint-disable */",
    "",
  ];
  const types: string[] = [];
  for (const [defName, def] of Object.entries(defs)) {
    const tn = typeName(defName);
    types.push(tn);
    out.push(...docComment(def, ""));
    const t = tsType(def, "");
    if (t.startsWith("{")) out.push(`export interface ${tn} ${t}`);
    else out.push(`export type ${tn} = ${t};`);
    out.push("");
  }
  out.push(...extra);
  return { source: `${out.join("\n").replace(/\n+$/, "")}\n`, types };
}
