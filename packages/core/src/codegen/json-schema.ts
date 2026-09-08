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
  allOf?: JsonSchemaProperty[];
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

/** Shared empty cycle guard, so the common call allocates nothing. */
const EMPTY_SEEN: ReadonlySet<string> = new Set<string>();

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

/** The branch list a property carries under `oneOf` or `anyOf`, or undefined. */
function branchesOf(prop: JsonSchemaProperty): JsonSchemaProperty[] | undefined {
  if (prop.oneOf && prop.oneOf.length > 0) return prop.oneOf;
  if (prop.anyOf && prop.anyOf.length > 0) return prop.anyOf;
  return undefined;
}

/** A union of string literals, sorted, from a list of enum values. */
function enumUnion(values: string[]): string {
  return [...values].sort().map((v) => JSON.stringify(v)).join(" | ");
}

/**
 * `T[]`, parenthesized when `T` is a union.
 *
 * `[]` binds tighter than `|`, so an unparenthesized `"a" | "b"[]` reads as
 * `"a" | ("b"[])`: it accepts the bare string `"a"` and rejects `["a"]`.
 */
function arrayOf(itemType: string): string {
  return itemType.includes(" | ") ? `(${itemType})[]` : `${itemType}[]`;
}

/**
 * The branch of a `oneOf`/`anyOf` that narrows a string property to an enum.
 *
 * CloudFormation writes several string properties as a `type: "string"` beside
 * a branch list whose first branch is the real enum and whose other branches
 * are case-insensitive `pattern`s for the same values (`AWS::AmazonMQ::Broker`'s
 * `EngineType`). The branch list relaxes the enum rather than summing shapes, so
 * the enum is the useful type. Only strings qualify: anything else is a real sum.
 */
function relaxedEnumBranch(
  prop: JsonSchemaProperty,
  branches: JsonSchemaProperty[],
): string[] | undefined {
  if (prop.type !== undefined && primaryType(prop.type) !== "string") return undefined;
  for (const b of branches) {
    if (!b.enum || b.enum.length === 0) continue;
    if (b.type !== undefined && primaryType(b.type) !== "string") return undefined;
    if (!b.enum.every((v) => typeof v === "string")) return undefined;
    return b.enum;
  }
  return undefined;
}

/**
 * The single content-bearing branch of an `allOf`, when that is the whole shape.
 *
 * Every `allOf` in the CloudFormation Registry is one `$ref` beside an
 * annotation object (`{ "default": "MCP" }`), which types exactly as the `$ref`
 * alone. An `allOf` that intersects two real shapes has no single answer and is
 * left to the caller.
 */
function soleTypedBranch(branches: JsonSchemaProperty[]): JsonSchemaProperty | undefined {
  const typed = branches.filter(
    (b) => b.$ref || b.type || b.properties || b.items || (b.enum && b.enum.length > 0) || branchesOf(b),
  );
  return typed.length === 1 ? typed[0] : undefined;
}

/**
 * Resolve a schema property to its TypeScript type string.
 *
 * @param prop - The property to resolve
 * @param schema - The containing schema document (for $ref resolution)
 * @param resolveDefName - Callback to produce a TypeScript name from a definition.
 *   Receives (defName: string) and should return the TS type name for that definition.
 *   When null, $ref to object definitions resolves to "any".
 * @param seen - Definition names already on the current resolution path, so a
 *   list definition that reaches itself terminates instead of recursing forever.
 */
export function resolvePropertyType(
  prop: JsonSchemaProperty | undefined,
  schema: JsonSchemaDocument,
  resolveDefName: ((defName: string) => string) | null,
  seen: ReadonlySet<string> = EMPTY_SEEN,
): string {
  if (!prop) return "any";

  // `allOf` of one real branch and some annotations types as that branch.
  if (prop.allOf && prop.allOf.length > 0 && !prop.$ref && !prop.type && !prop.enum) {
    const sole = soleTypedBranch(prop.allOf);
    if (sole) return resolvePropertyType(sole, schema, resolveDefName, seen);
  }

  const branches = branchesOf(prop);
  if (branches) {
    // A branch list beside a `type` relaxes that type; the enum branch, when
    // there is one, is the narrowest reading of it.
    const relaxed = relaxedEnumBranch(prop, branches);
    if (relaxed) return enumUnion(relaxed);
    // With nothing beside it the branch list is a sum of shapes, which this
    // emitter does not express yet (chant #2278).
    if (!prop.$ref && !prop.type && !(prop.enum && prop.enum.length > 0)) return "any";
    // Otherwise fall through and read the sibling keywords.
  }

  // Handle $ref
  if (prop.$ref) {
    return resolveRef(prop.$ref, schema, resolveDefName, seen);
  }

  // Inline enum → union of string literals
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
    case "array":
      if (prop.items) {
        return arrayOf(resolvePropertyType(prop.items, schema, resolveDefName, seen));
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
  seen: ReadonlySet<string> = EMPTY_SEEN,
): string {
  const prefix = "#/definitions/";
  if (!ref.startsWith(prefix)) return "any";

  const defName = ref.slice(prefix.length);
  const def = schema.definitions?.[defName];
  if (!def) return "any";
  // A list definition whose items reach it again would recurse without end.
  if (seen.has(defName)) return "any";

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
      // CloudFormation names its list shapes: `Tags` is a `$ref` to a `TagList`
      // definition whose items are the `Tag` definition one hop away. Resolve
      // through `items` the way the inline `array` case does. (chant #2205)
      case "array": {
        if (!def.items) return "any[]";
        const nested = new Set(seen);
        nested.add(defName);
        return arrayOf(resolvePropertyType(def.items, schema, resolveDefName, nested));
      }
    }
  }

  // An `allOf`/`oneOf`/`anyOf` definition types as its property form would.
  if (def.allOf || def.oneOf || def.anyOf) {
    const nested = new Set(seen);
    nested.add(defName);
    const viaBranches = resolvePropertyType(def, schema, resolveDefName, nested);
    if (viaBranches !== "any") return viaBranches;
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
