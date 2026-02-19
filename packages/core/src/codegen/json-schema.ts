/**
 * Generic JSON Schema resolution utilities for lexicon code generation.
 *
 * These functions handle the common subset of JSON Schema used by
 * infrastructure-as-code formats (CloudFormation, Terraform, Azure ARM, etc.).
 * Lexicon-specific entry points call these with a `resolveDefName` callback
 * to produce their own naming conventions.
 */

// --- Schema input interfaces ---

export interface JsonSchemaDocument {
  definitions?: Record<string, JsonSchemaDefinition>;
  [key: string]: unknown;
}

export interface JsonSchemaProperty {
  type?: string | string[];
  $ref?: string;
  items?: JsonSchemaProperty;
  oneOf?: JsonSchemaProperty[];
  anyOf?: JsonSchemaProperty[];
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  enum?: string[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
  const?: unknown;
  default?: unknown;
  description?: string;
}

export interface JsonSchemaDefinition extends JsonSchemaProperty {
  enum?: string[];
}

// --- Constraint types ---

export interface PropertyConstraints {
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
  const?: unknown;
  default?: unknown;
  enum?: string[];
}

// --- Functions ---

/**
 * Get the primary type from a type field that can be string or string[].
 * Returns first non-"null" type, or "any" if empty.
 */
export function primaryType(type: string | string[] | undefined): string {
  if (!type) return "any";
  if (typeof type === "string") return type;
  for (const t of type) {
    if (t !== "null") return t;
  }
  return type.length > 0 ? type[0] : "any";
}

/**
 * Resolve a schema property to its TypeScript type string.
 *
 * @param prop - The property to resolve
 * @param schema - The containing schema document (for $ref resolution)
 * @param resolveDefName - Callback to produce a TypeScript name from a definition.
 *   Receives (defName: string) and should return the TS type name for that definition.
 *   When null, $ref to object definitions resolves to "any".
 */
export function resolvePropertyType(
  prop: JsonSchemaProperty | undefined,
  schema: JsonSchemaDocument,
  resolveDefName: ((defName: string) => string) | null,
): string {
  if (!prop) return "any";

  // Handle oneOf/anyOf → any
  if ((prop.oneOf && prop.oneOf.length > 0) || (prop.anyOf && prop.anyOf.length > 0)) {
    return "any";
  }

  // Handle $ref
  if (prop.$ref) {
    return resolveRef(prop.$ref, schema, resolveDefName);
  }

  // Inline enum → union of string literals
  if (prop.enum && prop.enum.length > 0) {
    const sorted = [...prop.enum].sort();
    return sorted.map((v) => JSON.stringify(v)).join(" | ");
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
        const itemType = resolvePropertyType(prop.items, schema, resolveDefName);
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
 * Resolve a $ref pointer to a TypeScript type name.
 *
 * @param ref - The $ref string (e.g. "#/definitions/Foo")
 * @param schema - The containing schema document
 * @param resolveDefName - Callback to produce a TS name for object definitions.
 *   Receives (defName: string). When null, object defs resolve to "any".
 */
export function resolveRef(
  ref: string,
  schema: JsonSchemaDocument,
  resolveDefName: ((defName: string) => string) | null,
): string {
  const prefix = "#/definitions/";
  if (!ref.startsWith(prefix)) return "any";

  const defName = ref.slice(prefix.length);
  const def = schema.definitions?.[defName];
  if (!def) return "any";

  // String enum → named type (via resolveDefName) or string
  if (isEnumDefinition(def)) {
    return resolveDefName ? resolveDefName(defName) : "string";
  }

  // Object with properties → named type
  if (def.properties) {
    return resolveDefName ? resolveDefName(defName) : "any";
  }

  // Primitive type
  if (def.type) {
    const pt = primaryType(def.type);
    switch (pt) {
      case "string": return "string";
      case "integer":
      case "number": return "number";
      case "boolean": return "boolean";
      case "object": return "Record<string, any>";
    }
  }

  return "any";
}

/**
 * Extract property constraints from a schema property.
 */
export function extractConstraints(prop: JsonSchemaProperty): PropertyConstraints {
  const c: PropertyConstraints = {};
  if (prop.pattern) c.pattern = prop.pattern;
  if (prop.minLength !== undefined) c.minLength = prop.minLength;
  if (prop.maxLength !== undefined) c.maxLength = prop.maxLength;
  if (prop.minimum !== undefined) c.minimum = prop.minimum;
  if (prop.maximum !== undefined) c.maximum = prop.maximum;
  if (prop.format) c.format = prop.format;
  if (prop.const !== undefined) c.const = prop.const;
  if (prop.default !== undefined) c.default = prop.default;
  if (prop.enum && prop.enum.length > 0) c.enum = prop.enum;
  return c;
}

/**
 * Check whether a PropertyConstraints object is empty (all fields undefined/absent).
 */
export function constraintsIsEmpty(c: PropertyConstraints): boolean {
  return (
    !c.pattern &&
    c.minLength === undefined &&
    c.maxLength === undefined &&
    c.minimum === undefined &&
    c.maximum === undefined &&
    !c.format &&
    c.const === undefined &&
    c.default === undefined &&
    (!c.enum || c.enum.length === 0)
  );
}

/**
 * Check whether a schema definition is a pure string enum (no properties).
 */
export function isEnumDefinition(def: JsonSchemaDefinition): boolean {
  return (def.enum != null && def.enum.length > 0) && !def.properties;
}
