/**
 * `config.schema.yaml` to TypeScript (#3361).
 *
 * `schemagen` writes a small JSON Schema dialect: `type`, `properties`,
 * `items`, `additionalProperties`, `enum`, `allOf` (an embedded struct,
 * `mapstructure:",squash"`), `$ref` and `$defs`, `format: duration`, and three
 * extensions:
 *
 * - `x-customType`, the Go type when the JSON type alone loses it (`int64`,
 *   `component.ID`, `time.Duration`, or a type from outside the collector);
 * - `x-optional`, a `configoptional.Optional`: the key may be written with no
 *   value (`grpc:`) to turn the section on with its defaults, so it also takes
 *   `null`;
 * - `x-pointer`, a Go pointer, which changes nothing in YAML.
 *
 * It writes no `required`, so every generated property is optional; what a
 * component cannot start without is its definition's `validate` overlay.
 *
 * Every definition reached from a built-in becomes one named type alias,
 * `<document><Definition>`, so recursive definitions (tail_sampling's `and`
 * and `not` policies) are expressible. A `$ref` to a document upstream does
 * not publish, or to a definition it lacks, becomes `unknown` and is listed in
 * {@link GeneratedTypes.unresolved}.
 */

import { CONTRIB_MODULE, CORE_MODULE, resolveRef } from "./fetch";

/** One node of a schema document. */
export interface SchemaNode {
  type?: string | string[];
  description?: string;
  format?: string;
  enum?: unknown[];
  pattern?: string;
  default?: unknown;
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
  items?: SchemaNode;
  allOf?: SchemaNode[];
  $ref?: string;
  $defs?: Record<string, SchemaNode>;
  "x-customType"?: string;
  "x-optional"?: boolean;
  "x-pointer"?: boolean;
}

/** How each `x-customType` reads in TypeScript. A type not listed falls back on the node's JSON `type`. */
const CUSTOM_TYPES: Record<string, string> = {
  int: "number",
  int8: "number",
  int16: "number",
  int32: "number",
  int64: "number",
  uint: "number",
  uint8: "number",
  uint16: "number",
  uint32: "number",
  uint64: "number",
  float32: "number",
  float64: "number",
  any: "unknown",
  "time.Duration": "Duration",
  "go.opentelemetry.io/collector/component.ID": "string",
  "go.opentelemetry.io/otel/attribute.key": "string",
  "golang.org/x/time/rate.Limit": "number",
  "net/url.values": "Record<string, string[]>",
  "os.file_mode": "number | string",
};

/**
 * Definitions whose Go type has its own unmarshaller, so the JSON type
 * `schemagen` writes (the underlying `int`, or the stored form) is not all a
 * YAML config may hold. Keyed by `<document>#<definition>`; a function gets
 * the type generated from the schema and widens it.
 */
const TEXT_DEFINITIONS: Record<string, string | ((generated: string) => string)> = {
  // configopaque.MapList is stored as name/value pairs and also read from a plain map.
  "go.opentelemetry.io/collector/config/configopaque#map_list": (generated) => `Record<string, string> | ${generated}`,
  // configtelemetry.Level implements UnmarshalText over these names.
  "go.opentelemetry.io/collector/config/configtelemetry#level": '"none" | "basic" | "normal" | "detailed"',
  // spanmetrics' histogram unit, `ms` or `s`.
  "github.com/open-telemetry/opentelemetry-collector-contrib/connector/spanmetricsconnector/internal/metrics#unit": '"ms" | "s"',
  // stanza's ByteSize takes `1MiB` as well as a byte count.
  "github.com/open-telemetry/opentelemetry-collector-contrib/pkg/stanza/operator/helper#byte_size": "number | string",
  // Severities take a name (`INFO`, `warn`) as well as a number.
  "github.com/open-telemetry/opentelemetry-collector-contrib/pkg/stanza/entry#severity": "number | string",
  "go.opentelemetry.io/collector/pdata/plog#severity_number": "number | string",
  "go.opentelemetry.io/collector/pdata/internal#severity_number": "number | string",
};

/** The TypeScript for one `x-customType`, or undefined when the JSON type should decide. */
export function customType(name: string): string | undefined {
  return CUSTOM_TYPES[name];
}

function pascal(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
}

/** The type-name prefix for a document: its package path below the repository, PascalCased, with `Collector` for core packages. */
export function documentAlias(doc: string): string {
  if (doc.startsWith(`${CONTRIB_MODULE}/`)) return pascal(doc.slice(CONTRIB_MODULE.length + 1));
  if (doc.startsWith(`${CORE_MODULE}/`)) return `Collector${pascal(doc.slice(CORE_MODULE.length + 1))}`;
  return pascal(doc);
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propKey(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name);
}

function jsdoc(description: string | undefined, indent: string, deprecated?: boolean): string {
  const lines: string[] = [];
  if (description) lines.push(...description.replace(/\*\//g, "*\\/").split("\n"));
  if (deprecated) lines.push("@deprecated");
  if (lines.length === 0) return "";
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`.trimEnd()).join("\n")}\n${indent} */\n`;
}

/** A description that says the field is deprecated, as Go comments do. */
export function isDeprecated(description: string | undefined): boolean {
  // `Deprecated: use X`, `Deprecated [v0.130.0]: use X`, or a comment that opens with it.
  return description !== undefined && /^\s*Deprecated\b|\bDeprecated(\s*\[[^\]]*\])?:/.test(description);
}

/** True for a document that is only a `$defs` container. */
function isBareDocument(node: SchemaNode): boolean {
  return !node.type && !node.properties && !node.allOf && !node.$ref;
}

/** A document's root type: the document itself, or its `config` definition when the document is only `$defs`. */
function rootOf(node: SchemaNode | undefined): SchemaNode | undefined {
  if (node && isBareDocument(node) && node.$defs?.config) return node.$defs.config;
  return node;
}

export interface GeneratedTypes {
  /** The `type X = …` declarations, in name order. */
  declarations: string;
  /** The type name of each requested root document. */
  roots: Map<string, string>;
  /** `$ref`s that could not be followed, as `doc.def` → the documents that wrote them. */
  unresolved: Map<string, Set<string>>;
}

/**
 * Generate TypeScript for the root documents in `roots` and every definition
 * they reach. `docs` holds every available document, keyed by Go package path.
 */
export function generateTypes(docs: Readonly<Record<string, unknown>>, roots: readonly string[]): GeneratedTypes {
  const decls = new Map<string, string>();
  const unresolved = new Map<string, Set<string>>();
  const pending: Array<{ doc: string; def: string; name: string }> = [];
  const named = new Map<string, string>();

  const noteUnresolved = (key: string, from: string) => {
    if (!unresolved.has(key)) unresolved.set(key, new Set());
    unresolved.get(key)!.add(from);
  };

  // The type name for `doc` + `def` (def "" is the document's root), queued for emission on first use.
  const nameFor = (doc: string, def: string): string | undefined => {
    const key = `${doc}#${def}`;
    const known = named.get(key);
    if (known) return known;
    const node = docs[doc] as SchemaNode | undefined;
    if (!node) return undefined;
    // A package whose `Config` lives under `$defs` (signaltometrics' `config`
    // package) has no root type; the document stands for that definition.
    if (def === "" && isBareDocument(node) && node.$defs?.config) return nameFor(doc, "config");
    // `pkg.config` names the package's `Config` struct, which schemagen
    // writes as the document root rather than under `$defs`.
    if (def !== "" && !node.$defs?.[def]) return def === "config" ? nameFor(doc, "") : undefined;
    let name = documentAlias(doc) + (def === "" ? "Schema" : pascal(def));
    while ([...named.values()].includes(name)) name += "_";
    named.set(key, name);
    pending.push({ doc, def, name });
    return name;
  };

  const tsType = (node: SchemaNode | undefined, doc: string, indent: string): string => {
    if (!node || typeof node !== "object") return "unknown";
    let t = baseType(node, doc, indent);
    if (node["x-optional"]) t = `${parenthesize(t)} | null`;
    return t;
  };

  const parenthesize = (t: string) => (/[|&]/.test(t) && !/^\{[\s\S]*\}$/.test(t) ? `(${t})` : t);

  const objectBody = (props: Record<string, SchemaNode>, doc: string, indent: string): string => {
    const inner = `${indent}  `;
    const lines = Object.keys(props)
      .sort()
      .map((k) => {
        const p = props[k];
        return `${jsdoc(p.description, inner, isDeprecated(p.description))}${inner}${propKey(k)}?: ${tsType(p, doc, inner)};\n`;
      });
    return `{\n${lines.join("")}${indent}}`;
  };

  const baseType = (node: SchemaNode, doc: string, indent: string): string => {
    if (node.$ref) {
      const { doc: target, def } = resolveRef(doc, node.$ref);
      const name = nameFor(target, def);
      if (!name) {
        noteUnresolved(`${target}${def ? `.${def}` : ""}`, doc);
        return "unknown";
      }
      return name;
    }
    if (node.allOf && node.allOf.length > 0) {
      const parts = node.allOf.map((n) => parenthesize(tsType(n, doc, indent)));
      if (node.properties && Object.keys(node.properties).length > 0) parts.push(objectBody(node.properties, doc, indent));
      const kept = parts.filter((p) => p !== "unknown");
      return kept.length === 0 ? "unknown" : kept.join(" & ");
    }
    const custom = node["x-customType"];
    if (custom) {
      const mapped = customType(custom);
      if (mapped) return mapped;
    }
    const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
    if (types.length === 0) {
      if (node.properties) return objectBody(node.properties, doc, indent);
      return "unknown";
    }
    return types.map((t) => jsonType(t, node, doc, indent)).join(" | ");
  };

  const jsonType = (t: string, node: SchemaNode, doc: string, indent: string): string => {
    switch (t) {
      case "string":
        if (node.enum && node.enum.length > 0) return node.enum.map((v) => JSON.stringify(v)).join(" | ");
        return node.format === "duration" ? "Duration" : "string";
      case "integer":
      case "number":
        if (node.format === "duration") return "Duration";
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array":
        return `Array<${tsType(node.items, doc, indent)}>`;
      case "object": {
        const hasProps = node.properties && Object.keys(node.properties).length > 0;
        if (hasProps) return objectBody(node.properties!, doc, indent);
        const ap = node.additionalProperties;
        if (ap && typeof ap === "object") return `Record<string, ${tsType(ap, doc, indent)}>`;
        return "Record<string, unknown>";
      }
      default:
        return "unknown";
    }
  };

  const roots_ = new Map<string, string>();
  for (const root of roots) {
    const name = nameFor(root, "");
    if (name) roots_.set(root, name);
  }
  while (pending.length > 0) {
    const { doc, def, name } = pending.shift()!;
    const docNode = docs[doc] as SchemaNode;
    const node = def === "" ? docNode : docNode.$defs![def];
    const text = TEXT_DEFINITIONS[`${doc}#${def}`];
    const body = typeof text === "string" ? text : text ? text(tsType(node, doc, "")) : tsType(node, doc, "");
    decls.set(name, `${jsdoc(node.description, "")}export type ${name} = ${body};\n`);
  }

  const declarations = [...decls.keys()]
    .sort()
    .map((k) => decls.get(k)!)
    .join("\n");
  return { declarations, roots: roots_, unresolved };
}

// ── Property docs for the LSP ───────────────────────────────────────

/** One property as completion and hover show it. */
export interface PropertyDoc {
  description?: string;
  /** A short type label, e.g. `string`, `duration`, `object`, `boolean[]`. */
  type: string;
  deprecated?: boolean;
  /** For object-valued properties, their own properties. */
  properties?: Record<string, PropertyDoc>;
}

/**
 * The property tree of a root document, for completion and hover: each
 * property's description and a short type label, nested objects expanded to
 * `depth` levels, embedded structs (`allOf`) flattened in.
 */
export function propertyDocs(docs: Readonly<Record<string, unknown>>, root: string, depth = 4): Record<string, PropertyDoc> {
  const visit = (node: SchemaNode | undefined, doc: string, level: number, stack: string[]): Record<string, PropertyDoc> => {
    const out: Record<string, PropertyDoc> = {};
    const target = deref(node, doc);
    if (!target) return out;
    const { node: n, doc: d, key } = target;
    if (key && stack.includes(key)) return out;
    const nextStack = key ? [...stack, key] : stack;
    // A list of objects: complete the properties of one item.
    if (n.items && (n.type === "array" || (Array.isArray(n.type) && n.type.includes("array")))) return visit(n.items, d, level, nextStack);
    // A map of objects: complete the properties of one value.
    if (!n.properties && !n.allOf && n.additionalProperties && typeof n.additionalProperties === "object") {
      return visit(n.additionalProperties, d, level, nextStack);
    }
    for (const part of n.allOf ?? []) Object.assign(out, visit(part, d, level, nextStack));
    for (const [name, p] of Object.entries(n.properties ?? {})) {
      const entry: PropertyDoc = { type: label(p, d) };
      const description = p.description ?? deref(p, d)?.node.description;
      if (description) entry.description = description;
      if (isDeprecated(p.description)) entry.deprecated = true;
      if (level < depth) {
        const child = visit(p, d, level + 1, nextStack);
        if (Object.keys(child).length > 0) entry.properties = child;
      }
      out[name] = entry;
    }
    return out;
  };

  const deref = (node: SchemaNode | undefined, doc: string): { node: SchemaNode; doc: string; key: string } | undefined => {
    let n = node;
    let d = doc;
    // Only a `$ref`ed definition can recur; an inline object gets no key.
    let key = "";
    for (let hops = 0; n?.$ref && hops < 16; hops++) {
      const r = resolveRef(d, n.$ref);
      const target = docs[r.doc] as SchemaNode | undefined;
      n = r.def === "" ? rootOf(target) : (target?.$defs?.[r.def] ?? (r.def === "config" ? target : undefined));
      d = r.doc;
      key = `${r.doc}#${r.def}`;
    }
    return n ? { node: n, doc: d, key } : undefined;
  };

  const label = (node: SchemaNode, doc: string): string => {
    const resolved = deref(node, doc);
    const text = resolved && TEXT_DEFINITIONS[resolved.key];
    if (typeof text === "string") return text;
    if (text) return "map | list";
    const target = resolved?.node ?? node;
    const custom = target["x-customType"];
    if (custom === "time.Duration" || target.format === "duration") return "duration";
    if (custom && customType(custom) === "number") return "number";
    if (custom === "go.opentelemetry.io/collector/component.ID") return "component id";
    const t = Array.isArray(target.type) ? target.type[0] : target.type;
    if (t === "integer") return "number";
    if (t === "array") return `${target.items ? label(target.items, doc) : "unknown"}[]`;
    if (t === "string" && target.enum) return target.enum.map((v) => JSON.stringify(v)).join(" | ");
    if (!t && (target.allOf || target.properties)) return "object";
    return t ?? "unknown";
  };

  return visit(rootOf(docs[root] as SchemaNode | undefined), root, 1, []);
}
