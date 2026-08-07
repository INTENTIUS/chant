/**
 * k3d SimpleConfig JSON Schema parser.
 *
 * Parses the single v1alpha5 schema into multiple entity results — the
 * Cluster resource plus one property entity per nested config object
 * (Metadata, Volume, Registries, Options, etc.).
 */

import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import {
  extractConstraints as coreExtractConstraints,
  constraintsIsEmpty as coreConstraintsIsEmpty,
  primaryType,
  type JsonSchemaProperty,
} from "@intentius/chant/codegen/json-schema";

// ── Types ──────────────────────────────────────────────────────────

export type { PropertyConstraints };
export { coreConstraintsIsEmpty as constraintsIsEmpty };

export interface ParsedProperty {
  name: string;
  tsType: string;
  required: boolean;
  description?: string;
  enum?: string[];
  constraints: PropertyConstraints;
}

export interface ParsedPropertyType {
  name: string;
  defType: string;
  properties: ParsedProperty[];
}

export interface ParsedEnum {
  name: string;
  values: string[];
}

export interface ParsedResource {
  typeName: string;
  description?: string;
  properties: ParsedProperty[];
  attributes: Array<{ name: string; tsType: string }>;
  deprecatedProperties: string[];
}

export interface K3dParseResult {
  resource: ParsedResource;
  propertyTypes: ParsedPropertyType[];
  enums: ParsedEnum[];
  isProperty?: boolean;
}

// ── Schema types ──────────────────────────────────────────────────

interface SchemaDefinition {
  type?: string | string[];
  description?: string;
  // A property value can be a bare boolean ("additionalProperties": false
  // misplaced inside a properties block — see parseProperties).
  properties?: Record<string, SchemaProperty | boolean>;
  required?: string[];
  enum?: string[];
  $ref?: string;
  items?: SchemaProperty;
  examples?: unknown[];
  const?: unknown;
  default?: unknown;
  additionalProperties?: boolean | SchemaProperty;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
}

interface SchemaProperty extends SchemaDefinition {}

interface ConfigSchema {
  title?: string;
  definitions?: Record<string, SchemaDefinition>;
  properties?: Record<string, SchemaProperty | boolean>;
  required?: string[];
  [key: string]: unknown;
}

// ── Entity extraction mapping ──────────────────────────────────────

const RESOURCE_ENTITIES: Array<{
  typeName: string;
  source: string;
  description?: string;
}> = [
  {
    typeName: "K3d::Cluster",
    source: "root",
    description: "A k3d cluster (SimpleConfig, apiVersion k3d.io/v1alpha5)",
  },
];

const PROPERTY_ENTITIES: Array<{
  typeName: string;
  source: string;
  description?: string;
}> = [
  { typeName: "K3d::Metadata", source: "metadata", description: "Cluster metadata (name)" },
  { typeName: "K3d::KubeAPI", source: "kubeAPI", description: "Kubernetes API server exposure settings" },
  { typeName: "K3d::Volume", source: "volumes:item", description: "A volume mount with node filters" },
  { typeName: "K3d::Port", source: "ports:item", description: "A port mapping with node filters" },
  { typeName: "K3d::File", source: "files:item", description: "A file to copy into nodes" },
  { typeName: "K3d::EnvVar", source: "env:item", description: "An environment variable with node filters" },
  { typeName: "K3d::HostAlias", source: "hostAliases:item", description: "An IP to hostnames mapping" },
  { typeName: "K3d::Registries", source: "registries", description: "Registry configuration" },
  { typeName: "K3d::RegistryCreate", source: "registries.create", description: "Create a new container image registry alongside the cluster" },
  { typeName: "K3d::RegistryProxy", source: "registries.create.proxy", description: "Pull-through proxy settings for a created registry" },
  { typeName: "K3d::Options", source: "options", description: "Cluster options (k3d, k3s, kubeconfig, runtime)" },
  { typeName: "K3d::K3dOptions", source: "options.k3d", description: "k3d-specific options" },
  { typeName: "K3d::LoadbalancerOptions", source: "options.k3d.loadbalancer", description: "Loadbalancer options" },
  { typeName: "K3d::K3sOptions", source: "options.k3s", description: "k3s-specific options" },
  { typeName: "K3d::K3sExtraArg", source: "options.k3s.extraArgs:item", description: "An extra k3s server/agent argument with node filters" },
  { typeName: "K3d::NodeLabel", source: "options.k3s.nodeLabels:item", description: "A Kubernetes node label with node filters" },
  { typeName: "K3d::KubeconfigOptions", source: "options.kubeconfig", description: "Kubeconfig update behaviour" },
  { typeName: "K3d::RuntimeOptions", source: "options.runtime", description: "Container runtime options" },
  { typeName: "K3d::RuntimeLabel", source: "options.runtime.labels:item", description: "A container runtime label with node filters" },
  { typeName: "K3d::Ulimit", source: "options.runtime.ulimits:item", description: "A ulimit setting for nodes" },
];

// ── Parser ─────────────────────────────────────────────────────────

/**
 * Parse the k3d SimpleConfig JSON Schema into multiple entity results.
 */
export function parseConfigSchema(data: string | Buffer): K3dParseResult[] {
  const schema: ConfigSchema = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
  const results: K3dParseResult[] = [];

  for (const entity of RESOURCE_ENTITIES) {
    const result = extractEntity(schema, entity);
    if (result) results.push(result);
  }

  for (const entity of PROPERTY_ENTITIES) {
    const result = extractEntity(schema, entity);
    if (result) {
      result.isProperty = true;
      results.push(result);
    }
  }

  return results;
}

function extractEntity(
  schema: ConfigSchema,
  entity: { typeName: string; source: string; description?: string },
): K3dParseResult | null {
  const def = resolveSource(schema, entity.source);
  if (!def?.properties) return null;

  const properties = parseProperties(def.properties, new Set(def.required ?? []), schema);

  const overrides = PROPERTY_OVERRIDES[entity.typeName];
  if (overrides) {
    for (const prop of properties) {
      if (overrides[prop.name]) {
        prop.tsType = overrides[prop.name];
      }
    }
  }

  return {
    resource: {
      typeName: entity.typeName,
      description: entity.description ?? def.description,
      properties,
      attributes: [],
      deprecatedProperties: [],
    },
    propertyTypes: [],
    enums: [],
  };
}

// ── Source resolution ──────────────────────────────────────────────

/**
 * Resolve an extraction source to a schema definition.
 *
 * Sources are:
 * - "root" — the schema document itself (K3d::Cluster)
 * - a dotted path of property names from the root, e.g. "options.k3d"
 * - a dotted path ending in ":item" for array item schemas,
 *   e.g. "volumes:item", "options.k3s.extraArgs:item"
 */
function resolveSource(schema: ConfigSchema, source: string): SchemaDefinition | null {
  if (source === "root") {
    return { properties: schema.properties, required: schema.required };
  }

  const wantsItem = source.endsWith(":item");
  const path = wantsItem ? source.slice(0, -":item".length) : source;

  let current: SchemaDefinition | null = { properties: schema.properties };
  for (const seg of path.split(".")) {
    const next: SchemaProperty | boolean | undefined = current?.properties?.[seg];
    if (!next || typeof next === "boolean") return null;
    current = next;
  }
  if (!current) return null;

  if (wantsItem) {
    return current.items ?? null;
  }
  return current;
}

function resolveRef(ref: string, schema: ConfigSchema): SchemaDefinition | null {
  const prefix = "#/definitions/";
  if (!ref.startsWith(prefix)) return null;
  const defName = ref.slice(prefix.length);
  return schema.definitions?.[defName] ?? null;
}

// ── Property parsing ──────────────────────────────────────────────

function parseProperties(
  properties: Record<string, SchemaProperty | boolean>,
  requiredSet: Set<string>,
  schema: ConfigSchema,
): ParsedProperty[] {
  const result: ParsedProperty[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    // Upstream schema bug (present in v5.9.0): inside `registries.properties`
    // the key `"additionalProperties": false` is nested INSIDE the properties
    // block instead of sitting beside it, so a naive walk would emit a config
    // property literally named "additionalProperties" whose schema is the
    // bare boolean `false`. Drop it — it is a misplaced schema keyword, not a
    // property. Keep this guard on regeneration until upstream fixes the
    // schema, or the bogus property comes back.
    if (name === "additionalProperties" && typeof prop === "boolean") continue;
    if (typeof prop === "boolean") continue;

    const tsType = resolvePropertyType(prop, schema);
    result.push({
      name,
      tsType,
      required: requiredSet.has(name),
      description: prop.description,
      enum: prop.enum,
      constraints: coreExtractConstraints(prop as JsonSchemaProperty),
    });
  }
  return result;
}

function resolvePropertyType(prop: SchemaProperty, schema: ConfigSchema): string {
  if (!prop) return "any";

  if (prop.$ref) {
    const def = resolveRef(prop.$ref, schema);
    // The only definition in the v1alpha5 schema is nodeFilters
    // (array of strings); resolve through it structurally.
    if (def) return resolvePropertyType(def, schema);
    return "any";
  }

  if (prop.enum && prop.enum.length > 0) {
    return prop.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  const pt = primaryType(prop.type);
  switch (pt) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "array":
      if (prop.items) {
        const itemType = resolvePropertyType(prop.items, schema);
        if (itemType.includes(" | ")) return `(${itemType})[]`;
        return `${itemType}[]`;
      }
      return "any[]";
    case "object": return "Record<string, any>";
    default:
      // Upstream schema quirk (v5.9.0): `options.k3d.timeout` declares
      // `examples` ("60s", "1m", "1m30s") but no `type` at all. It is a Go
      // time.Duration string upstream, so when a type-less schema carries
      // string examples we treat it as a string (duration) rather than `any`.
      if (Array.isArray(prop.examples) && prop.examples.length > 0 && prop.examples.every((e) => typeof e === "string")) {
        return "string";
      }
      return "any";
  }
}

// ── Property overrides ────────────────────────────────────────────

/**
 * Cross-reference nested objects to their extracted property entity
 * classes so authors get typed constructors instead of Record<string, any>.
 */
const PROPERTY_OVERRIDES: Record<string, Record<string, string>> = {
  "K3d::Cluster": {
    metadata: "Metadata",
    kubeAPI: "KubeAPI",
    volumes: "Volume[]",
    ports: "Port[]",
    files: "File[]",
    env: "EnvVar[]",
    hostAliases: "HostAlias[]",
    registries: "Registries",
    options: "Options",
  },
  "K3d::Registries": {
    create: "RegistryCreate",
  },
  "K3d::RegistryCreate": {
    proxy: "RegistryProxy",
  },
  "K3d::Options": {
    k3d: "K3dOptions",
    k3s: "K3sOptions",
    kubeconfig: "KubeconfigOptions",
    runtime: "RuntimeOptions",
  },
  "K3d::K3dOptions": {
    loadbalancer: "LoadbalancerOptions",
  },
  "K3d::K3sOptions": {
    extraArgs: "K3sExtraArg[]",
    nodeLabels: "NodeLabel[]",
  },
  "K3d::RuntimeOptions": {
    labels: "RuntimeLabel[]",
    ulimits: "Ulimit[]",
  },
};

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Extract short name: "K3d::Cluster" → "Cluster"
 */
export function k3dShortName(typeName: string): string {
  const parts = typeName.split("::");
  return parts[parts.length - 1];
}

/**
 * Extract service name: always "K3d" — the lexicon is a single flat service.
 */
export function k3dServiceName(_typeName: string): string {
  return "K3d";
}
