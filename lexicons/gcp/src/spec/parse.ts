/**
 * CRD parser for GCP Config Connector resources.
 *
 * Adapts the K8s CRD parser pattern for GCP-specific concerns:
 * - Type naming: GCP::{Service}::{Kind}
 * - resourceRef detection
 * - Status field skipping
 */

import yaml from "js-yaml";
import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";

// ── Public types ────────────────────────────────────────────────────

export interface ParsedProperty {
  name: string;
  tsType: string;
  required: boolean;
  description?: string;
  enum?: string[];
  constraints: PropertyConstraints;
  isResourceRef?: boolean;
}

export interface ParsedAttribute {
  name: string;
  tsType: string;
}

export interface ParsedPropertyType {
  name: string;
  /** Original definition name in the spec (e.g., "networkRef"). */
  specType: string;
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
  attributes: ParsedAttribute[];
  deprecatedProperties: string[];
}

export interface GcpParseResult {
  resource: ParsedResource;
  propertyTypes: ParsedPropertyType[];
  enums: ParsedEnum[];
  gvk: GroupVersionKind;
}

export interface GroupVersionKind {
  group: string;
  version: string;
  kind: string;
}

// ── CRD spec types ──────────────────────────────────────────────────

interface CRDSpec {
  group: string;
  names: { kind: string; plural?: string; singular?: string };
  versions: Array<{
    name: string;
    served: boolean;
    storage: boolean;
    schema?: { openAPIV3Schema?: OpenAPISchema };
  }>;
}

interface OpenAPISchema {
  type?: string;
  description?: string;
  properties?: Record<string, OpenAPISchema>;
  required?: string[];
  items?: OpenAPISchema;
  additionalProperties?: boolean | OpenAPISchema;
  enum?: string[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  default?: unknown;
  "x-kubernetes-preserve-unknown-fields"?: boolean;
  "x-kubernetes-int-or-string"?: boolean;
}

// ── Naming helpers ──────────────────────────────────────────────────

/**
 * Extract GCP service name from a CNRM group.
 * "compute.cnrm.cloud.google.com" → "Compute"
 */
export function gcpServiceName(group: string): string {
  const firstSegment = group.split(".")[0];
  return firstSegment.charAt(0).toUpperCase() + firstSegment.slice(1);
}

/**
 * Strip the service prefix from a CRD kind.
 * "ComputeInstance", "Compute" → "Instance"
 * "IAMPolicyMember", "Iam" → "PolicyMember"
 */
export function stripServicePrefix(kind: string, service: string): string {
  // Direct match (e.g., "Compute" prefix in "ComputeInstance")
  if (kind.startsWith(service)) {
    const rest = kind.slice(service.length);
    if (rest.length > 0 && rest[0] === rest[0].toUpperCase()) {
      return rest;
    }
  }
  // Case-insensitive match (e.g., "IAM" prefix when service is "Iam")
  const kindLower = kind.toLowerCase();
  const serviceLower = service.toLowerCase();
  if (kindLower.startsWith(serviceLower)) {
    const rest = kind.slice(service.length);
    if (rest.length > 0 && rest[0] === rest[0].toUpperCase()) {
      return rest;
    }
  }
  return kind;
}

/**
 * Build full GCP type name.
 * "compute.cnrm.cloud.google.com", "ComputeInstance" → "GCP::Compute::Instance"
 */
export function gcpTypeName(group: string, kind: string): string {
  const service = gcpServiceName(group);
  const shortKind = stripServicePrefix(kind, service);
  return `GCP::${service}::${shortKind}`;
}

/**
 * Extract short name from a GCP type.
 * "GCP::Compute::Instance" → "Instance"
 */
export function gcpShortName(typeName: string): string {
  const parts = typeName.split("::");
  return parts[parts.length - 1];
}

// ── CRD Parsing ─────────────────────────────────────────────────────

/**
 * Parse a CRD YAML document string into GcpParseResult entries.
 * Supports multi-document YAML for CRD bundles.
 */
export function parseGcpCRD(content: string | Buffer): GcpParseResult[] {
  const text = typeof content === "string" ? content : content.toString("utf-8");
  const results: GcpParseResult[] = [];

  const documents = text
    .split(/^---\s*$/m)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

  for (const docStr of documents) {
    const doc = yaml.load(docStr) as Record<string, unknown>;
    if (!doc || doc.kind !== "CustomResourceDefinition") continue;

    const spec = doc.spec as CRDSpec | undefined;
    if (!spec?.group || !spec?.names?.kind || !spec?.versions) continue;

    // Only process groups that are Config Connector CRDs
    if (!spec.group.includes("cnrm.cloud.google.com")) continue;

    const crdResults = parseCRDSpec(spec);
    results.push(...crdResults);
  }

  return results;
}

/**
 * Parse a CRD spec into GcpParseResult entries.
 */
function parseCRDSpec(spec: CRDSpec): GcpParseResult[] {
  const results: GcpParseResult[] = [];

  // Find the storage version (canonical)
  const storageVersion = spec.versions.find((v) => v.storage && v.served);
  const targetVersion = storageVersion ?? spec.versions.find((v) => v.served);
  if (!targetVersion) return results;

  const typeName = gcpTypeName(spec.group, spec.names.kind);
  const gvk: GroupVersionKind = {
    group: spec.group,
    version: targetVersion.name,
    kind: spec.names.kind,
  };

  const schema = targetVersion.schema?.openAPIV3Schema;
  const specSchema = schema?.properties?.spec;
  const properties = specSchema ? extractSpecProperties(specSchema) : [];
  const propertyTypes = specSchema ? extractPropertyTypes(specSchema, typeName) : [];
  const enums = specSchema ? extractEnums(specSchema, typeName) : [];

  results.push({
    resource: {
      typeName,
      description: `Config Connector resource: ${spec.names.kind} (${spec.group})`,
      properties,
      attributes: [
        { name: "name", tsType: "string" },
        { name: "namespace", tsType: "string" },
        { name: "uid", tsType: "string" },
      ],
      deprecatedProperties: [],
    },
    propertyTypes,
    enums,
    gvk,
  });

  return results;
}

// ── Property extraction ─────────────────────────────────────────────

/**
 * Extract properties from the spec sub-object of a CRD schema.
 */
function extractSpecProperties(specSchema: OpenAPISchema): ParsedProperty[] {
  const result: ParsedProperty[] = [];
  const props = specSchema.properties ?? {};
  const requiredSet = new Set<string>(specSchema.required ?? []);

  for (const [name, prop] of Object.entries(props)) {
    const isRef = isResourceRef(prop);

    result.push({
      name,
      tsType: resolveSchemaType(prop),
      required: requiredSet.has(name),
      description: prop.description,
      enum: prop.enum,
      constraints: extractConstraints(prop),
      ...(isRef && { isResourceRef: true }),
    });
  }

  return result;
}

/**
 * Detect Config Connector resourceRef fields.
 * These typically have `name` and `external` sub-properties,
 * optionally with `namespace`, `kind`, and `apiVersion`.
 */
function isResourceRef(schema: OpenAPISchema): boolean {
  if (schema.type !== "object" || !schema.properties) return false;
  const keys = new Set(Object.keys(schema.properties));
  // Must have either `name` or `external`
  if (!keys.has("name") && !keys.has("external")) return false;
  // Must be a small object with only ref-like keys
  const refKeys = new Set(["name", "external", "namespace", "kind", "apiVersion"]);
  for (const key of keys) {
    if (!refKeys.has(key)) return false;
  }
  return keys.size >= 2;
}

/**
 * Extract nested object types as ParsedPropertyType entries.
 */
function extractPropertyTypes(specSchema: OpenAPISchema, parentTypeName: string): ParsedPropertyType[] {
  const results: ParsedPropertyType[] = [];
  const props = specSchema.properties ?? {};

  for (const [name, prop] of Object.entries(props)) {
    // Skip resourceRef fields — they are treated as references, not nested types
    if (isResourceRef(prop)) continue;

    // Inline object definitions
    if (prop.type === "object" && prop.properties) {
      const ptName = `${parentTypeName}::${pascalCase(name)}`;
      const requiredSet = new Set<string>(prop.required ?? []);

      results.push({
        name: ptName,
        specType: name,
        properties: Object.entries(prop.properties).map(([pName, pSchema]) => ({
          name: pName,
          tsType: resolveSchemaType(pSchema),
          required: requiredSet.has(pName),
          description: pSchema.description,
          enum: pSchema.enum,
          constraints: extractConstraints(pSchema),
          ...(isResourceRef(pSchema) && { isResourceRef: true }),
        })),
      });

      // Recurse into nested objects
      for (const [subName, subProp] of Object.entries(prop.properties)) {
        if (subProp.type === "object" && subProp.properties && !isResourceRef(subProp)) {
          const subPtName = `${ptName}::${pascalCase(subName)}`;
          const subRequiredSet = new Set<string>(subProp.required ?? []);

          results.push({
            name: subPtName,
            specType: subName,
            properties: Object.entries(subProp.properties).map(([spName, spSchema]) => ({
              name: spName,
              tsType: resolveSchemaType(spSchema),
              required: subRequiredSet.has(spName),
              description: spSchema.description,
              enum: spSchema.enum,
              constraints: extractConstraints(spSchema),
            })),
          });
        }
      }
    }

    // Array of objects
    if (prop.type === "array" && prop.items?.type === "object" && prop.items.properties) {
      if (isResourceRef(prop.items)) continue;

      const itemSchema = prop.items;
      const ptName = `${parentTypeName}::${pascalCase(singularize(name))}`;
      const requiredSet = new Set<string>(itemSchema.required ?? []);

      results.push({
        name: ptName,
        specType: name,
        properties: Object.entries(itemSchema.properties!).map(([pName, pSchema]) => ({
          name: pName,
          tsType: resolveSchemaType(pSchema),
          required: requiredSet.has(pName),
          description: pSchema.description,
          enum: pSchema.enum,
          constraints: extractConstraints(pSchema),
          ...(isResourceRef(pSchema) && { isResourceRef: true }),
        })),
      });
    }
  }

  return results;
}

/**
 * Extract enum types from the spec schema.
 */
function extractEnums(specSchema: OpenAPISchema, parentTypeName: string): ParsedEnum[] {
  const results: ParsedEnum[] = [];
  const props = specSchema.properties ?? {};

  for (const [name, prop] of Object.entries(props)) {
    if (prop.enum && prop.enum.length > 0) {
      results.push({
        name: `${parentTypeName}::${pascalCase(name)}`,
        values: prop.enum,
      });
    }
  }

  return results;
}

// ── Schema type resolution ──────────────────────────────────────────

function resolveSchemaType(schema: OpenAPISchema): string {
  if (!schema) return "any";

  if (schema["x-kubernetes-int-or-string"]) return "string | number";
  if (schema["x-kubernetes-preserve-unknown-fields"]) return "Record<string, any>";

  if (schema.enum && schema.enum.length > 0) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      if (schema.items) {
        const itemType = resolveSchemaType(schema.items);
        if (itemType.includes(" | ")) return `(${itemType})[]`;
        return `${itemType}[]`;
      }
      return "any[]";
    case "object":
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        const valueType = resolveSchemaType(schema.additionalProperties);
        return `Record<string, ${valueType}>`;
      }
      if (schema.properties) return "Record<string, any>"; // will be a property type
      return "Record<string, any>";
    default:
      return "any";
  }
}

function extractConstraints(schema: OpenAPISchema): PropertyConstraints {
  const constraints: PropertyConstraints = {};
  if (schema.minimum !== undefined) constraints.minimum = schema.minimum;
  if (schema.maximum !== undefined) constraints.maximum = schema.maximum;
  if (schema.minLength !== undefined) constraints.minLength = schema.minLength;
  if (schema.maxLength !== undefined) constraints.maxLength = schema.maxLength;
  if (schema.pattern !== undefined) constraints.pattern = schema.pattern;
  return constraints;
}

// ── Utilities ───────────────────────────────────────────────────────

function pascalCase(str: string): string {
  return str
    .split(/[-_.]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

function singularize(str: string): string {
  if (str.endsWith("ies")) return str.slice(0, -3) + "y";
  if (str.endsWith("ses")) return str.slice(0, -2);
  if (str.endsWith("s") && !str.endsWith("ss")) return str.slice(0, -1);
  return str;
}
