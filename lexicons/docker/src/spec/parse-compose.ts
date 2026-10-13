/**
 * Parse the Compose Spec JSON Schema into ParsedResult entries.
 *
 * The Compose spec defines a top-level "services", "volumes", "networks",
 * "configs", and "secrets" map — each value is a typed resource.
 * We model those as the five Compose entity types.
 */

export interface ComposeParseResult {
  typeName: string;          // e.g. "Docker::Compose::Service"
  shortName: string;         // e.g. "Service"
  description?: string;
  properties: ComposeProperty[];
  isResource: boolean;
}

export interface ComposeProperty {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  enum?: string[];
}

/**
 * The TypeScript type of a Compose string slot. Compose interpolates every
 * value, so `env()` fits where a string does; an entity (a service, network,
 * volume, config, secret or Dockerfile) is written as its name.
 */
export const COMPOSE_STRING = "ComposeString";

interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  patternProperties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  required?: string[];
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
}

const ENTITIES: Array<{ def: string; shortName: string; description: string }> = [
  { def: "service", shortName: "Service", description: "A containerized service definition in Docker Compose" },
  { def: "volume", shortName: "Volume", description: "A named volume definition in Docker Compose" },
  { def: "network", shortName: "Network", description: "A network definition in Docker Compose" },
  { def: "config", shortName: "Config", description: "A config definition in Docker Compose" },
  { def: "secret", shortName: "Secret", description: "A secret definition in Docker Compose" },
];

/**
 * Parse the Compose Spec JSON Schema buffer into ParsedResult entries.
 * Returns one entry per top-level Compose resource type, with a property for
 * every field the spec defines on it (#3934). Each property's `type` is a
 * TypeScript type converted from the schema; string slots use
 * {@link COMPOSE_STRING}.
 */
export function parseComposeSpec(data: Buffer): ComposeParseResult[] {
  const spec = JSON.parse(data.toString("utf-8")) as { $defs?: Record<string, JsonSchema>; definitions?: Record<string, JsonSchema> };
  const defs = spec.$defs ?? spec.definitions ?? {};

  return ENTITIES.map(({ def, shortName, description }) => {
    const schema = defs[def];
    const required = new Set(schema?.required ?? []);
    const properties: ComposeProperty[] = Object.entries(schema?.properties ?? {}).map(([name, prop]) => ({
      name,
      type: toTsType(prop, defs, new Set([def])),
      ...(prop.description ? { description: oneLine(prop.description) } : {}),
      ...(required.has(name) ? { required: true } : {}),
    }));
    return { typeName: `Docker::Compose::${shortName}`, shortName, description, isResource: true, properties };
  });
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\*\//g, "* /").trim();
}

/** A property name as a TypeScript key: bare when it is an identifier. */
function key(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

/** Convert one JSON Schema node to a TypeScript type. `seen` guards $ref cycles. */
export function toTsType(schema: JsonSchema | boolean | undefined, defs: Record<string, JsonSchema>, seen: Set<string> = new Set()): string {
  if (schema === undefined || schema === true) return "unknown";
  if (schema === false) return "never";

  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/(\$defs|definitions)\//, "");
    const target = defs[name];
    if (!target || seen.has(name)) return "unknown";
    return toTsType(target, defs, new Set([...seen, name]));
  }

  const alts = schema.oneOf ?? schema.anyOf;
  if (alts) {
    // A oneOf beside a type or properties narrows them; the alternatives carry the shape.
    return union(alts.map((a) => toTsType(a, defs, seen)));
  }
  if (schema.allOf) {
    const parts = schema.allOf.map((a) => toTsType(a, defs, seen)).filter((t) => t !== "unknown");
    return parts.length ? parts.map(paren).join(" & ") : "unknown";
  }

  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return union(schema.enum.map((v) => JSON.stringify(v)));

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length === 0) {
    if (schema.properties || schema.patternProperties || schema.additionalProperties !== undefined) return objectType(schema, defs, seen);
    if (schema.items) return `Array<${toTsType(schema.items, defs, seen)}>`;
    return "unknown";
  }
  return union(
    types.map((t) => {
      switch (t) {
        case "string":
          return COMPOSE_STRING;
        case "number":
        case "integer":
          return "number";
        case "boolean":
          return "boolean";
        case "null":
          return "null";
        case "array":
          return `Array<${schema.items ? toTsType(schema.items, defs, seen) : "unknown"}>`;
        case "object":
          return objectType(schema, defs, seen);
        default:
          return "unknown";
      }
    }),
  );
}

function objectType(schema: JsonSchema, defs: Record<string, JsonSchema>, seen: Set<string>): string {
  const props = Object.entries(schema.properties ?? {});
  const patterns = Object.entries(schema.patternProperties ?? {});
  const extensions = patterns.some(([p]) => p === "^x-");
  const others = patterns.filter(([p]) => p !== "^x-");
  const additional = schema.additionalProperties;

  if (props.length === 0) {
    const values = others.map(([, v]) => toTsType(v, defs, seen));
    if (additional && additional !== true) values.push(toTsType(additional, defs, seen));
    if (values.length) return `Record<string, ${union(values)}>`;
    return additional === false && !extensions ? "Record<string, never>" : "Record<string, unknown>";
  }

  const required = new Set(schema.required ?? []);
  const fields = props.map(([name, p]) => `${key(name)}${required.has(name) ? "" : "?"}: ${toTsType(p, defs, seen)}`);
  if (extensions) fields.push("[key: `x-${string}`]: unknown");
  // Free-form keys beside the named ones: the named ones keep their types.
  if (others.length || (additional && additional !== true)) fields.push("[key: string]: unknown");
  return `{ ${fields.join("; ")} }`;
}

function paren(t: string): string {
  return /[|&]/.test(t) && !/^[{(]/.test(t) ? `(${t})` : t;
}

function union(types: string[]): string {
  const unique = [...new Set(types.flatMap(splitTop))];
  if (unique.includes("unknown")) return "unknown";
  return unique.join(" | ");
}

/** The members of a union type, split only at the top level. */
function splitTop(type: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if (c === '"') quote = !quote;
    if (quote) continue;
    if (c === "{" || c === "(" || c === "<" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === ">" || c === "]") depth--;
    else if (depth === 0 && type.startsWith(" | ", i)) {
      out.push(type.slice(start, i));
      start = i + 3;
      i += 2;
    }
  }
  out.push(type.slice(start));
  return out;
}
