/**
 * Shared utility for extracting CloudFormation resource references
 * from template properties.
 *
 * Used by WAW010 (redundant DependsOn) and COR020 (circular deps).
 */

/**
 * Parsed CloudFormation template structure.
 */
export interface CFTemplate {
  AWSTemplateFormatVersion?: string;
  Resources?: Record<string, CFResource>;
  [key: string]: unknown;
}

export interface CFResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | string[];
  [key: string]: unknown;
}

/**
 * Parse a serialized CloudFormation template from build output.
 * Accepts either a raw string or a SerializerResult (extracts primary).
 */
export function parseCFTemplate(output: string | { primary: string }): CFTemplate | null {
  const raw = typeof output === "string" ? output : output.primary;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as CFTemplate;
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

/**
 * Recursively walk a CloudFormation property value and extract all logical IDs
 * referenced via Ref and Fn::GetAtt.
 *
 * Skips pseudo-parameters (those starting with "AWS::").
 */
export function findResourceRefs(value: unknown): Set<string> {
  const refs = new Set<string>();
  walkValue(value, refs);
  return refs;
}

function walkValue(value: unknown, refs: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) {
      walkValue(item, refs);
    }
    return;
  }

  const obj = value as Record<string, unknown>;

  // Check for Ref
  if ("Ref" in obj && typeof obj.Ref === "string") {
    if (!obj.Ref.startsWith("AWS::")) {
      refs.add(obj.Ref);
    }
  }

  // Check for Fn::GetAtt
  if ("Fn::GetAtt" in obj) {
    const getAtt = obj["Fn::GetAtt"];
    if (Array.isArray(getAtt) && getAtt.length >= 1 && typeof getAtt[0] === "string") {
      refs.add(getAtt[0]);
    } else if (typeof getAtt === "string") {
      // Dot-delimited form: "LogicalId.Attribute"
      const logicalId = getAtt.split(".")[0];
      if (logicalId) refs.add(logicalId);
    }
  }

  // Recurse into all object values (including intrinsic function arguments)
  for (const val of Object.values(obj)) {
    if (typeof val === "object" && val !== null) {
      walkValue(val, refs);
    }
  }
}
