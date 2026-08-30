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
import { boundPropertyTypes } from "@intentius/chant/codegen/bound-property-types";

export type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";

/**
 * Maximum nesting depth of generated property-type interfaces. Bounds the
 * shipped `.d.ts` size: property types reachable from a resource's top-level
 * properties within this depth stay typed; deeper ones are loosened to
 * `Record<string, unknown>`. Set high enough that the shapes composites consume
 * (which reach a few levels into CFN config) remain typed. (#440)
 */
const MAX_PROPERTY_TYPE_DEPTH = 3;

/**
 * Prose signals that a property description is describing a deprecation.
 * A hit is a guess, not a reading — see `ParsedResource.inferredDeprecations`.
 */
const DEPRECATION_RE =
  /\bdeprecated\b|\blegacy\b|no longer (available|recommended|used|supported)|is not recommended|has been discontinued/i;

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
  specType: string;
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
  deprecatedProperties: string[];
  /**
   * The subset of `deprecatedProperties` that no upstream declaration backs.
   * These names come from {@link DEPRECATION_RE} matching the property
   * description, so they are an inference rather than a reading. Kept apart so
   * a consumer can tell the two apart and calibrate what it says (#1701).
   */
  inferredDeprecations: string[];
  conditionalCreateOnly: string[];
  replacementStrategy?: "delete_then_create" | "create_then_delete";
  tagging?: { taggable: boolean; tagOnCreate: boolean; tagUpdatable: boolean };
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
  // Deduplicate — some upstream schemas (e.g. aws-s3files-filesystem) list the same
  // property twice in readOnlyProperties, which would produce duplicate class members.
  const attrs: ParsedAttribute[] = [];
  const seenAttrs = new Set<string>();
  for (const path of schema.readOnlyProperties ?? []) {
    const attrName = stripPointerPath(path, schema);

    // Flatten nested paths: "Endpoint/Address" → attr name "Endpoint.Address"
    const cfnAttr = attrName.replace(/\//g, ".");

    if (seenAttrs.has(cfnAttr)) continue;
    seenAttrs.add(cfnAttr);

    let tsType = "string";
    // For top-level attrs, look up type from properties
    if (!cfnAttr.includes(".") && schema.properties?.[cfnAttr]) {
      tsType = resolvePropertyType(schema.properties[cfnAttr], schema);
    }
    // For nested attrs, type is always string (CF GetAtt returns strings for leaf values)

    attrs.push({ name: cfnAttr, tsType });
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
          specType: defName,
          properties: defProps,
        });
      }
    }
  }

  // --- Deprecated properties: declared upstream, plus description-mined ---
  // The declared half is what the Registry schema states. The mined half is a
  // regex over English prose and is recorded separately (#1701): a description
  // can mention the deprecation of a sibling property, of an enum value, or of
  // something the property merely configures.
  const deprecatedSet = new Set<string>(
    stripPointerPaths(schema.deprecatedProperties ?? [], schema),
  );
  const inferredDeprecations: string[] = [];

  // Mine top-level property descriptions
  if (schema.properties) {
    for (const [name, prop] of Object.entries(schema.properties)) {
      if (!prop.description || !DEPRECATION_RE.test(prop.description)) continue;
      // A hit upstream already declares adds nothing, and is not an inference.
      if (deprecatedSet.has(name)) continue;
      deprecatedSet.add(name);
      inferredDeprecations.push(name);
    }
  }

  // --- Tagging ---
  let tagging: ParsedResource["tagging"];
  if (schema.tagging && schema.tagging.taggable) {
    tagging = {
      taggable: true,
      tagOnCreate: schema.tagging.tagOnCreate ?? false,
      tagUpdatable: schema.tagging.tagUpdatable ?? false,
    };
  }

  // --- Replacement strategy ---
  let replacementStrategy: ParsedResource["replacementStrategy"];
  if (schema.replacementStrategy === "delete_then_create" || schema.replacementStrategy === "create_then_delete") {
    replacementStrategy = schema.replacementStrategy;
  }

  // Bound the emitted property types to keep the shipped declaration small while
  // preserving the shapes composites and shallow authoring rely on (#440).
  const boundedPropertyTypes = boundPropertyTypes(
    shortName,
    props,
    propertyTypes,
    new Set(enums.map((e) => e.name)),
    { maxDepth: MAX_PROPERTY_TYPE_DEPTH },
  );

  return {
    resource: {
      typeName: schema.typeName,
      properties: props,
      attributes: attrs,
      createOnly: stripPointerPaths(schema.createOnlyProperties ?? [], schema),
      writeOnly: stripPointerPaths(schema.writeOnlyProperties ?? [], schema),
      primaryIdentifier: stripPointerPaths(schema.primaryIdentifier ?? [], schema),
      deprecatedProperties: [...deprecatedSet],
      inferredDeprecations,
      conditionalCreateOnly: stripPointerPaths(schema.conditionalCreateOnlyProperties ?? [], schema),
      ...(replacementStrategy && { replacementStrategy }),
      ...(tagging && { tagging }),
    },
    propertyTypes: boundedPropertyTypes,
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

/** Bound on the `$ref` walk that resolves a definition-scoped pointer. */
const MAX_DEFINITION_PATH_DEPTH = 6;

/** The definition a `#/definitions/Name` ref names, or undefined for anything else. */
function refDefinitionName(ref: string | undefined): string | undefined {
  const prefix = "#/definitions/";
  return ref?.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
}

function pushProperties(
  queue: Array<{ path: string[]; node: SchemaProperty }>,
  path: string[],
  properties: Record<string, SchemaProperty>,
): void {
  for (const [name, prop] of Object.entries(properties)) queue.push({ path: [...path, name], node: prop });
}

/**
 * The property path that reaches `defName`, searched breadth-first from the
 * top-level properties so the shortest one wins. Undefined when nothing
 * declared reaches the definition; the pointer is then left as the Registry
 * wrote it rather than naming a key no template has.
 */
function definitionPropertyPath(defName: string, schema: CFNSchema): string | undefined {
  const defs = schema.definitions ?? {};
  const expanded = new Set<string>();
  const queue: Array<{ path: string[]; node: SchemaProperty }> = [];
  pushProperties(queue, [], schema.properties ?? {});

  while (queue.length > 0) {
    const { path, node } = queue.shift()!;
    if (path.length > MAX_DEFINITION_PATH_DEPTH) continue;

    const ref = refDefinitionName(node.$ref);
    if (ref === defName) return path.join("/");
    if (ref !== undefined) {
      // Shortest path wins, so a definition already reached needs no second visit.
      if (expanded.has(ref)) continue;
      expanded.add(ref);
      const def = defs[ref];
      if (def?.properties) pushProperties(queue, path, def.properties);
      continue;
    }

    if (node.items) {
      queue.push({ path: [...path, "*"], node: node.items });
      continue;
    }
    if (node.properties) pushProperties(queue, path, node.properties);
  }
  return undefined;
}

/**
 * Flatten a CloudFormation Registry JSON pointer to the property path a
 * template expresses, `/`-joined.
 *
 * Three shapes occur upstream. `/properties/BucketName` is the plain one.
 * A pointer can re-enter the `properties` keyword mid-path
 * (`/properties/DistributionConfig/properties/S3Origin`), which a template
 * never writes. And a pointer can be scoped to a shared definition
 * (`/definitions/ContinuousDeploymentPolicyConfig/properties/Type`), which a
 * template expresses only through whichever property carries that definition.
 *
 * Array positions stay as `*`. `readOnlyProperties` attribute names are
 * generated from this output, so dropping the wildcard would rename them.
 */
export function stripPointerPath(path: string, schema?: CFNSchema): string {
  if (!path.startsWith("/")) return path;
  const segments = path.split("/").filter((s) => s.length > 0);

  if (segments[0] === "definitions") {
    const prefix = segments[1] && schema ? definitionPropertyPath(segments[1], schema) : undefined;
    if (prefix === undefined) return path;
    return [prefix, ...segments.slice(2).filter((s) => s !== "properties")].join("/");
  }

  if (segments[0] !== "properties") return path;
  return segments.slice(1).filter((s) => s !== "properties").join("/");
}

function stripPointerPaths(paths: string[], schema?: CFNSchema): string[] {
  if (paths.length === 0) return [];
  return paths.map((p) => stripPointerPath(p, schema));
}
