/**
 * Shared utility for extracting ARM template resource references
 * from template properties.
 *
 * Used by AZR010 (redundant DependsOn) and other post-synth checks.
 *
 * ARM templates use bracket expressions like [resourceId(...)],
 * [reference(...)], and [concat(...)] to reference other resources.
 */

/**
 * Parsed ARM template structure.
 */
export interface ArmTemplate {
  $schema?: string;
  contentVersion?: string;
  parameters?: Record<string, unknown>;
  resources?: ArmResource[];
  outputs?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ArmResource {
  type: string;
  apiVersion: string;
  name: string | unknown;
  location?: unknown;
  properties?: Record<string, unknown>;
  dependsOn?: string[];
  tags?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Parse a serialized ARM template from build output.
 * Accepts either a raw string or a SerializerResult (extracts primary).
 */
export function parseArmTemplate(output: string | { primary: string }): ArmTemplate | null {
  const raw = typeof output === "string" ? output : output.primary;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as ArmTemplate;
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

/**
 * Extract resource names referenced via bracket expressions in a value.
 *
 * Parses ARM bracket expressions like:
 * - [resourceId('Microsoft.Storage/storageAccounts', 'myStorage')]
 * - [reference('myStorage')]
 * - [reference('myStorage').primaryEndpoints.blob]
 *
 * Object keys are read as well as values.
 *
 * Returns the set of resource names found in these references.
 */
export function findArmResourceRefs(value: unknown): Set<string> {
  const refs = new Set<string>();
  walkArmValue(value, refs);
  return refs;
}

/**
 * Check if a string value is an ARM bracket expression.
 */
export function isBracketExpression(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("[") && value.endsWith("]");
}

/**
 * Extract resource names from an ARM bracket expression string.
 *
 * Handles:
 * - [resourceId('Type', 'name')]  -> extracts 'name'
 * - [resourceId('Type', 'a', 'b')] -> extracts 'a/b'
 * - [reference('name')]           -> extracts 'name'
 * - [reference('name').prop]      -> extracts 'name'
 */
export function extractRefsFromExpression(expr: string): string[] {
  const refs: string[] = [];

  // Match resourceId('Type', 'name', ...): the name is every quoted argument
  // after the type, joined with "/" for a child resource ('vnet', 'subnet').
  const resourceIdPattern = /resourceId\s*\(\s*'[^']+'((?:\s*,\s*'[^']+')+)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = resourceIdPattern.exec(expr)) !== null) {
    refs.push([...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).join("/"));
  }

  // Match reference('name') — extract the name
  const referencePattern = /reference\s*\(\s*'([^']+)'\s*\)/g;
  while ((match = referencePattern.exec(expr)) !== null) {
    refs.push(match[1]);
  }

  return refs;
}

function walkArmValue(value: unknown, refs: Set<string>): void {
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    if (isBracketExpression(value)) {
      for (const ref of extractRefsFromExpression(value)) {
        refs.add(ref);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkArmValue(item, refs);
    }
    return;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      // A key can be an expression too: a user-assigned identity is named by
      // its resource ID as the key of identity.userAssignedIdentities.
      walkArmValue(key, refs);
      walkArmValue(val, refs);
    }
  }
}
