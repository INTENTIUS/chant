/**
 * CRD parser — converts CRD YAML into K8sParseResult entries.
 *
 * Parses the openAPIV3Schema from a CRD's versions to extract resource
 * properties, building the same K8sParseResult structures used by the
 * main K8s swagger parser. This enables CRD-based resources to integrate
 * with the full codegen pipeline.
 */

import type { K8sParseResult, ParsedProperty, ParsedPropertyType, GroupVersionKind } from "../spec/parse";
import type { CRDSpec } from "./types";
import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import { parseYAML } from "@intentius/chant/yaml";

/**
 * Normalize a CRD group to a PascalCase namespace segment.
 * "cert-manager.io" → "CertManager"
 * "monitoring.coreos.com" → "Monitoring"
 */
function normalizeGroupName(group: string): string {
  // Take the first segment before the first dot
  const firstSegment = group.split(".")[0];
  // Convert kebab-case to PascalCase
  return firstSegment
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * Parse a CRD YAML document string into K8sParseResult entries.
 * Returns one result per served version in the CRD.
 */
export function parseCRD(content: string): K8sParseResult[] {
  const results: K8sParseResult[] = [];

  // Support multi-document YAML for CRD bundles
  const documents = content
    .split(/^---\s*$/m)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

  for (const docStr of documents) {
    const doc = parseYAML(docStr) as Record<string, unknown>;
    if (!doc || doc.kind !== "CustomResourceDefinition") continue;

    const spec = doc.spec as CRDSpec | undefined;
    if (!spec?.group || !spec?.names?.kind || !spec?.versions) continue;

    const crdResults = parseCRDSpec(spec);
    results.push(...crdResults);
  }

  return results;
}

/**
 * Parse a CRD spec into K8sParseResult entries.
 * Extracts one result per served version with storage version preferred.
 */
export function parseCRDSpec(spec: CRDSpec): K8sParseResult[] {
  const results: K8sParseResult[] = [];
  const groupNs = normalizeGroupName(spec.group);

  // Find the storage version (the canonical version)
  const storageVersion = spec.versions.find((v) => v.storage && v.served);
  // Fall back to any served version
  const targetVersion = storageVersion ?? spec.versions.find((v) => v.served);

  if (!targetVersion) return results;

  const typeName = `K8s::${groupNs}::${spec.names.kind}`;
  const gvk: GroupVersionKind = {
    group: spec.group,
    version: targetVersion.name,
    kind: spec.names.kind,
  };

  const schema = targetVersion.schema?.openAPIV3Schema as OpenAPISchema | undefined;
  const properties = schema ? extractProperties(schema) : [];
  const propertyTypes = schema ? extractPropertyTypes(schema, typeName) : [];

  results.push({
    resource: {
      typeName,
      description: `Custom resource: ${spec.names.kind} (${spec.group})`,
      properties,
      attributes: [
        { name: "name", tsType: "string" },
        { name: "namespace", tsType: "string" },
        { name: "uid", tsType: "string" },
      ],
      deprecatedProperties: [],
    },
    propertyTypes,
    enums: [],
    gvk,
  });

  return results;
}

// ── OpenAPI schema types ────────────────────────────────────────────

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

// ── Property extraction ─────────────────────────────────────────────

/**
 * Extract top-level properties from a CRD's openAPIV3Schema.
 * Focuses on the "spec" sub-object and metadata, skipping status.
 */
function extractProperties(schema: OpenAPISchema): ParsedProperty[] {
  const result: ParsedProperty[] = [];
  const topProps = schema.properties ?? {};
  const topRequired = new Set<string>(schema.required ?? []);

  // Skip apiVersion, kind, status — same pattern as core parser
  const skipProps = new Set(["apiVersion", "kind", "status"]);

  for (const [name, prop] of Object.entries(topProps)) {
    if (skipProps.has(name)) continue;

    result.push({
      name,
      tsType: resolveSchemaType(prop),
      required: topRequired.has(name),
      description: prop.description,
      enum: prop.enum,
      constraints: extractConstraints(prop),
    });
  }

  return result;
}

/**
 * Extract nested object types as ParsedPropertyType entries.
 * Walks the spec's properties looking for inline object definitions.
 */
function extractPropertyTypes(schema: OpenAPISchema, parentTypeName: string): ParsedPropertyType[] {
  const results: ParsedPropertyType[] = [];
  const specSchema = schema.properties?.spec;
  if (!specSchema?.properties) return results;

  for (const [name, prop] of Object.entries(specSchema.properties)) {
    // Extract inline object definitions as property types
    if (prop.type === "object" && prop.properties) {
      const ptName = `${parentTypeName}::${pascalCase(name)}`;
      const requiredSet = new Set<string>(prop.required ?? []);

      results.push({
        name: ptName,
        defType: name,
        properties: Object.entries(prop.properties).map(([pName, pSchema]) => ({
          name: pName,
          tsType: resolveSchemaType(pSchema),
          required: requiredSet.has(pName),
          description: pSchema.description,
          enum: pSchema.enum,
          constraints: extractConstraints(pSchema),
        })),
      });
    }

    // Array of objects
    if (prop.type === "array" && prop.items?.type === "object" && prop.items.properties) {
      const itemSchema = prop.items;
      const itemProps = itemSchema.properties!;
      const ptName = `${parentTypeName}::${pascalCase(singularize(name))}`;
      const requiredSet = new Set<string>(itemSchema.required ?? []);

      results.push({
        name: ptName,
        defType: name,
        properties: Object.entries(itemProps).map(([pName, pSchema]) => ({
          name: pName,
          tsType: resolveSchemaType(pSchema),
          required: requiredSet.has(pName),
          description: pSchema.description,
          enum: pSchema.enum,
          constraints: extractConstraints(pSchema),
        })),
      });
    }
  }

  return results;
}

/**
 * Resolve an OpenAPI schema node to a TypeScript type string.
 */
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

/**
 * Extract property constraints from an OpenAPI schema node.
 */
function extractConstraints(schema: OpenAPISchema): PropertyConstraints {
  const constraints: PropertyConstraints = {};
  if (schema.minimum !== undefined) constraints.minimum = schema.minimum;
  if (schema.maximum !== undefined) constraints.maximum = schema.maximum;
  if (schema.minLength !== undefined) constraints.minLength = schema.minLength;
  if (schema.maxLength !== undefined) constraints.maxLength = schema.maxLength;
  if (schema.pattern !== undefined) constraints.pattern = schema.pattern;
  return constraints;
}

/**
 * Convert a string to PascalCase.
 */
function pascalCase(str: string): string {
  return str
    .split(/[-_.]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * Naive singularize — removes trailing "s" for property type naming.
 */
function singularize(str: string): string {
  if (str.endsWith("ies")) return str.slice(0, -3) + "y";
  if (str.endsWith("ses")) return str.slice(0, -2);
  if (str.endsWith("s") && !str.endsWith("ss")) return str.slice(0, -1);
  return str;
}
