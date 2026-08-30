/**
 * The AWS carve provider (#2016) — the seam's implementation over the AWS
 * carve-out table (`../aws-resources.ts`), which stays the single source of
 * truth for which AWS Terraform types chant can carve and how.
 *
 * chant AWS constructors take CloudFormation PascalCase properties (e.g.
 * `new Bucket({ BucketName })`), while Terraform state uses the provider's
 * snake_case attributes (`bucket`, `tags`). Attributes without a mapping are
 * preserved in a reference comment, never dropped.
 *
 * Deferred outbound inputs (#998): an attribute whose value the Terraform
 * source read from a survivor (`vpc_id = aws_vpc.main.id`) is not a fact of
 * the carved resource — it is a deploy-time input. Those props are emitted as
 * `params.<name>` references instead of frozen literals, with the state's
 * resolved value as the declared default (see `carve-emit.ts`'s scaffold).
 */

import {
  AWS_CARVE_TYPES,
  AWS_LEXICON_IMPORT,
  awsCarveType,
  applyAwsMapper,
  applyAwsFold,
  unmappedFoldAttrs,
} from "../aws-resources";
import { PARAMS_IMPORT, ParamRef, renderObject } from "../emit-source";
import type { AdoptedSource, CarveProvider, DeferredParam, FoldedContribution, TierInfo } from "../carve-provider";
import type { StateResource } from "../state";

/**
 * TF "sub-resource" types that inline into a parent resource rather than
 * standing alone (TF splits config CloudFormation keeps in one resource).
 * A sub-resource that shares its parent's name is folded into the parent's
 * carve set: it is not ranked on its own, and its edge to the parent does not
 * count as inbound boundary work — inlining it is free.
 */
const AWS_FOLDS_INTO: Record<string, string> = {
  aws_s3_bucket_versioning: "aws_s3_bucket",
  aws_s3_bucket_acl: "aws_s3_bucket",
  aws_s3_bucket_policy: "aws_s3_bucket",
  aws_s3_bucket_public_access_block: "aws_s3_bucket",
  aws_s3_bucket_server_side_encryption_configuration: "aws_s3_bucket",
  aws_s3_bucket_lifecycle_configuration: "aws_s3_bucket",
  aws_s3_bucket_website_configuration: "aws_s3_bucket",
  aws_s3_bucket_cors_configuration: "aws_s3_bucket",
  aws_s3_bucket_logging: "aws_s3_bucket",
  aws_s3_bucket_ownership_controls: "aws_s3_bucket",
  aws_s3_bucket_notification: "aws_s3_bucket",
  aws_s3_bucket_accelerate_configuration: "aws_s3_bucket",
  aws_s3_bucket_request_payment_configuration: "aws_s3_bucket",
  aws_s3_bucket_intelligent_tiering_configuration: "aws_s3_bucket",
  aws_ecr_lifecycle_policy: "aws_ecr_repository",
  aws_ecr_repository_policy: "aws_ecr_repository",
};

const AWS_TIERS: Record<string, TierInfo> = Object.fromEntries(
  AWS_CARVE_TYPES.map((t) => [t.tfType, { tier: t.tier, mapsTo: t.nativeType }]),
);

const AWS_IDENTITY_ATTRS: Record<string, string> = Object.fromEntries(
  AWS_CARVE_TYPES.filter((t) => t.identityAttr).map((t) => [t.tfType, t.identityAttr!]),
);

/**
 * Render chant source for a state-adopted resource. Emits the native
 * constructor with mapped properties, plus a reference comment listing the
 * Terraform attributes that were not mapped so nothing is silently dropped.
 *
 * A mapped attribute named by a `DeferredParam` renders as a `params.<name>`
 * reference (a real chant build parameter) instead of the state literal —
 * the value came from a survivor, so it stays overridable per build.
 *
 * `folded` carries the carve set's sub-resources (`aws_s3_bucket_versioning`
 * and friends), read from the same state file. Their mappable attributes join
 * the parent's props (#1637) — a fold that only announced itself and left the
 * emitted resource without the versioning or public-access block the Terraform
 * declared was a silent loss of configuration. A sub-resource's setting wins
 * over the parent's own legacy in-state block: it is the one the config
 * actually declares.
 */
function adoptAwsFromState(
  resource: StateResource,
  params: DeferredParam[],
  folded: StateResource[],
): AdoptedSource | null {
  const entry = awsCarveType(resource.type);
  if (!entry) return null;

  const { props, mappedKeys } = applyAwsMapper(entry, resource.attributes);

  const contributions: FoldedContribution[] = [];
  const foldedUnmapped: Record<string, Record<string, unknown>> = {};
  for (const sub of folded) {
    const address = `${sub.type}.${sub.name}`;
    const fold = applyAwsFold(sub.type, sub.attributes);
    // No fold mapping for this sub-resource type: it still carves with the
    // parent, so report its attributes rather than dropping them on the floor.
    const rest = fold ? fold.unmapped : unmappedFoldAttrs(sub.attributes);
    if (fold) Object.assign(props, fold.props);
    if (Object.keys(rest).length) foldedUnmapped[address] = rest;
    contributions.push({ address, props: Object.keys(fold?.props ?? {}) });
  }

  // Substitute deferred inputs: only plain (untransformed) field mappings can
  // carry a parameter reference — a transform ran against the literal at emit
  // time and cannot re-run at build. Everything else keeps the state literal.
  const parameterized: string[] = [];
  for (const param of params) {
    const spec = entry.fields[param.tfAttr];
    if (typeof spec !== "string" || !(spec in props)) continue;
    const type = typeof param.default === "number" ? "number" : typeof param.default === "boolean" ? "boolean" : "string";
    props[spec] = new ParamRef(param.name, type);
    parameterized.push(param.name);
  }

  const unmapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(resource.attributes)) {
    if (!mappedKeys.includes(k)) unmapped[k] = v;
  }
  // A folded sub-resource's leftovers are keyed by its address, so the comment
  // says which block a stray attribute came from.
  for (const [address, attrs] of Object.entries(foldedUnmapped)) unmapped[address] = attrs;

  const L: string[] = [];
  L.push(`// Adopted from Terraform state: ${resource.type}.${resource.name} -> ${entry.nativeType}`);
  L.push(`// Properties mapped from Terraform attributes (CloudFormation PascalCase).`);
  for (const c of contributions) {
    const into = c.props.length ? c.props.join(", ") : "nothing mappable — see the reference comment below";
    L.push(`// Folded in ${c.address} -> ${into}`);
  }
  L.push(`import { ${entry.ctor} } from "${AWS_LEXICON_IMPORT}";`);
  if (parameterized.length) {
    L.push(`// Deferred deploy-time input(s) — declared in chant.config.ts's buildParams.`);
    L.push(`import { params } from "${PARAMS_IMPORT}";`);
  }
  L.push("");
  L.push(`export const ${resource.name} = new ${entry.ctor}(${renderObject(props, 2)});`);
  if (Object.keys(unmapped).length) {
    L.push("");
    L.push("/* Unmapped Terraform attributes (reconcile to native props before building):");
    L.push(JSON.stringify(unmapped, null, 2));
    L.push("*/");
  }

  return {
    fileName: `${resource.name}.ts`,
    content: L.join("\n") + "\n",
    mapped: Object.keys(props).length > 0,
    nativeType: entry.nativeType,
    parameterized,
    folded: contributions,
  };
}

export const awsCarveProvider: CarveProvider = {
  name: "aws",
  tfTypePrefixes: ["aws_"],
  lexicon: "aws",
  tiers: AWS_TIERS,
  identityAttrs: AWS_IDENTITY_ATTRS,
  foldsInto: AWS_FOLDS_INTO,
  // Every ranked AWS type is emittable: advise and emit derive from the one
  // table, so there is no advise↔emit cliff to fall off.
  emitTypes: AWS_CARVE_TYPES.map((t) => t.tfType),
  adopt: adoptAwsFromState,
  // The live import filters a CloudFormation stack's template, so the selector
  // is the CFN type the carve table already records.
  liveSelectorType: (tfType) => awsCarveType(tfType)?.nativeType,
};
