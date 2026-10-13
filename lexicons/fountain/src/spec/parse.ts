/**
 * Fountain OpenAPI parser.
 *
 * Fountain's spec (OpenApiSpex, published as a release asset) is
 * request/response DTOs, so we generate a curated set of resources — the six
 * declarable kinds. Environment, Vault and Agent are what `fountain apply`
 * reconciles; Teammate, Schedule and Webhook belong to the team, schedule and
 * webhook routes. Each pairs a request schema (writable authoring surface)
 * with a response schema (read-only attributes). Object schemas reachable from
 * the request schemas (e.g. Repository) are emitted as standalone
 * property-type classes.
 *
 * Conversations are deliberately not a resource: they are runs with a
 * status lifecycle, modeled as ops, not declarables.
 *
 * Two things the curated manifest adds on top of the raw schemas:
 *
 *   - Typed references. A request schema carries `agent_id`; a chant author
 *     writes `agent: someAgent`. The `refs` entries rename an id field, or
 *     add one that reaches the API only as a path parameter (a schedule's
 *     teammate), into a by-name reference the serializer resolves and FTN021
 *     proves resolvable — the same shape an Agent's `environment` has.
 *   - Extensions. A prop chant accepts that the request schema does not
 *     describe, declared here so the generated type documents it instead of
 *     leaving authors to smuggle it through `metadata` or a cast. Today that is
 *     the inline `secrets` on Environment and Vault, which upstream documents
 *     on its manifest format rather than on either request schema.
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

/** A by-name reference to another declared fountain resource. */
interface RefSpec {
  /** The prop authors write. */
  prop: string;
  /**
   * The request-schema id field it replaces. Absent when the id reaches the
   * API as a path parameter and so never appears in a request body.
   */
  from?: string;
  /** The kind it points at, as a chant type name. */
  target: string;
  required: boolean;
  description: string;
}

/** A prop chant accepts that the kind's request schema does not describe. */
interface ExtensionSpec {
  name: string;
  tsType: string;
  required: boolean;
  description: string;
}

interface ResourceSpec {
  typeName: string;
  request: string;
  response: string;
  refs?: RefSpec[];
  extensions?: ExtensionSpec[];
}

/**
 * The inline secrets a manifest document carries (Environment and Vault).
 *
 * Neither request schema has the field: secrets are a write-only
 * sub-resource with routes of their own. Upstream's `ManifestResource` says a
 * manifest spec is the create schema "plus an inline `secrets` map
 * (Environment and Vault)", and `fountainApply` turns the authored list into
 * that map. Without the extension the generated types have no field for what
 * the chant-fountain-secrets skill tells an author to write.
 */
const SECRETS_EXTENSION: ExtensionSpec = {
  name: "secrets",
  tsType: "{ key: string; value: string }[]",
  required: false,
  description:
    "Secrets upserted with the resource at apply, as key/value pairs; fountainApply sends them as the manifest's " +
    "inline `secrets` map. Values are write-only upstream and can never be read back or diffed. Write a reference " +
    "that resolves at build (an env var, a secret-manager lookup), never a literal: FTN001 flags a literal here " +
    "as it does anywhere else in a declaration.",
};

const REF_TARGET = {
  agent: `Fountain::${SERVICE}::Agent`,
  environment: `Fountain::${SERVICE}::Environment`,
  vault: `Fountain::${SERVICE}::Vault`,
  teammate: `Fountain::${SERVICE}::Teammate`,
};

const RESOURCES: ResourceSpec[] = [
  {
    typeName: `Fountain::${SERVICE}::Environment`,
    request: "EnvironmentRequest",
    response: "Environment",
    extensions: [SECRETS_EXTENSION],
  },
  {
    typeName: `Fountain::${SERVICE}::Vault`,
    request: "VaultRequest",
    response: "Vault",
    extensions: [SECRETS_EXTENSION],
  },
  { typeName: `Fountain::${SERVICE}::Agent`, request: "AgentRequest", response: "Agent" },
  {
    typeName: `Fountain::${SERVICE}::Teammate`,
    request: "TeamAddRequest",
    response: "Teammate",
    refs: [
      {
        prop: "agent",
        from: "agent_id",
        target: REF_TARGET.agent,
        required: true,
        description: "The agent this teammate is, by name. A dangling reference is FTN021, not a 404 at apply.",
      },
      {
        prop: "environment",
        from: "environment_id",
        target: REF_TARGET.environment,
        required: false,
        description:
          "Provision the teammate's computer from this environment instead of the agent's own. Must satisfy the agent's allowed_environment_ids.",
      },
      {
        prop: "vault",
        from: "vault_id",
        target: REF_TARGET.vault,
        required: false,
        description: "Layer this vault's secrets on top. Must satisfy allowed_vault_ids.",
      },
    ],
  },
  {
    typeName: `Fountain::${SERVICE}::Schedule`,
    request: "TeamScheduleCreateRequest",
    response: "TeamSchedule",
    refs: [
      {
        prop: "teammate",
        target: REF_TARGET.teammate,
        required: true,
        description:
          "The teammate whose thread this prompt goes to. The route carries it as a path parameter " +
          "(POST /api/team/{agent_id}/schedules), so it is a chant-level reference rather than a body field.",
      },
    ],
  },
  { typeName: `Fountain::${SERVICE}::Webhook`, request: "WebhookEndpointCreateRequest", response: "WebhookEndpoint" },
];

/**
 * The request schemas the curated manifest models, by schema name.
 *
 * Coverage reads this rather than guessing `${kind}Request`: a Teammate is
 * created by `TeamAddRequest` and a Schedule by `TeamScheduleCreateRequest`.
 */
export const MODELED_REQUEST_SCHEMAS: string[] = RESOURCES.map((r) => r.request);

const REF_PREFIX = "#/components/schemas/";

/**
 * A reference prop accepts the referenced declaration or the name of one, so
 * an author can point at something chant declares elsewhere in the build or at
 * something that already exists on the instance.
 */
function refProperty(ref: RefSpec): ParsedProperty {
  return {
    name: ref.prop,
    tsType: `${fountainShortName(ref.target)} | string`,
    required: ref.required,
    description: ref.description,
    constraints: {},
  };
}

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

    const refs = rspec.refs ?? [];
    const refByIdField = new Map(refs.filter((r) => r.from).map((r) => [r.from!, r]));

    const properties: ParsedProperty[] = [];
    for (const [name, prop] of Object.entries(reqProps)) {
      const ref = refByIdField.get(name);
      if (ref) {
        properties.push(refProperty(ref));
        continue;
      }
      properties.push({
        name,
        tsType: resolve(prop),
        required: requiredSet.has(name),
        description: prop.description,
        constraints: coreExtractConstraints(prop as JsonSchemaProperty),
      });
    }

    // References whose id is a path parameter have no request-body field to
    // rename, so they are appended rather than substituted.
    for (const ref of refs) {
      if (!ref.from) properties.push(refProperty(ref));
    }

    for (const ext of rspec.extensions ?? []) {
      // An extension exists because the spec lacks the prop. Once upstream
      // describes it, the extension would emit a second copy with chant's
      // type in place of upstream's, so the build stops and says so.
      if (ext.name in reqProps) {
        throw new Error(
          `fountain parse: ${rspec.request} now declares "${ext.name}", which ${fountainShortName(rspec.typeName)} ` +
            `carries as a chant extension. Remove the extension from RESOURCES in src/spec/parse.ts.`,
        );
      }
      properties.push({
        name: ext.name,
        tsType: ext.tsType,
        required: ext.required,
        description: ext.description,
        constraints: {},
      });
    }

    // Attributes = response props not authored on the request side. Both the
    // id field a ref replaced (`agent_id`) and the ref that replaced it
    // (`agent`) count as authored, so a Teammate's `agent` is a constructor
    // prop and not also a readonly attribute shadowing it.
    const authored = new Set([...Object.keys(reqProps), ...properties.map((p) => p.name)]);
    const attributes: Array<{ name: string; tsType: string }> = [];
    for (const [name, prop] of Object.entries(res?.properties ?? {})) {
      if (authored.has(name)) continue;
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

/**
 * An object schema with properties (not a pure enum, and not an open map).
 *
 * A schema with named properties and a typed `additionalProperties` is a map
 * that reserves a few keys, like v0.21.0's `PermissionPolicy`: tool names to
 * verdicts, plus `ask_timeout`. Emitting it as a class would keep the reserved
 * keys and drop the map, so it resolves to a `Record` instead.
 */
function isObjectSchema(def: OpenAPISchema): boolean {
  return (
    !!def.properties &&
    Object.keys(def.properties).length > 0 &&
    !isEnumDefinition(def) &&
    !isOpenMap(def)
  );
}

/** An object whose `additionalProperties` is a schema, not `true` or absent. */
function isOpenMap(def: OpenAPISchema): boolean {
  return !!def.additionalProperties && typeof def.additionalProperties === "object";
}

/** The TypeScript union of a set of member types, deduplicated and sorted. */
function unionOf(types: string[]): string {
  const parts = new Set(types.flatMap((t) => t.split(" | ")));
  if (parts.has("any")) return "any";
  return [...parts].sort().join(" | ");
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

  const members = (prop as { oneOf?: OpenAPISchema[]; anyOf?: OpenAPISchema[] }).oneOf ??
    (prop as { anyOf?: OpenAPISchema[] }).anyOf;
  if (members && members.length > 0) {
    return unionOf(members.map((m) => resolveType(m, schemas, emitted)));
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

  if (isOpenMap(def)) {
    const value = resolveType(def.additionalProperties as OpenAPISchema, schemas, emitted);
    // Reserved keys ride in the same map, so their types join the value union.
    const reserved = Object.values(def.properties ?? {}).map((p) => resolveType(p, schemas, emitted));
    return `Record<string, ${unionOf([value, ...reserved])}>`;
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
