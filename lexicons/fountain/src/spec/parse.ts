/**
 * Fountain OpenAPI parser.
 *
 * Fountain's spec (OpenApiSpex, served at /api/openapi.json) is
 * request/response DTOs, so we generate a curated set of resources — the
 * three kinds `fountain apply` reconciles: Environment, Vault, Agent.
 * Each pairs a request schema (writable authoring surface) with a response
 * schema (read-only attributes). Object schemas reachable from the request
 * schemas (e.g. Repository) are emitted as standalone property-type classes.
 *
 * Conversations are deliberately not a resource: they are runs with a
 * status lifecycle, modeled as ops, not declarables.
 */

import {
  extractConstraints as coreExtractConstraints,
  primaryType,
  isEnumDefinition,
  type JsonSchemaProperty,
  type PropertyConstraints,
} from "@intentius/chant/codegen/json-schema";

// ── Types ──────────────────────────────────────────────────────────

export type { PropertyConstraints };

export interface ParsedProperty {
  name: string;
  tsType: string;
  required: boolean;
  description?: string;
  constraints: PropertyConstraints;
}

export interface ParsedResource {
  typeName: string;
  description?: string;
  properties: ParsedProperty[];
  attributes: Array<{ name: string; tsType: string }>;
}

export interface FountainParseResult {
  resource: ParsedResource;
  /** Always empty — fountain emits property types as standalone results. */
  propertyTypes: Array<{ name: string; defType: string }>;
  /** Always empty — enums are inlined as string-literal unions. */
  enums: Array<{ name: string; values: string[] }>;
  /** Whether this entity is a property type (nested config shape). */
  isProperty?: boolean;
}

// ── OpenAPI types ──────────────────────────────────────────────────

interface OpenAPISchema extends JsonSchemaProperty {
  allOf?: OpenAPISchema[];
  additionalProperties?: boolean | OpenAPISchema;
  items?: OpenAPISchema;
  properties?: Record<string, OpenAPISchema>;
  nullable?: boolean;
}

interface OpenAPISpec {
  components?: { schemas?: Record<string, OpenAPISchema> };
}

// ── Curated manifest ───────────────────────────────────────────────

/** The single service segment for all fountain type names (apiVersion fountain.dev/v1). */
const SERVICE = "V1";

interface ResourceSpec {
  typeName: string;
  request: string;
  response: string;
}

const RESOURCES: ResourceSpec[] = [
  { typeName: `Fountain::${SERVICE}::Environment`, request: "EnvironmentRequest", response: "Environment" },
  { typeName: `Fountain::${SERVICE}::Vault`, request: "VaultRequest", response: "Vault" },
  { typeName: `Fountain::${SERVICE}::Agent`, request: "AgentRequest", response: "Agent" },
];

const REF_PREFIX = "#/components/schemas/";

// ── Parser ─────────────────────────────────────────────────────────

/**
 * Parse the fountain OpenAPI spec into the curated resources and the
 * property types reachable from their request schemas.
 */
export function parseFountainOpenAPI(data: string | Buffer): FountainParseResult[] {
  const spec: OpenAPISpec = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
  const schemas = spec.components?.schemas ?? {};

  const emitted = collectPropertyTypes(schemas);
  const resolve = (prop: OpenAPISchema | undefined): string => resolveType(prop, schemas, emitted);

  const results: FountainParseResult[] = [];

  for (const rspec of RESOURCES) {
    const req = schemas[rspec.request];
    const res = schemas[rspec.response];
    const reqProps = req?.properties ?? {};
    const requiredSet = new Set(req?.required ?? []);

    const properties: ParsedProperty[] = [];
    for (const [name, prop] of Object.entries(reqProps)) {
      properties.push({
        name,
        tsType: resolve(prop),
        required: requiredSet.has(name),
        description: prop.description,
        constraints: coreExtractConstraints(prop as JsonSchemaProperty),
      });
    }

    // Attributes = response props not present in the request schema.
    const attributes: Array<{ name: string; tsType: string }> = [];
    for (const [name, prop] of Object.entries(res?.properties ?? {})) {
      if (name in reqProps) continue;
      attributes.push({ name, tsType: resolve(prop) });
    }

    results.push({
      resource: {
        typeName: rspec.typeName,
        description: res?.description ?? req?.description,
        properties,
        attributes,
      },
      propertyTypes: [],
      enums: [],
    });
  }

  for (const schemaName of emitted) {
    const def = schemas[schemaName];
    const requiredSet = new Set(def.required ?? []);
    const properties: ParsedProperty[] = [];
    for (const [name, prop] of Object.entries(def.properties ?? {})) {
      properties.push({
        name,
        tsType: resolve(prop),
        required: requiredSet.has(name),
        description: prop.description,
        constraints: coreExtractConstraints(prop as JsonSchemaProperty),
      });
    }
    results.push({
      resource: {
        typeName: `Fountain::${SERVICE}::${schemaToClassName(schemaName)}`,
        description: def.description,
        properties,
        attributes: [],
      },
      propertyTypes: [],
      enums: [],
      isProperty: true,
    });
  }

  return results;
}

/**
 * Walk the request schemas and collect the set of object schemas reachable
 * through their properties (following $ref, allOf, arrays, and maps).
 */
function collectPropertyTypes(schemas: Record<string, OpenAPISchema>): string[] {
  const emitted = new Set<string>();
  const queue: string[] = [];

  const seedFrom = (node: unknown) => {
    for (const ref of collectRefs(node)) {
      const target = schemas[ref];
      if (!target) continue;
      if (isObjectSchema(target) && !emitted.has(ref)) {
        emitted.add(ref);
        queue.push(ref);
      }
    }
  };

  for (const spec of RESOURCES) {
    seedFrom(schemas[spec.request]?.properties);
  }
  while (queue.length > 0) {
    const name = queue.shift()!;
    seedFrom(schemas[name]?.properties);
  }

  return [...emitted];
}

/** Collect every `#/components/schemas/X` ref name nested anywhere in a node. */
function collectRefs(node: unknown, acc: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === "string" && ref.startsWith(REF_PREFIX)) acc.add(ref.slice(REF_PREFIX.length));
  for (const [key, value] of Object.entries(obj)) {
    if (key === "$ref") continue;
    collectRefs(value, acc);
  }
  return acc;
}

/** An object schema with properties (not a pure enum). */
function isObjectSchema(def: OpenAPISchema): boolean {
  return !!def.properties && Object.keys(def.properties).length > 0 && !isEnumDefinition(def);
}

// ── Type resolution ────────────────────────────────────────────────

function resolveType(
  prop: OpenAPISchema | undefined,
  schemas: Record<string, OpenAPISchema>,
  emitted: string[],
): string {
  if (!prop) return "any";

  if (prop.$ref) return resolveRefType(prop.$ref, schemas, emitted);

  if (prop.allOf && prop.allOf.length > 0) {
    const withRef = prop.allOf.find((s) => s.$ref);
    if (withRef?.$ref) return resolveRefType(withRef.$ref, schemas, emitted);
  }

  if (prop.enum && prop.enum.length > 0) {
    return [...prop.enum].sort().map((v) => JSON.stringify(v)).join(" | ");
  }

  const pt = primaryType(prop.type);
  switch (pt) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array": {
      if (prop.items) {
        const itemType = resolveType(prop.items, schemas, emitted);
        return itemType.includes(" | ") ? `(${itemType})[]` : `${itemType}[]`;
      }
      return "any[]";
    }
    case "object":
      if (prop.additionalProperties && typeof prop.additionalProperties === "object") {
        return `Record<string, ${resolveType(prop.additionalProperties, schemas, emitted)}>`;
      }
      return "Record<string, any>";
    default:
      return "any";
  }
}

/** Resolve a `#/components/schemas/X` ref to a TypeScript type. */
function resolveRefType(ref: string, schemas: Record<string, OpenAPISchema>, emitted: string[]): string {
  if (!ref.startsWith(REF_PREFIX)) return "any";
  const name = ref.slice(REF_PREFIX.length);
  const def = schemas[name];
  if (!def) return "any";

  if (emitted.includes(name)) return schemaToClassName(name);

  if (isEnumDefinition(def)) {
    return [...(def.enum ?? [])].sort().map((v) => JSON.stringify(v)).join(" | ");
  }

  if (def.properties) return "Record<string, any>";

  const pt = primaryType(def.type);
  switch (pt) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "any";
  }
}

// ── Naming helpers ─────────────────────────────────────────────────

/** Convert a schema name into a PascalCase class-name segment. */
export function schemaToClassName(schemaName: string): string {
  return schemaName.charAt(0).toUpperCase() + schemaName.slice(1);
}

/** Extract short name: "Fountain::V1::Agent" → "Agent". */
export function fountainShortName(typeName: string): string {
  const parts = typeName.split("::");
  return parts[parts.length - 1];
}

/** Extract service name: "Fountain::V1::Agent" → "V1". */
export function fountainServiceName(typeName: string): string {
  const parts = typeName.split("::");
  return parts.length >= 2 ? parts[1] : SERVICE;
}
