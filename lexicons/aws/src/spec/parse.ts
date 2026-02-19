/**
 * CloudFormation Registry JSON Schema parser.
 *
 * Parses each CFNSchema into typed structures suitable for code generation:
 * resources with properties and attributes, property types from definitions,
 * and enum types from string enum definitions.
 */

import type { CFNSchema, SchemaProperty, SchemaDefinition } from "./fetch";
import {
  resolvePropertyType as coreResolvePropertyType,
  extractConstraints as coreExtractConstraints,
  constraintsIsEmpty as coreConstraintsIsEmpty,
  isEnumDefinition as coreIsEnumDefinition,
  type PropertyConstraints,
  type JsonSchemaDocument,
  type JsonSchemaProperty,
  type JsonSchemaDefinition,
} from "@intentius/chant/codegen/json-schema";

export type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";

export interface ParsedProperty {
  name: string;
  tsType: string;
  required: boolean;
  description?: string;
  enum?: string[];
  constraints: PropertyConstraints;
}

export interface ParsedAttribute {
  name: string;
  tsType: string;
}

export interface ParsedPropertyType {
  name: string;
  cfnType: string;
  properties: ParsedProperty[];
}

export interface ParsedEnum {
  name: string;
  values: string[];
}

export interface ParsedResource {
  typeName: string;
  properties: ParsedProperty[];
  attributes: ParsedAttribute[];
  createOnly: string[];
  writeOnly: string[];
  primaryIdentifier: string[];
}

export interface SchemaParseResult {
  resource: ParsedResource;
  propertyTypes: ParsedPropertyType[];
  enums: ParsedEnum[];
}

/**
 * Parse a CloudFormation Registry JSON Schema into typed structures.
 */
export function parseCFNSchema(data: string | Buffer): SchemaParseResult {
  const schema: CFNSchema = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));

  const requiredSet = new Set<string>(schema.required ?? []);
  const shortName = cfnShortName(schema.typeName);

  // Parse top-level properties
  const props: ParsedProperty[] = [];
  if (schema.properties) {
    for (const [name, prop] of Object.entries(schema.properties)) {
      const tsType = resolvePropertyType(prop, schema);
      props.push({
        name,
        tsType,
        required: requiredSet.has(name),
        description: prop.description,
        enum: prop.enum,
        constraints: extractConstraints(prop),
      });
    }
  }

  // Parse readOnlyProperties as attributes
  const attrs: ParsedAttribute[] = [];
  for (const path of schema.readOnlyProperties ?? []) {
    const attrName = stripPointerPath(path);
    // Skip nested paths (contain "/" after stripping prefix, or ".")
    if (attrName.includes("/") || attrName.includes(".")) continue;

    // Try to find type from properties, default to string
    let tsType = "string";
    if (schema.properties?.[attrName]) {
      tsType = resolvePropertyType(schema.properties[attrName], schema);
    }
    attrs.push({ name: attrName, tsType });
  }

  // Parse definitions into property types and enums
  const propertyTypes: ParsedPropertyType[] = [];
  const enums: ParsedEnum[] = [];

  if (schema.definitions) {
    for (const [defName, def] of Object.entries(schema.definitions)) {
      if (isEnumDefinition(def)) {
        enums.push({
          name: `${shortName}_${defName}`,
          values: def.enum!,
        });
        continue;
      }

      if (def.properties) {
        const defRequired = new Set<string>(def.required ?? []);
        const defProps: ParsedProperty[] = [];
        for (const [propName, prop] of Object.entries(def.properties)) {
          const tsType = resolvePropertyType(prop, schema);
          defProps.push({
            name: propName,
            tsType,
            required: defRequired.has(propName),
            description: prop.description,
            enum: prop.enum,
            constraints: extractConstraints(prop),
          });
        }
        propertyTypes.push({
          name: `${shortName}_${defName}`,
          cfnType: defName,
          properties: defProps,
        });
      }
    }
  }

  return {
    resource: {
      typeName: schema.typeName,
      properties: props,
      attributes: attrs,
      createOnly: stripPointerPaths(schema.createOnlyProperties ?? []),
      writeOnly: stripPointerPaths(schema.writeOnlyProperties ?? []),
      primaryIdentifier: stripPointerPaths(schema.primaryIdentifier ?? []),
    },
    propertyTypes,
    enums,
  };
}

// --- Type resolution (delegated to core) ---

function resolvePropertyType(prop: SchemaProperty | undefined, schema: CFNSchema): string {
  const shortName = cfnShortName(schema.typeName);
  return coreResolvePropertyType(
    prop as JsonSchemaProperty | undefined,
    schema as unknown as JsonSchemaDocument,
    (defName) => `${shortName}_${defName}`,
  );
}

function extractConstraints(prop: SchemaProperty): PropertyConstraints {
  return coreExtractConstraints(prop as JsonSchemaProperty);
}

export const constraintsIsEmpty = coreConstraintsIsEmpty;

function isEnumDefinition(def: SchemaDefinition): boolean {
  return coreIsEnumDefinition(def as JsonSchemaDefinition);
}

/**
 * Extract short resource name: "AWS::S3::Bucket" → "Bucket"
 */
export function cfnShortName(typeName: string): string {
  const parts = typeName.split("::");
  return parts.length >= 3 ? parts[2] : typeName;
}

/**
 * Extract service name: "AWS::S3::Bucket" → "S3"
 */
export function cfnServiceName(typeName: string): string {
  const parts = typeName.split("::");
  return parts.length >= 2 ? parts[1] : typeName;
}

/**
 * Strip JSON pointer path prefix: "/properties/BucketName" → "BucketName"
 */
function stripPointerPath(path: string): string {
  const prefix = "/properties/";
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function stripPointerPaths(paths: string[]): string[] {
  if (paths.length === 0) return [];
  return paths.map(stripPointerPath);
}
