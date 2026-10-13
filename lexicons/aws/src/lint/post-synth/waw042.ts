/**
 * WAW042: S3 Bucket Missing TLS-Only Policy
 *
 * Flags S3 buckets without a companion BucketPolicy that denies requests made
 * over plaintext (a Deny statement keyed on `aws:SecureTransport` being
 * false). Encryption at rest is WAW006; the public-access block is WAW018;
 * this covers encryption in transit.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, findResourceRefs, type CFResource } from "./cf-refs";

function statementDeniesInsecureTransport(stmt: Record<string, unknown>): boolean {
  if (stmt.Effect !== "Deny") return false;

  const condition = stmt.Condition;
  if (typeof condition !== "object" || condition === null) return false;

  const cond = condition as Record<string, unknown>;
  for (const operator of ["Bool", "NumericLessThan"]) {
    const clause = cond[operator];
    if (typeof clause !== "object" || clause === null) continue;
    const value = (clause as Record<string, unknown>)["aws:SecureTransport"];
    if (value === "false" || value === false) return true;
  }
  return false;
}

/** A value as JSON with its object keys sorted, for comparing two values. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

/**
 * Logical ids of every bucket a BucketPolicy's `Bucket` property resolves to:
 * a bucket it references (`Ref`, `GetAtt`), or a bucket whose `BucketName`
 * is the same value (`Fn::Sub: "${AppName}-${AWS::Region}"` on both).
 */
function bucketPolicyTargets(resource: CFResource, resources: Record<string, CFResource>): Set<string> {
  const props = resource.Properties ?? {};
  const targets = findResourceRefs(props.Bucket);
  if (props.Bucket === undefined) return targets;
  const policyBucket = canonical(props.Bucket);
  for (const [logicalId, other] of Object.entries(resources)) {
    if (other.Type !== "AWS::S3::Bucket") continue;
    const name = other.Properties?.BucketName;
    if (name !== undefined && canonical(name) === policyBucket) targets.add(logicalId);
  }
  return targets;
}

export function checkS3TlsOnlyPolicy(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    const bucketsWithTlsPolicy = new Set<string>();

    for (const resource of Object.values(template.Resources)) {
      if (resource.Type !== "AWS::S3::BucketPolicy") continue;

      const props = resource.Properties ?? {};
      const policyDoc = props.PolicyDocument;
      if (typeof policyDoc !== "object" || policyDoc === null) continue;
      const statements = (policyDoc as Record<string, unknown>).Statement;
      if (!Array.isArray(statements)) continue;

      const hasTlsDeny = statements.some(
        (stmt) => typeof stmt === "object" && stmt !== null && statementDeniesInsecureTransport(stmt as Record<string, unknown>),
      );
      if (!hasTlsDeny) continue;

      for (const bucketId of bucketPolicyTargets(resource, template.Resources)) {
        bucketsWithTlsPolicy.add(bucketId);
      }
    }

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::S3::Bucket") continue;
      if (bucketsWithTlsPolicy.has(logicalId)) continue;

      diagnostics.push({
        checkId: "WAW042",
        severity: "error",
        message: `S3 bucket "${logicalId}" has no bucket policy denying non-TLS requests — add a Deny statement on aws:SecureTransport = false`,
        entity: logicalId,
        lexicon: "aws",
      });
    }
  }

  return diagnostics;
}

export const waw042: PostSynthCheck = {
  id: "WAW042",
  description: "S3 bucket missing a TLS-only bucket policy — deny requests over plaintext",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkS3TlsOnlyPolicy(ctx);
  },
};
