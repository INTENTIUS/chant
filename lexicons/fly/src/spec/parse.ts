/**
 * Fly Machines API OpenAPI 3.0.1 parser.
 *
 * The flaps spec has no resource marker and is mostly request/response DTOs,
 * so we generate a curated set of resources rather than every schema. Each
 * curated resource pairs a request schema (writable authoring surface) with a
 * response schema (read-only attributes). The property types reachable from the
 * request schemas — notably the fly.MachineConfig graph — are emitted as
 * standalone property-type classes so `config` is fully typed.
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

export interface FlyParseResult {
  resource: ParsedResource;
  /** Always empty — fly emits property types as standalone results. */
  propertyTypes: Array<{ name: string; defType: string }>;
  /** Always empty — enums are inlined as string-literal unions. */
  enums: Array<{ name: string; values: string[] }>;
  /** Whether this entity is a property type (nested config shape). */
  isProperty?: boolean;
  /** For a property type, the upstream schema it was generated from (`fly.MachineConfig`). */
  schema?: string;
}

// ── OpenAPI types ──────────────────────────────────────────────────

interface OpenAPISchema extends JsonSchemaProperty {
  allOf?: OpenAPISchema[];
  additionalProperties?: boolean | OpenAPISchema;
  items?: OpenAPISchema;
  properties?: Record<string, OpenAPISchema>;
}

interface OpenAPISpec {
  components?: { schemas?: Record<string, OpenAPISchema> };
}

// ── Curated manifest ───────────────────────────────────────────────

/** The single service segment for all fly type names. */
const SERVICE = "Machines";

interface ResourceSpec {
  typeName: string;
  request: string;
  response: string;
  /**
   * Authoring props the request schema lacks because flaps takes them from the
   * URL. The serializer moves them into the endpoint.
   */
  pathProps?: ParsedProperty[];
}

const RESOURCES: ResourceSpec[] = [
  { typeName: `Fly::${SERVICE}::App`, request: "CreateAppRequest", response: "App" },
  { typeName: `Fly::${SERVICE}::Machine`, request: "CreateMachineRequest", response: "Machine" },
  { typeName: `Fly::${SERVICE}::Volume`, request: "CreateVolumeRequest", response: "Volume" },
  { typeName: `Fly::${SERVICE}::IPAddress`, request: "assignIPRequest", response: "IPAssignment" },
  { typeName: `Fly::${SERVICE}::Certificate`, request: "createAcmeCertificateRequest", response: "CertificateDetail" },
  {
    typeName: `Fly::${SERVICE}::Secret`,
    request: "SetAppSecretRequest",
    response: "AppSecret",
    pathProps: [
      {
        name: "name",
        tsType: "string",
        required: false,
        description:
          "The secret's name on the app. Defaults to the declaration's export name. " +
          "A Secret with no value is never sent: apply checks that the app already has it.",
        constraints: {},
      },
    ],
  },
];

const REF_PREFIX = "#/components/schemas/";

// ── Parser ─────────────────────────────────────────────────────────

/**
 * Parse the flaps OpenAPI spec into the curated resources and the property
 * types reachable from their request schemas.
 *
 * @param publishedSchemas upstream schema -> the class name the lexicon already
 *   published for it, normally read from the committed surface snapshot. A
 *   published name stays with its schema; see {@link nameSchemas}.
 */
export function parseFlyOpenAPI(
  data: string | Buffer,
  publishedSchemas: Record<string, string> = {},
): FlyParseResult[] {
  const spec: OpenAPISpec = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
  const schemas = spec.components?.schemas ?? {};

  // Phase 1: discover the emitted property-type set — object schemas reachable
  // (transitively) from the request schemas' properties. Enums are inlined, so
  // they are never emitted as classes.
  const names = nameSchemas(collectPropertyTypes(schemas), publishedSchemas);
  const resolve = (prop: OpenAPISchema | undefined): string => resolveType(prop, schemas, names);

  const results: FlyParseResult[] = [];

  // Phase 2: resources.
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
    for (const extra of rspec.pathProps ?? []) {
      if (!(extra.name in reqProps)) properties.push(extra);
    }

    // Attributes = response props not present in the request schema.
    const attributes: Array<{ name: string; tsType: string }> = [];
    for (const [name, prop] of Object.entries(res?.properties ?? {})) {
      if (properties.some((p) => p.name === name)) continue;
      attributes.push({ name, tsType: resolve(prop) });
    }

    results.push({
      resource: { typeName: rspec.typeName, description: req?.description, properties, attributes },
      propertyTypes: [],
      enums: [],
    });
  }

  // Phase 3: property-type classes.
  for (const [schemaName, className] of names) {
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
        typeName: `Fly::${SERVICE}::${className}`,
        description: def.description,
        properties,
        attributes: [],
      },
      propertyTypes: [],
      enums: [],
      isProperty: true,
      schema: schemaName,
    });
  }

  return results;
}

/**
 * Walk the request schemas and collect the set of object schemas reachable
 * through their properties (following $ref, allOf, arrays, and maps). Returns
 * the schema names in insertion order, deduplicated across resources.
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

/**
 * Resolve an OpenAPI schema node to its TypeScript type string. Emitted object
 * schemas resolve to their class name; enums inline as string-literal unions;
 * everything else falls back to primitives or `Record<string, any>`.
 */
function resolveType(
  prop: OpenAPISchema | undefined,
  schemas: Record<string, OpenAPISchema>,
  names: Map<string, string>,
): string {
  if (!prop) return "any";

  if (prop.$ref) return resolveRefType(prop.$ref, schemas, names);

  // allOf: [{ $ref }] — the OpenAPI idiom for "typed as this schema".
  if (prop.allOf && prop.allOf.length > 0) {
    const withRef = prop.allOf.find((s) => s.$ref);
    if (withRef?.$ref) return resolveRefType(withRef.$ref, schemas, names);
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
        const itemType = resolveType(prop.items, schemas, names);
        return itemType.includes(" | ") ? `(${itemType})[]` : `${itemType}[]`;
      }
      return "any[]";
    }
    case "object":
      if (prop.additionalProperties && typeof prop.additionalProperties === "object") {
        return `Record<string, ${resolveType(prop.additionalProperties, schemas, names)}>`;
      }
      return "Record<string, any>";
    default:
      return "any";
  }
}

/** Resolve a `#/components/schemas/X` ref to a TypeScript type. */
function resolveRefType(ref: string, schemas: Record<string, OpenAPISchema>, names: Map<string, string>): string {
  if (!ref.startsWith(REF_PREFIX)) return "any";
  const name = ref.slice(REF_PREFIX.length);
  const def = schemas[name];
  if (!def) return "any";

  // Emitted object schemas reference their class by name.
  const className = names.get(name);
  if (className !== undefined) return className;

  // Enums inline as string-literal unions.
  if (isEnumDefinition(def)) {
    return [...(def.enum ?? [])].sort().map((v) => JSON.stringify(v)).join(" | ");
  }

  // Object schemas we did not emit (response-only shapes) loosen to a map.
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

const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Convert a schema name into a PascalCase class-name segment.
 * "fly.MachineConfig" → "MachineConfig", "fly.dnsOption" → "DnsOption".
 *
 * With `qualified`, the dotted part stays in the name:
 * "fly.MachineConfig" → "FlyMachineConfig". A schema with no dotted part has
 * the same name either way.
 */
export function schemaToClassName(schemaName: string, qualified = false): string {
  if (!qualified) return pascal(schemaName.slice(schemaName.lastIndexOf(".") + 1));
  return schemaName
    .split(".")
    .map((segment) => pascal(segment))
    .join("");
}

/**
 * Give every emitted schema its class-name segment.
 *
 * A schema keeps a name it has already published (`published`, upstream
 * schema -> name). Every other schema takes its short name
 * ({@link schemaToClassName}) when no other emitted schema shares it and no
 * resource or published type holds it. Otherwise it keeps the dotted part of
 * its schema name (`FlyMachineConfig`), so a new upstream schema that shares a
 * published short name builds beside it and the published name does not move.
 * A newcomer with no dotted part to keep is refused rather than renamed.
 */
export function nameSchemas(emitted: string[], published: Record<string, string> = {}): Map<string, string> {
  const held = new Map<string, string>();
  for (const r of RESOURCES) held.set(flyShortName(r.typeName), r.typeName);

  const names = new Map<string, string>();
  for (const schemaName of emitted) {
    const name = published[schemaName];
    if (name !== undefined && !held.has(name)) {
      names.set(schemaName, name);
      held.set(name, schemaName);
    }
  }

  const byShortName = new Map<string, string[]>();
  for (const schemaName of emitted) {
    if (names.has(schemaName)) continue;
    const short = schemaToClassName(schemaName);
    byShortName.set(short, [...(byShortName.get(short) ?? []), schemaName]);
  }

  const assigned = new Map<string, string>();
  for (const [short, users] of byShortName) {
    if (users.length === 1 && !held.has(short)) {
      assigned.set(users[0], short);
      continue;
    }
    for (const schemaName of users) {
      const qualified = schemaToClassName(schemaName, true);
      if (qualified === short) {
        const other = held.get(short) ?? users.find((u) => u !== schemaName);
        throw new Error(
          `fly codegen: schema ${schemaName} shares the name ${short} with ${other} and has no dotted part to tell it apart`,
        );
      }
      assigned.set(schemaName, qualified);
    }
  }

  for (const [schemaName, name] of assigned) {
    const owner = held.get(name);
    if (owner !== undefined) {
      throw new Error(`fly codegen: schemas ${owner} and ${schemaName} both map to the type name ${name}`);
    }
    held.set(name, schemaName);
    names.set(schemaName, name);
  }

  // Emission order follows the spec walk, not the naming passes.
  return new Map(emitted.map((schemaName) => [schemaName, names.get(schemaName)!]));
}

/** Extract short name: "Fly::Machines::Machine" → "Machine". */
export function flyShortName(typeName: string): string {
  const parts = typeName.split("::");
  return parts[parts.length - 1];
}

/** Extract service name: "Fly::Machines::Machine" → "Machines". */
export function flyServiceName(typeName: string): string {
  const parts = typeName.split("::");
  return parts.length >= 2 ? parts[1] : SERVICE;
}
