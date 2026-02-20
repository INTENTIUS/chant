/**
 * GitLab CI JSON Schema parser.
 *
 * Parses the single CI schema into multiple entity results — one per CI
 * entity (Job, Pipeline, Artifacts, Cache, etc.). The schema is a single
 * document unlike CloudFormation which has one schema per resource type.
 */

import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import {
  extractConstraints as coreExtractConstraints,
  constraintsIsEmpty as coreConstraintsIsEmpty,
  primaryType,
  type JsonSchemaProperty,
  type JsonSchemaDocument,
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
  /** The definition name in the original schema */
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
}

export interface GitLabParseResult {
  resource: ParsedResource;
  propertyTypes: ParsedPropertyType[];
  enums: ParsedEnum[];
  /** Whether this entity is a "property" type (nested inside resources) */
  isProperty?: boolean;
}

// ── Schema types ──────────────────────────────────────────────────

interface CISchemaDefinition {
  type?: string | string[];
  description?: string;
  properties?: Record<string, CISchemaProperty>;
  required?: string[];
  enum?: string[];
  oneOf?: CISchemaProperty[];
  anyOf?: CISchemaProperty[];
  $ref?: string;
  items?: CISchemaProperty;
  const?: unknown;
  default?: unknown;
  additionalProperties?: boolean | CISchemaProperty;
  patternProperties?: Record<string, CISchemaProperty>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
}

interface CISchemaProperty extends CISchemaDefinition {
  // Same shape as definition
}

interface CISchema {
  definitions?: Record<string, CISchemaDefinition>;
  properties?: Record<string, CISchemaProperty>;
  patternProperties?: Record<string, CISchemaProperty>;
  additionalProperties?: boolean | CISchemaProperty;
  required?: string[];
  [key: string]: unknown;
}

// ── Entity extraction mapping ──────────────────────────────────────

/**
 * Top-level entities (resources) to extract from the schema.
 */
const RESOURCE_ENTITIES: Array<{
  typeName: string;
  /** Schema path — "root" for root object, or "#/definitions/<name>" */
  source: string;
  description?: string;
}> = [
  {
    typeName: "GitLab::CI::Job",
    source: "#/definitions/job_template",
    description: "A GitLab CI/CD job definition",
  },
  {
    typeName: "GitLab::CI::Default",
    source: "root:default",
    description: "Default settings inherited by all jobs",
  },
  {
    typeName: "GitLab::CI::Workflow",
    source: "root:workflow",
    description: "Pipeline-level workflow configuration",
  },
];

/**
 * Property types (nested) to extract from definitions.
 */
const PROPERTY_ENTITIES: Array<{
  typeName: string;
  source: string;
  description?: string;
}> = [
  { typeName: "GitLab::CI::Artifacts", source: "#/definitions/artifacts", description: "Job artifact configuration" },
  { typeName: "GitLab::CI::Cache", source: "#/definitions/cache_item", description: "Cache configuration" },
  { typeName: "GitLab::CI::Image", source: "#/definitions/image", description: "Docker image for a job" },
  { typeName: "GitLab::CI::Service", source: "#/definitions/services:item", description: "Docker service container for a job" },
  { typeName: "GitLab::CI::Rule", source: "#/definitions/rules:item", description: "Conditional rule for job execution" },
  { typeName: "GitLab::CI::Retry", source: "#/definitions/retry", description: "Job retry configuration" },
  { typeName: "GitLab::CI::AllowFailure", source: "#/definitions/allow_failure", description: "Allow failure configuration" },
  { typeName: "GitLab::CI::Parallel", source: "#/definitions/parallel", description: "Parallel job configuration" },
  { typeName: "GitLab::CI::Include", source: "#/definitions/include_item", description: "Include configuration item" },
  { typeName: "GitLab::CI::Release", source: "job_template:release", description: "Release configuration" },
  { typeName: "GitLab::CI::Environment", source: "job_template:environment", description: "Deployment environment" },
  { typeName: "GitLab::CI::Trigger", source: "job_template:trigger", description: "Trigger downstream pipeline" },
  { typeName: "GitLab::CI::AutoCancel", source: "#/definitions/workflowAutoCancel", description: "Auto-cancel configuration" },
];

/**
 * Enum types to extract.
 */
const ENUM_ENTITIES: Array<{
  name: string;
  source: string;
}> = [
  { name: "When", source: "#/definitions/when" },
  { name: "RetryError", source: "#/definitions/retry_errors" },
];

// ── Parser ─────────────────────────────────────────────────────────

/**
 * Parse the GitLab CI JSON Schema into multiple entity results.
 * Returns one result per CI entity with its properties and nested types.
 */
export function parseCISchema(data: string | Buffer): GitLabParseResult[] {
  const schema: CISchema = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
  const results: GitLabParseResult[] = [];

  // Extract resource entities
  for (const entity of RESOURCE_ENTITIES) {
    const result = extractResourceEntity(schema, entity);
    if (result) results.push(result);
  }

  // Extract property entities as pseudo-resources (each gets its own ParseResult)
  for (const entity of PROPERTY_ENTITIES) {
    const result = extractPropertyEntity(schema, entity);
    if (result) {
      result.isProperty = true;
      results.push(result);
    }
  }

  return results;
}

/**
 * Extract a resource entity from the schema.
 */
function extractResourceEntity(
  schema: CISchema,
  entity: { typeName: string; source: string; description?: string },
): GitLabParseResult | null {
  const def = resolveSource(schema, entity.source);
  if (!def) return null;

  // Find the object variant if it's a oneOf/anyOf
  const objectDef = findObjectVariant(def);
  if (!objectDef?.properties) return null;

  const requiredSet = new Set<string>(objectDef.required ?? []);
  const properties = parseProperties(objectDef.properties, requiredSet, schema);
  const shortName = gitlabShortName(entity.typeName);

  // Extract nested property types from definition properties
  const { propertyTypes, enums } = extractNestedTypes(objectDef, shortName, schema);

  return {
    resource: {
      typeName: entity.typeName,
      description: entity.description ?? objectDef.description,
      properties,
      attributes: [], // CI entities have no read-only attributes
    },
    propertyTypes,
    enums,
  };
}

/**
 * Extract a property entity — represented as a ParseResult with the entity
 * as the "resource" (the pipeline treats all parsed results uniformly).
 */
function extractPropertyEntity(
  schema: CISchema,
  entity: { typeName: string; source: string; description?: string },
): GitLabParseResult | null {
  const def = resolveSource(schema, entity.source);
  if (!def) return null;

  const objectDef = findObjectVariant(def);
  if (!objectDef?.properties) {
    // Some entities like Parallel might be simple types
    // Create a minimal entry with no properties
    return {
      resource: {
        typeName: entity.typeName,
        description: entity.description ?? def.description,
        properties: [],
        attributes: [],
      },
      propertyTypes: [],
      enums: [],
    };
  }

  const requiredSet = new Set<string>(objectDef.required ?? []);
  const properties = parseProperties(objectDef.properties, requiredSet, schema);
  const shortName = gitlabShortName(entity.typeName);

  const { propertyTypes, enums } = extractNestedTypes(objectDef, shortName, schema);

  return {
    resource: {
      typeName: entity.typeName,
      description: entity.description ?? objectDef.description,
      properties,
      attributes: [],
    },
    propertyTypes,
    enums,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Resolve a source path to a schema definition.
 */
function resolveSource(schema: CISchema, source: string): CISchemaDefinition | null {
  if (source.startsWith("#/definitions/")) {
    // Array item extraction: "#/definitions/foo:item" → foo.items object variant
    if (source.includes(":item")) {
      const defName = source.slice("#/definitions/".length).replace(":item", "");
      const arrayDef = schema.definitions?.[defName];
      if (!arrayDef?.items) return null;
      return findObjectVariant(arrayDef.items);
    }
    const defName = source.slice("#/definitions/".length);
    return schema.definitions?.[defName] ?? null;
  }

  if (source.startsWith("root:")) {
    const propName = source.slice("root:".length);
    const prop = schema.properties?.[propName];
    if (!prop) return null;
    if (prop.$ref) {
      return resolveRef(prop.$ref, schema);
    }
    return prop;
  }

  if (source.startsWith("job_template:")) {
    const propName = source.slice("job_template:".length);
    const jobDef = schema.definitions?.job_template;
    if (!jobDef?.properties) return null;
    const prop = jobDef.properties[propName];
    if (!prop) return null;
    if (prop.$ref) {
      return resolveRef(prop.$ref, schema);
    }
    return prop;
  }

  return null;
}

/**
 * Resolve a $ref string to a schema definition.
 */
function resolveRef(ref: string, schema: CISchema): CISchemaDefinition | null {
  const prefix = "#/definitions/";
  if (!ref.startsWith(prefix)) return null;
  const defName = ref.slice(prefix.length);
  return schema.definitions?.[defName] ?? null;
}

/**
 * Find the object variant from a oneOf/anyOf union, or return the
 * definition itself if it already has properties.
 */
function findObjectVariant(def: CISchemaDefinition): CISchemaDefinition | null {
  if (def.properties) return def;

  const variants = def.oneOf ?? def.anyOf;
  if (variants) {
    // Prefer the variant with the most properties
    let best: CISchemaDefinition | null = null;
    let bestCount = 0;
    for (const v of variants) {
      // Resolve $ref in variant
      let resolved: CISchemaDefinition = v;
      if (v.$ref) {
        // We don't have schema here, just check properties
        continue;
      }
      if (resolved.properties) {
        const count = Object.keys(resolved.properties).length;
        if (count > bestCount) {
          best = resolved;
          bestCount = count;
        }
      }
    }
    return best;
  }

  // If it's a $ref, it would have been resolved before calling this
  return null;
}

/**
 * Parse properties from a schema definition into ParsedProperty[].
 */
function parseProperties(
  properties: Record<string, CISchemaProperty>,
  requiredSet: Set<string>,
  schema: CISchema,
): ParsedProperty[] {
  const result: ParsedProperty[] = [];

  for (const [name, prop] of Object.entries(properties)) {
    // Skip internal/hidden properties
    if (name === "!reference") continue;

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

/**
 * Resolve a schema property to its TypeScript type string.
 */
function resolvePropertyType(prop: CISchemaProperty, schema: CISchema): string {
  if (!prop) return "any";

  // Handle $ref
  if (prop.$ref) {
    const ref = prop.$ref;
    const prefix = "#/definitions/";
    if (ref.startsWith(prefix)) {
      const defName = ref.slice(prefix.length);
      const def = schema.definitions?.[defName];
      if (def) {
        // Check for known entity types
        const entityType = definitionToTsType(defName);
        if (entityType) return entityType;

        // Enum
        if (def.enum && def.enum.length > 0 && !def.properties) {
          return def.enum.map((v) => JSON.stringify(v)).join(" | ");
        }

        // Primitive type
        if (def.type && !def.properties) {
          return jsonTypeToTs(primaryType(def.type));
        }

        // Object with properties
        if (def.properties) return "Record<string, any>";
      }
    }
    return "any";
  }

  // Inline enum
  if (prop.enum && prop.enum.length > 0) {
    return prop.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  // Handle oneOf/anyOf
  if (prop.oneOf || prop.anyOf) {
    const variants = prop.oneOf ?? prop.anyOf ?? [];
    const types = new Set<string>();
    for (const v of variants) {
      types.add(resolvePropertyType(v, schema));
    }
    // Simplify if all variants resolve to the same type
    const uniqueTypes = [...types].filter((t) => t !== "any");
    if (uniqueTypes.length === 0) return "any";
    if (uniqueTypes.length === 1) return uniqueTypes[0];
    return uniqueTypes.join(" | ");
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
    case "array":
      if (prop.items) {
        const itemType = resolvePropertyType(prop.items, schema);
        return `${itemType}[]`;
      }
      return "any[]";
    case "object":
      return "Record<string, any>";
    default:
      return "any";
  }
}

/**
 * Map well-known definition names to their TypeScript entity types.
 */
function definitionToTsType(defName: string): string | null {
  const map: Record<string, string> = {
    image: "Image",
    services: "Service[]",
    artifacts: "Artifacts",
    cache: "Cache | Cache[]",
    cache_item: "Cache",
    rules: "Rule[]",
    retry: "Retry | number",
    allow_failure: "AllowFailure | boolean",
    parallel: "Parallel | number",
    include_item: "Include",
    before_script: "string | string[]",
    after_script: "string | string[]",
    script: "string | string[]",
    optional_script: "string | string[]",
    globalVariables: "Record<string, any>",
    jobVariables: "Record<string, any>",
    rulesVariables: "Record<string, any>",
    when: '"on_success" | "on_failure" | "always" | "never" | "manual" | "delayed"',
    workflowAutoCancel: "AutoCancel",
    id_tokens: "Record<string, any>",
    secrets: "Record<string, any>",
    timeout: "string",
    start_in: "string",
  };
  return map[defName] ?? null;
}

function jsonTypeToTs(type: string): string {
  switch (type) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "array": return "any[]";
    case "object": return "Record<string, any>";
    default: return "any";
  }
}

/**
 * Extract nested property types and enums from a definition.
 * For now, we keep this minimal — the main types are extracted as
 * top-level entities via PROPERTY_ENTITIES.
 */
function extractNestedTypes(
  _def: CISchemaDefinition,
  _shortName: string,
  _schema: CISchema,
): { propertyTypes: ParsedPropertyType[]; enums: ParsedEnum[] } {
  // GitLab CI entities don't have deeply nested property types like CFN.
  // The main nested types (Artifacts, Cache, etc.) are extracted as
  // top-level property entities instead.
  return { propertyTypes: [], enums: [] };
}

/**
 * Extract short name: "GitLab::CI::Job" → "Job"
 */
export function gitlabShortName(typeName: string): string {
  const parts = typeName.split("::");
  return parts[parts.length - 1];
}

/**
 * Extract service name: "GitLab::CI::Job" → "CI"
 */
export function gitlabServiceName(typeName: string): string {
  const parts = typeName.split("::");
  return parts.length >= 2 ? parts[1] : "CI";
}
