/**
 * Render Public API OpenAPI 3.0 parser.
 *
 * Render's spec is a REST API description — request/response DTOs, not a
 * resource catalog — so, like fly, we generate a *curated* set of resources
 * rather than every schema. Each curated resource pairs a create-request
 * schema (the writable authoring surface) with a response schema (read-only
 * attributes). The named object schemas reachable from the request schemas
 * (`webServiceDetailsPOST`, `image`, `serviceDisk`, `cidrBlockAndDescription`,
 * ...) become standalone property-type classes so nested config is typed all
 * the way down; anonymous inline objects (Render leans on `#/paths/...` JSON
 * pointers for a few of these — autoscaling, env vars, secret files) are
 * emitted as inline TypeScript object literals, and enums inline as
 * string-literal unions.
 *
 * Services are split by type. Render's `POST /services` takes a `type`
 * discriminator plus a `serviceDetails` oneOf; authoring `new WebService({...})`
 * with `serviceDetails` typed as `WebServiceDetails` is both tighter and more
 * honest than one `Service` class with a five-way union, so each service type
 * is its own resource with `type` fixed and `serviceDetails` narrowed.
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

export interface ParsedAttribute {
  name: string;
  tsType: string;
}

export interface ParsedResource {
  typeName: string;
  description?: string;
  properties: ParsedProperty[];
  attributes: ParsedAttribute[];
}

export interface RenderParseResult {
  resource: ParsedResource;
  /** Always empty — render emits property types as standalone results. */
  propertyTypes: Array<{ name: string; defType: string }>;
  /** Always empty — enums are inlined as string-literal unions. */
  enums: Array<{ name: string; values: string[] }>;
  /** Whether this entity is a property type (nested config shape). */
  isProperty?: boolean;
}

// ── OpenAPI types ──────────────────────────────────────────────────

interface OpenAPISchema extends JsonSchemaProperty {
  allOf?: OpenAPISchema[];
  oneOf?: OpenAPISchema[];
  anyOf?: OpenAPISchema[];
  additionalProperties?: boolean | OpenAPISchema;
  items?: OpenAPISchema;
  properties?: Record<string, OpenAPISchema>;
  title?: string;
}

interface OpenAPISpec {
  components?: { schemas?: Record<string, OpenAPISchema> };
  paths?: Record<string, unknown>;
}

// ── Curated manifest ───────────────────────────────────────────────

/** The type-name namespace every render entity lives under. */
export const NAMESPACE = "Render";

/**
 * How a curated resource maps onto the spec. `request`/`response` are schema
 * locators: either a `#/components/schemas/X` name (bare `X`) or a JSON
 * pointer into `#/paths/...` for the handful of bodies Render leaves inline.
 */
export interface ResourceSpec {
  typeName: string;
  request: string;
  response: string;
  /**
   * Request properties chant fixes and therefore hides from the authoring
   * surface — the service `type` discriminator. The serializer re-injects them.
   */
  fixed?: Record<string, unknown>;
  /** Property → schema locator that replaces the request schema's own type (narrowing `serviceDetails`). */
  overrides?: Record<string, string>;
  /**
   * Properties the API requires but chant can default — `ownerId` resolves from
   * the `Render.OwnerId` pseudo-parameter (`RENDER_OWNER_ID`) at build time.
   */
  optional?: string[];
  /** Synthetic properties not in the request schema (path parameters such as CustomDomain's `serviceId`). */
  extraProperties?: ParsedProperty[];
  /** Synthetic attributes not in the response schema (datastore connection strings, read from a side endpoint). */
  extraAttributes?: ParsedAttribute[];
  /**
   * Property → additional TS union members. Render's cross-resource fields are
   * opaque ids (`serviceId`, `projectId`, `environmentId`); widening them to
   * accept the declared resource lets `serviceId: web` reference another entity
   * and have the applier substitute the live id after it exists.
   */
  widen?: Record<string, string>;
  /** Property → full TS type replacement (array-valued references, where a plain union would not typecheck). */
  retype?: Record<string, string>;
  /**
   * Properties the API marks optional but that are required in practice —
   * `serviceDetails` on every runtime-bearing service (its `runtime` is
   * required; a WebService without it is rejected by the API).
   */
  require?: string[];
}

const SERVICES = "Services";
const DATASTORES = "Datastores";
const CONFIG = "Config";
const PROJECTS = "Projects";

const OWNER_OPTIONAL = ["ownerId"];

const SERVICE_REF = "WebService | PrivateService | BackgroundWorker | CronJob | StaticSite";

/** Common shape of the five service resources — the `servicePOST` body with `type` fixed and `serviceDetails` narrowed. */
function service(name: string, type: string, details: string, requireDetails = true): ResourceSpec {
  return {
    typeName: `${NAMESPACE}::${SERVICES}::${name}`,
    request: "servicePOST",
    response: "service",
    fixed: { type },
    overrides: { serviceDetails: details },
    optional: OWNER_OPTIONAL,
    require: requireDetails ? ["serviceDetails"] : [],
    widen: { environmentId: "Environment" },
  };
}

/**
 * Required fields on property-type schemas that chant defaults at build time,
 * so authors need not repeat them: `image.ownerId` follows the owning service's
 * `ownerId` (Render requires the two to match anyway).
 */
const PROPERTY_OPTIONAL: Record<string, string[]> = {
  image: ["ownerId"],
};

/**
 * Cross-resource id fields on property-type schemas, widened to accept the
 * declared resource (see `ResourceSpec.widen`).
 */
const PROPERTY_WIDEN: Record<string, Record<string, string>> = {
  image: { registryCredentialId: "RegistryCredential" },
  dockerDetailsPOST: { registryCredentialId: "RegistryCredential" },
};

const CONNECTION_STRING_ATTRS: ParsedAttribute[] = [
  { name: "internalConnectionString", tsType: "string" },
  { name: "externalConnectionString", tsType: "string" },
];

export const RESOURCES: ResourceSpec[] = [
  service("WebService", "web_service", "webServiceDetailsPOST"),
  service("StaticSite", "static_site", "staticSiteDetailsPOST", false),
  service("PrivateService", "private_service", "privateServiceDetailsPOST"),
  service("BackgroundWorker", "background_worker", "backgroundWorkerDetailsPOST"),
  service("CronJob", "cron_job", "cronJobDetailsPOST"),
  {
    typeName: `${NAMESPACE}::${DATASTORES}::Postgres`,
    request: "postgresPOSTInput",
    response: "postgresDetail",
    optional: OWNER_OPTIONAL,
    widen: { environmentId: "Environment" },
    extraAttributes: [...CONNECTION_STRING_ATTRS, { name: "psqlCommand", tsType: "string" }],
  },
  {
    typeName: `${NAMESPACE}::${DATASTORES}::KeyValue`,
    request: "keyValuePOSTInput",
    response: "keyValueDetail",
    optional: OWNER_OPTIONAL,
    widen: { environmentId: "Environment" },
    extraAttributes: [...CONNECTION_STRING_ATTRS, { name: "cliCommand", tsType: "string" }],
  },
  {
    typeName: `${NAMESPACE}::${CONFIG}::EnvGroup`,
    request: "envGroupPOSTInput",
    response: "envGroup",
    optional: OWNER_OPTIONAL,
    widen: { environmentId: "Environment" },
    retype: { serviceIds: `(string | ${SERVICE_REF})[]` },
  },
  {
    typeName: `${NAMESPACE}::${CONFIG}::RegistryCredential`,
    request: "#/paths/~1registrycredentials/post/requestBody/content/application~1json/schema",
    response: "registryCredential",
    optional: OWNER_OPTIONAL,
  },
  {
    typeName: `${NAMESPACE}::${CONFIG}::Webhook`,
    request: "#/paths/~1webhooks/post/requestBody/content/application~1json/schema",
    response: "#/paths/~1webhooks/post/responses/201/content/application~1json/schema",
    optional: OWNER_OPTIONAL,
  },
  {
    typeName: `${NAMESPACE}::${PROJECTS}::Project`,
    request: "projectPOSTInput",
    response: "project",
    optional: OWNER_OPTIONAL,
  },
  {
    typeName: `${NAMESPACE}::${PROJECTS}::Environment`,
    request: "environmentPOSTInput",
    response: "environment",
    widen: { projectId: "Project" },
  },
  {
    typeName: `${NAMESPACE}::${SERVICES}::Disk`,
    request: "#/paths/~1disks/post/requestBody/content/application~1json/schema",
    response: "#/paths/~1disks/post/responses/201/content/application~1json/schema",
    widen: { serviceId: "WebService | PrivateService | BackgroundWorker" },
  },
  {
    typeName: `${NAMESPACE}::${SERVICES}::CustomDomain`,
    request: "#/paths/~1services~1{serviceId}~1custom-domains/post/requestBody/content/application~1json/schema",
    response: "customDomain",
    extraProperties: [
      {
        name: "serviceId",
        tsType: `string | WebService | StaticSite`,
        required: true,
        description: "The service the domain is attached to — an id, or a declared WebService/StaticSite.",
        constraints: {},
      },
    ],
  },
];

/**
 * Schema-name aliases: the spec's `cronJobDetailsPOST.envSpecificDetails`
 * points at the response-shaped `envSpecificDetails` rather than the POST one
 * every other service type uses. Route it to the POST shape so the lexicon has
 * one `EnvSpecificDetails` union, not two colliding classes.
 */
const SCHEMA_ALIASES: Record<string, string> = {
  envSpecificDetails: "envSpecificDetailsPOST",
  dockerDetails: "dockerDetailsPOST",
  nativeEnvironmentDetails: "nativeEnvironmentDetailsPOST",
};

/**
 * Anonymous inline schemas Render leaves at `#/paths/...` pointers that deserve
 * a class of their own — env var entries, secret files, autoscaling — hoisted
 * into `components.schemas` under these names before parsing, so authors write
 * `new EnvVar({ key, value })` and `new Autoscaling({...})` like every other
 * property type (chant's COR001 wants each config value to be a Declarable,
 * not an inline object). Innermost first: an outer hoist then sees its inner
 * one as a `$ref`.
 */
const HOISTED: Array<{ pointer: string; name: string }> = [
  {
    pointer: "#/paths/~1services~1{serviceId}~1env-vars/put/requestBody/content/application~1json/schema/items/oneOf/0",
    name: "EnvVar",
  },
  {
    pointer: "#/paths/~1services~1{serviceId}~1env-vars/put/requestBody/content/application~1json/schema/items/oneOf/1",
    name: "GeneratedEnvVar",
  },
  {
    pointer: "#/paths/~1services~1{serviceId}~1secret-files/put/requestBody/content/application~1json/schema/items",
    name: "SecretFile",
  },
  {
    pointer: "#/paths/~1services~1{serviceId}~1autoscaling/put/requestBody/content/application~1json/schema/properties/criteria/properties/cpu",
    name: "AutoscalingCriterion",
  },
  {
    pointer: "#/paths/~1services~1{serviceId}~1autoscaling/put/requestBody/content/application~1json/schema/properties/criteria/properties/memory",
    name: "AutoscalingCriterion",
  },
  {
    pointer: "#/paths/~1services~1{serviceId}~1autoscaling/put/requestBody/content/application~1json/schema/properties/criteria",
    name: "AutoscalingCriteria",
  },
  {
    pointer: "#/paths/~1services~1{serviceId}~1autoscaling/put/requestBody/content/application~1json/schema",
    name: "Autoscaling",
  },
];

/** Class-name overrides where the suffix-stripping rule below misfires. */
const CLASS_NAME_OVERRIDES: Record<string, string> = {
  projectPOSTEnvironmentInput: "ProjectEnvironment",
};

const COMPONENT_PREFIX = "#/components/schemas/";

// ── Parser ─────────────────────────────────────────────────────────

/**
 * Parse the Render OpenAPI spec into the curated resources and the property
 * types reachable from their request schemas.
 */
export function parseRenderOpenAPI(data: string | Buffer): RenderParseResult[] {
  const spec: OpenAPISpec = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
  const schemas = spec.components?.schemas ?? {};
  const ctx = new ParseContext(spec, schemas);
  ctx.hoist(HOISTED);

  // Phase 1: discover the emitted property-type set — named object schemas
  // reachable (transitively) from the request schemas' properties.
  ctx.collectPropertyTypes();

  const results: RenderParseResult[] = [];

  // Phase 2: resources.
  for (const rspec of RESOURCES) {
    const req = ctx.locate(rspec.request);
    const res = ctx.locate(rspec.response);
    const reqProps = ctx.flattenProperties(req);
    const requiredSet = new Set(ctx.flattenRequired(req));
    const fixed = rspec.fixed ?? {};
    const optional = new Set(rspec.optional ?? []);
    const forced = new Set(rspec.require ?? []);

    const properties: ParsedProperty[] = [];
    for (const [name, prop] of Object.entries(reqProps)) {
      if (name in fixed) continue;
      const override = rspec.overrides?.[name];
      let tsType = override ? ctx.resolveLocator(override) : ctx.resolveType(prop);
      const widen = rspec.widen?.[name];
      if (widen) tsType = `${tsType} | ${widen}`;
      const retype = rspec.retype?.[name];
      if (retype) tsType = retype;
      properties.push({
        name,
        tsType,
        required: (requiredSet.has(name) || forced.has(name)) && !optional.has(name),
        description: prop.description,
        constraints: coreExtractConstraints(prop as JsonSchemaProperty),
      });
    }
    for (const extra of rspec.extraProperties ?? []) properties.push(extra);

    // Attributes = response props not present in the request schema.
    const attributes: ParsedAttribute[] = [];
    for (const [name, prop] of Object.entries(ctx.flattenProperties(res))) {
      if (name in reqProps) continue;
      attributes.push({ name, tsType: ctx.resolveType(prop) });
    }
    for (const extra of rspec.extraAttributes ?? []) attributes.push(extra);

    results.push({
      resource: { typeName: rspec.typeName, description: req?.description, properties, attributes },
      propertyTypes: [],
      enums: [],
    });
  }

  // Phase 3: property-type classes.
  for (const schemaName of ctx.emitted) {
    const def = schemas[schemaName];
    const requiredSet = new Set(ctx.flattenRequired(def));
    const optional = new Set(PROPERTY_OPTIONAL[schemaName] ?? []);
    const widen = PROPERTY_WIDEN[schemaName] ?? {};
    const properties: ParsedProperty[] = [];
    for (const [name, prop] of Object.entries(ctx.flattenProperties(def))) {
      const base = ctx.resolveType(prop);
      properties.push({
        name,
        tsType: widen[name] ? `${base} | ${widen[name]}` : base,
        required: requiredSet.has(name) && !optional.has(name),
        description: prop.description,
        constraints: coreExtractConstraints(prop as JsonSchemaProperty),
      });
    }
    results.push({
      resource: {
        typeName: `${NAMESPACE}::${SERVICES}::${schemaToClassName(schemaName)}`,
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

class ParseContext {
  /** Emitted property-type schema names, in insertion order. */
  readonly emitted: string[] = [];
  private readonly emittedSet = new Set<string>();
  private readonly classNames = new Map<string, string>();

  constructor(
    private readonly spec: OpenAPISpec,
    private readonly schemas: Record<string, OpenAPISchema>,
  ) {}

  /**
   * Hoist anonymous inline schemas into named components: the node at each
   * pointer moves to `schemas[name]` and a `$ref` to it takes its place. Two
   * pointers may share a name when their shapes are identical (autoscaling's
   * cpu/memory criteria) — the first wins, the second becomes a `$ref` to it.
   */
  hoist(entries: Array<{ pointer: string; name: string }>): void {
    for (const { pointer, name } of entries) {
      const parts = pointer.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
      const key = parts.pop()!;
      let parent: unknown = this.spec;
      for (const part of parts) {
        if (!parent || typeof parent !== "object") {
          parent = undefined;
          break;
        }
        parent = (parent as Record<string, unknown>)[part];
      }
      if (!parent || typeof parent !== "object") continue;
      const node = (parent as Record<string, unknown>)[key];
      if (!node || typeof node !== "object") continue;
      if ((node as OpenAPISchema).$ref) {
        // Already a reference (Render points `memory` at `cpu`): when the
        // hoisted class exists, retarget the reference at it — the original
        // pointer may pass through a node an earlier hoist has since replaced.
        if (this.schemas[name]) (parent as Record<string, unknown>)[key] = { $ref: `${COMPONENT_PREFIX}${name}` };
        continue;
      }
      if (!this.schemas[name]) this.schemas[name] = node as OpenAPISchema;
      (parent as Record<string, unknown>)[key] = { $ref: `${COMPONENT_PREFIX}${name}` };
    }
  }

  /** Resolve a schema locator (bare component name or `#/...` pointer) to its schema node. */
  locate(locator: string): OpenAPISchema | undefined {
    if (locator.startsWith("#/")) return this.pointer(locator);
    return this.schemas[canonicalSchemaName(locator)];
  }

  /** Resolve a JSON pointer inside the spec document (`#/paths/~1disks/post/...`). */
  pointer(ref: string): OpenAPISchema | undefined {
    const parts = ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
    let node: unknown = this.spec;
    for (const part of parts) {
      if (!node || typeof node !== "object") return undefined;
      node = (node as Record<string, unknown>)[part];
    }
    return node as OpenAPISchema | undefined;
  }

  /** Follow a `$ref` (component or pointer) to its target node. */
  deref(ref: string): OpenAPISchema | undefined {
    if (isComponentRef(ref)) return this.schemas[canonicalSchemaName(ref.slice(COMPONENT_PREFIX.length))];
    if (ref.startsWith("#/")) return this.pointer(ref);
    return undefined;
  }

  /** Properties of a schema, merging `allOf` members (Render's `envGroup` is `allOf: [envGroupMeta, {...}]`). */
  flattenProperties(def: OpenAPISchema | undefined): Record<string, OpenAPISchema> {
    if (!def) return {};
    const out: Record<string, OpenAPISchema> = {};
    for (const member of def.allOf ?? []) {
      const target = member.$ref ? this.deref(member.$ref) : member;
      Object.assign(out, this.flattenProperties(target));
    }
    Object.assign(out, def.properties ?? {});
    return out;
  }

  flattenRequired(def: OpenAPISchema | undefined): string[] {
    if (!def) return [];
    const out: string[] = [];
    for (const member of def.allOf ?? []) {
      const target = member.$ref ? this.deref(member.$ref) : member;
      out.push(...this.flattenRequired(target));
    }
    out.push(...(def.required ?? []));
    return out;
  }

  /**
   * Walk the curated request schemas (and their overrides) and collect the
   * named object schemas reachable through their properties — following $ref,
   * allOf, oneOf, arrays, and maps. Only `#/components/schemas/X` targets become
   * classes; anonymous inline objects stay inline.
   */
  collectPropertyTypes(): void {
    const queue: string[] = [];
    const seed = (node: unknown) => {
      for (const ref of collectRefs(node)) {
        if (!isComponentRef(ref)) {
          // A pointer into paths (or a nested component property): walk its target for further component refs.
          const target = this.deref(ref);
          if (target) seed(target);
          continue;
        }
        const name = canonicalSchemaName(ref.slice(COMPONENT_PREFIX.length));
        const target = this.schemas[name];
        if (!target) continue;
        if (this.isObjectSchema(target) && !this.emittedSet.has(name)) {
          this.emittedSet.add(name);
          this.emitted.push(name);
          queue.push(name);
        } else if (!this.isObjectSchema(target)) {
          // A oneOf-of-refs (envSpecificDetailsPOST) or array alias: walk through it.
          seed(target);
        }
      }
    };

    for (const rspec of RESOURCES) {
      const req = this.locate(rspec.request);
      const props = this.flattenProperties(req);
      for (const [name, prop] of Object.entries(props)) {
        if (rspec.fixed && name in rspec.fixed) continue;
        const override = rspec.overrides?.[name];
        if (override) {
          seed({ $ref: override.startsWith("#/") ? override : `${COMPONENT_PREFIX}${override}` });
        } else {
          seed(prop);
        }
      }
    }
    while (queue.length > 0) {
      const name = queue.shift()!;
      seed(this.flattenProperties(this.schemas[name]));
    }
  }

  /** An object schema with properties (directly or via allOf), not a pure enum. */
  isObjectSchema(def: OpenAPISchema): boolean {
    if (isEnumDefinition(def)) return false;
    return Object.keys(this.flattenProperties(def)).length > 0;
  }

  /** Resolve a locator (as used by `overrides`) to a TS type. */
  resolveLocator(locator: string): string {
    if (locator.startsWith("#/")) return this.resolveType({ $ref: locator });
    return this.resolveType({ $ref: `${COMPONENT_PREFIX}${locator}` });
  }

  /**
   * Resolve an OpenAPI schema node to its TypeScript type string. Emitted object
   * schemas resolve to their class name; enums inline as string-literal unions;
   * anonymous objects inline as object literals; everything else falls back to
   * primitives or `Record<string, any>`.
   */
  resolveType(prop: OpenAPISchema | undefined, depth = 0): string {
    if (!prop) return "any";
    if (depth > 8) return "any";

    if (prop.$ref) return this.resolveRefType(prop.$ref, depth);

    // allOf: [{ $ref }] — the OpenAPI idiom for "typed as this schema"; a
    // multi-member allOf (envGroup) is an object merge — inline it.
    if (prop.allOf && prop.allOf.length > 0) {
      if (prop.allOf.length === 1 && prop.allOf[0].$ref) return this.resolveRefType(prop.allOf[0].$ref, depth);
      return this.inlineObject(prop, depth);
    }

    const variants = prop.oneOf ?? prop.anyOf;
    if (variants && variants.length > 0) {
      const members = variants.map((v) => this.resolveType(v, depth + 1));
      return dedupe(members).join(" | ");
    }

    if (prop.enum && prop.enum.length > 0) {
      return enumUnion(prop.enum);
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
          const itemType = this.resolveType(prop.items, depth + 1);
          return itemType.includes(" | ") ? `(${itemType})[]` : `${itemType}[]`;
        }
        return "any[]";
      }
      case "object":
        if (prop.properties && Object.keys(prop.properties).length > 0) {
          return this.inlineObject(prop, depth);
        }
        if (prop.additionalProperties && typeof prop.additionalProperties === "object") {
          return `Record<string, ${this.resolveType(prop.additionalProperties, depth + 1)}>`;
        }
        return "Record<string, any>";
      default:
        // Untyped node with properties (some inline bodies omit `type`).
        if (prop.properties && Object.keys(prop.properties).length > 0) return this.inlineObject(prop, depth);
        return "any";
    }
  }

  /** Render an anonymous object schema as a TS object literal type. */
  private inlineObject(def: OpenAPISchema, depth: number): string {
    const props = this.flattenProperties(def);
    const required = new Set(this.flattenRequired(def));
    const members = Object.entries(props).map(([name, p]) => {
      const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
      return `${key}${required.has(name) ? "" : "?"}: ${this.resolveType(p, depth + 1)}`;
    });
    return `{ ${members.join("; ")} }`;
  }

  /** Resolve a `$ref` (component or pointer) to a TypeScript type. */
  private resolveRefType(ref: string, depth: number): string {
    if (!isComponentRef(ref)) {
      // A pointer into paths, or into a component's nested property
      // (`#/components/schemas/redisDetail/properties/maintenance`) — no
      // class, resolve structurally.
      return ref.startsWith("#/") ? this.resolveType(this.pointer(ref), depth + 1) : "any";
    }
    const name = canonicalSchemaName(ref.slice(COMPONENT_PREFIX.length));
    const def = this.schemas[name];
    if (!def) return "any";

    // Emitted object schemas reference their class by name.
    if (this.emittedSet.has(name)) return schemaToClassName(name);

    // Enums inline as string-literal unions.
    if (isEnumDefinition(def)) return enumUnion(def.enum ?? []);

    // Non-object aliases (oneOf-of-refs, arrays, primitives): resolve through.
    if (!this.isObjectSchema(def)) return this.resolveType(def, depth + 1);

    // Object schemas we did not emit (response-only shapes) loosen to a map.
    return "Record<string, any>";
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/** Collect every `$ref` string nested anywhere in a node. */
function collectRefs(node: unknown, acc: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === "string") acc.add(ref);
  for (const [key, value] of Object.entries(obj)) {
    if (key === "$ref") continue;
    collectRefs(value, acc);
  }
  return acc;
}

/** A `$ref` to a whole component schema (`#/components/schemas/X`), not a pointer into one. */
function isComponentRef(ref: string): boolean {
  return ref.startsWith(COMPONENT_PREFIX) && !ref.slice(COMPONENT_PREFIX.length).includes("/");
}

function enumUnion(values: unknown[]): string {
  return [...values].map((v) => JSON.stringify(v)).sort().join(" | ");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Apply the schema aliases (spec quirks) to a component name. */
export function canonicalSchemaName(name: string): string {
  return SCHEMA_ALIASES[name] ?? name;
}

// ── Naming helpers ─────────────────────────────────────────────────

/**
 * Convert a component schema name into a PascalCase class name, dropping the
 * request-shape suffixes Render uses so the authoring surface reads as the
 * concept, not the wire DTO:
 * "webServiceDetailsPOST" → "WebServiceDetails", "readReplicaInput" →
 * "ReadReplica", "routePost" → "Route", "cidrBlockAndDescription" →
 * "CidrBlockAndDescription".
 */
export function schemaToClassName(schemaName: string): string {
  const override = CLASS_NAME_OVERRIDES[schemaName];
  if (override) return override;
  let base = schemaName;
  base = base.replace(/Input$/, "");
  base = base.replace(/(POST|PATCH|PUT|Post|Patch|Put)$/, "");
  base = base.replace(/Input$/, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Extract short name: "Render::Services::WebService" → "WebService". */
export function renderShortName(typeName: string): string {
  const parts = typeName.split("::");
  return parts[parts.length - 1];
}

/** Extract service name: "Render::Services::WebService" → "Services". */
export function renderServiceName(typeName: string): string {
  const parts = typeName.split("::");
  return parts.length >= 2 ? parts[1] : SERVICES;
}
