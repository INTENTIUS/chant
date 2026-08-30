/**
 * CloudFormation-type → native-spec tier for the CDK carve advisor (#1056).
 *
 * The Terraform path's hardest layer — translating `aws_s3_bucket` into
 * `AWS::S3::Bucket` and a tier — does not exist here: a synthesized template is
 * already in CloudFormation type space, which is the space
 * `AWS_CARVE_TYPES.nativeType` is written in. So this is the same table read
 * from the other end, not a second table to keep in step. Adding an AWS type to
 * the carve-out table lights it up for both advisors at once.
 *
 * `mapsTo` is the CloudFormation type itself, because that identity is the
 * point: chant's AWS lexicon constructors take CloudFormation PascalCase props,
 * so a CDK resource needs no translation to become one.
 */

import { AWS_CARVE_TYPES } from "../terraform/aws-resources";
import type { TierInfo } from "../terraform/tier-map";

/**
 * CloudFormation type → tier. Two Terraform types can name one CloudFormation
 * type (`aws_lb` and `aws_alb` are the same load balancer); the first entry
 * wins, and since aliases share a tier by construction there is nothing to
 * reconcile.
 */
export const CFN_TIER_MAP: Record<string, TierInfo> = (() => {
  const map: Record<string, TierInfo> = {};
  for (const entry of AWS_CARVE_TYPES) {
    if (map[entry.nativeType]) continue;
    map[entry.nativeType] = { tier: entry.tier, mapsTo: entry.nativeType };
  }
  return map;
})();

/** The chant AWS lexicon constructor a CloudFormation type would carve into. */
export const CFN_CTOR: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const entry of AWS_CARVE_TYPES) map[entry.nativeType] ??= entry.ctor;
  return map;
})();

export function resolveCfnTier(cfnType: string): TierInfo | null {
  return CFN_TIER_MAP[cfnType] ?? null;
}

/**
 * A nested stack is an assembly of its own: its resources live in a separate
 * template that this advisor does not descend into, so carving the
 * `AWS::CloudFormation::Stack` resource means carving everything under it.
 */
export const NESTED_STACK_TYPE = "AWS::CloudFormation::Stack";

/**
 * CloudFormation resources CDK synthesizes for its own bookkeeping. They
 * describe the synthesis, not the infrastructure, so they never appear in the
 * ranking.
 */
export const SCAFFOLDING_TYPES = new Set(["AWS::CDK::Metadata"]);

/**
 * Template parameters CDK adds for bootstrap and asset plumbing. A reference to
 * one is not a sign the resource is parameterized by its author — it is the
 * synthesizer talking to itself — so these do not mark a construct dynamic.
 */
export function isScaffoldingParameter(name: string): boolean {
  return (
    name === "BootstrapVersion" ||
    name === "CdkBootstrapVersion" ||
    name.startsWith("AssetParameters") ||
    name.startsWith("BootstrapVersion")
  );
}
