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

/**
 * Check if a value is a CloudFormation intrinsic function (Ref, Fn::*, etc.)
 * that cannot be statically evaluated.
 */
export function isIntrinsic(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return "Ref" in obj || Object.keys(obj).some((k) => k.startsWith("Fn::"));
}

/**
 * Walk IAM policy statements from a resource's properties.
 * Handles IAM::Policy, IAM::Role, and IAM::ManagedPolicy layouts.
 */
export function walkPolicyStatements(
  resource: CFResource,
): Array<Record<string, unknown>> {
  const statements: Array<Record<string, unknown>> = [];
  const props = resource.Properties ?? {};

  // PolicyDocument.Statement (IAM::Policy, IAM::ManagedPolicy)
  collectStatements(props.PolicyDocument, statements);

  // AssumeRolePolicyDocument.Statement (IAM::Role)
  collectStatements(props.AssumeRolePolicyDocument, statements);

  // Policies[].PolicyDocument.Statement (IAM::Role inline policies)
  if (Array.isArray(props.Policies)) {
    for (const policy of props.Policies) {
      if (typeof policy === "object" && policy !== null) {
        collectStatements((policy as Record<string, unknown>).PolicyDocument, statements);
      }
    }
  }

  return statements;
}

function collectStatements(
  policyDoc: unknown,
  out: Array<Record<string, unknown>>,
): void {
  if (typeof policyDoc !== "object" || policyDoc === null) return;
  const doc = policyDoc as Record<string, unknown>;
  if (Array.isArray(doc.Statement)) {
    for (const stmt of doc.Statement) {
      if (typeof stmt === "object" && stmt !== null) {
        out.push(stmt as Record<string, unknown>);
      }
    }
  }
}

/**
 * Normalize security group ingress rules from inline SecurityGroupIngress
 * property and standalone SecurityGroupIngress resources.
 */
export function getSecurityGroupIngress(
  resource: CFResource,
): Array<Record<string, unknown>> {
  const rules: Array<Record<string, unknown>> = [];
  const props = resource.Properties ?? {};

  if (Array.isArray(props.SecurityGroupIngress)) {
    for (const rule of props.SecurityGroupIngress) {
      if (typeof rule === "object" && rule !== null) {
        rules.push(rule as Record<string, unknown>);
      }
    }
  }

  return rules;
}

/**
 * Check if a port range [fromPort, toPort] contains any of the sensitive ports.
 */
export function portRangeContainsSensitive(
  fromPort: unknown,
  toPort: unknown,
  sensitivePorts: number[],
): boolean {
  // Missing ports means all ports
  if (fromPort === undefined && toPort === undefined) return true;

  const from = typeof fromPort === "number" ? fromPort : -1;
  const to = typeof toPort === "number" ? toPort : -1;

  // If either is an intrinsic, we can't statically verify
  if (isIntrinsic(fromPort) || isIntrinsic(toPort)) return false;

  if (from === -1 && to === -1) return true;

  for (const port of sensitivePorts) {
    if (from <= port && port <= to) return true;
  }
  return false;
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
