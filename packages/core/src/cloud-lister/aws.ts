/**
 * behold#1029: AWS, through Cloud Control `ListResources`, one call (and its
 * pages) per type and region.
 *
 * Cloud Control lists one type at a time, so `types: "*"` lists
 * {@link DEFAULT_AWS_TYPES} and says so in a note; every other type is left
 * without a coverage entry, which reads as not observed. Regions must be
 * named: listing "every region" would need a call outside the allowlist.
 * Global types (IAM, CloudFront, Route 53, Organizations, Global Accelerator)
 * are listed once, from us-east-1, with location `global`.
 *
 * A tag filter is applied to the listed objects here, because
 * `ListResources` takes none: a filtered run costs the same calls as a full
 * one (#1029's listing-cost note).
 *
 * The pinned floci (ghcr.io/lex00/floci, source c688f52ee) serves
 * `ListResources` with no paging and answers a type it does not model with an
 * empty list rather than an error, so on floci an empty `listed` entry is
 * weaker evidence than on AWS. See behold#1029's emulator comment.
 */

import { buildResource, describeFailure, listedVerdict, noteTagFilter, withThrottleRetry, type ListerContext } from "./common";
import { resolveAwsCredentials, ListerConfigError, type AwsStaticCredentials, type CredentialChains } from "./credentials";
import { signV4 } from "./sigv4";
import { jsonBody, type TlsOptions, type WireResponse } from "./transport";
import type { CloudId } from "./types";

export interface AwsTarget {
  /** An emulator's endpoint, e.g. `http://localhost:4566`. Absent means AWS's own regional endpoint. */
  endpoint?: string;
  credentials?: AwsStaticCredentials;
  tls?: TlsOptions;
}

/** What `types: "*"` lists: common types Cloud Control lists without a parent identifier. */
export const DEFAULT_AWS_TYPES: readonly string[] = [
  "AWS::CloudFront::Distribution",
  "AWS::DynamoDB::Table",
  "AWS::EC2::Instance",
  "AWS::EC2::InternetGateway",
  "AWS::EC2::LaunchTemplate",
  "AWS::EC2::NatGateway",
  "AWS::EC2::RouteTable",
  "AWS::EC2::SecurityGroup",
  "AWS::EC2::Subnet",
  "AWS::EC2::VPC",
  "AWS::ECR::Repository",
  "AWS::ECS::Cluster",
  "AWS::EKS::Cluster",
  "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "AWS::Events::EventBus",
  "AWS::IAM::InstanceProfile",
  "AWS::IAM::ManagedPolicy",
  "AWS::IAM::Role",
  "AWS::IAM::User",
  "AWS::KMS::Key",
  "AWS::Lambda::Function",
  "AWS::Logs::LogGroup",
  "AWS::RDS::DBCluster",
  "AWS::RDS::DBInstance",
  "AWS::Route53::HostedZone",
  "AWS::S3::Bucket",
  "AWS::SNS::Topic",
  "AWS::SQS::Queue",
  "AWS::SecretsManager::Secret",
  "AWS::StepFunctions::StateMachine",
];

const GLOBAL_TYPE_PREFIXES = ["AWS::IAM::", "AWS::CloudFront::", "AWS::Route53::", "AWS::Organizations::", "AWS::GlobalAccelerator::"];

export function isGlobalAwsType(type: string): boolean {
  return GLOBAL_TYPE_PREFIXES.some((p) => type.startsWith(p));
}

const GLOBAL_SIGNING_REGION = "us-east-1";
const MAX_PAGES = 1000;

export function cloudControlUrl(target: AwsTarget, region: string): string {
  if (target.endpoint !== undefined) return new URL("/", target.endpoint).toString();
  return `https://cloudcontrolapi.${region}.amazonaws.com/`;
}

interface AwsError {
  code: string;
  message: string;
}

function awsError(res: WireResponse): AwsError {
  const body = jsonBody(res) as Record<string, unknown> | undefined;
  const raw = String(body?.__type ?? body?.code ?? res.headers["x-amzn-errortype"] ?? "");
  const code = raw.includes("#") ? raw.slice(raw.lastIndexOf("#") + 1) : raw.split(":")[0];
  const message = String(body?.message ?? body?.Message ?? "");
  return { code, message };
}

const CREDENTIAL_CODES = /^(AccessDenied|AccessDeniedException|UnrecognizedClientException|InvalidClientTokenId|ExpiredToken|ExpiredTokenException|InvalidSignatureException|SignatureDoesNotMatch|MissingAuthenticationToken)$/;

function tagsOf(props: Record<string, unknown>): Record<string, string> {
  const raw = props.Tags;
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const t of raw) {
      if (t && typeof t === "object") {
        const o = t as Record<string, unknown>;
        if (typeof o.Key === "string") out[o.Key] = String(o.Value ?? "");
      }
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v ?? "");
  }
  return out;
}

function matchesTagFilter(tags: Record<string, string>, filter: Readonly<Record<string, string>> | undefined): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => tags[k] === v);
}

export async function listAws(
  ctx: ListerContext,
  target: AwsTarget,
  chains: CredentialChains,
  retryDelays?: readonly number[],
): Promise<void> {
  const { scope } = ctx;
  if (scope.locations === "*") {
    throw new ListerConfigError("aws needs its regions named: listing every region would need ec2:DescribeRegions, which the lister does not call");
  }
  const credentials = await resolveAwsCredentials(target, chains);
  let types: readonly string[];
  if (scope.types === "*") {
    types = DEFAULT_AWS_TYPES;
    ctx.notes.push({
      code: "default-types",
      message: `Cloud Control lists one type per call, so types "*" listed ${DEFAULT_AWS_TYPES.length} default types; every other type has no coverage entry and reads as not observed. Name the types to list others.`,
    });
  } else {
    types = scope.types;
  }
  noteTagFilter(ctx, "to the listed objects, after a full ListResources per type (Cloud Control takes no tag filter)");

  for (const type of types) {
    const global = isGlobalAwsType(type);
    const regions = global ? [GLOBAL_SIGNING_REGION] : scope.locations;
    for (const region of regions) {
      const location = global ? "global" : region;
      await listOne(ctx, target, credentials, type, region, location, retryDelays);
    }
  }
}

async function listOne(
  ctx: ListerContext,
  target: AwsTarget,
  credentials: AwsStaticCredentials,
  type: string,
  region: string,
  location: string,
  retryDelays?: readonly number[],
): Promise<void> {
  const url = cloudControlUrl(target, region);
  let nextToken: string | undefined;
  const found: Parameters<typeof buildResource>[1][] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = JSON.stringify({ TypeName: type, MaxResults: 100, ...(nextToken ? { NextToken: nextToken } : {}) });
    const send = () => {
      const headers = signV4({
        method: "POST",
        url,
        headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "CloudApiService.ListResources" },
        body,
        region,
        service: "cloudcontrolapi",
        credentials,
        now: ctx.now(),
      });
      return ctx.transport.send({ substrate: "aws", method: "POST", url, headers, body });
    };
    const res = await withThrottleRetry(send, (r) => r.status === 429 || (r.status >= 400 && /Throttl/.test(awsError(r).code)), retryDelays);
    const observedAt = ctx.now().toISOString();
    if (res.status >= 400) {
      recordFailure(ctx, type, location, res);
      return;
    }
    const parsed = jsonBody(res) as { ResourceDescriptions?: Array<{ Identifier?: string; Properties?: string }>; NextToken?: string } | undefined;
    for (const d of parsed?.ResourceDescriptions ?? []) {
      if (!d.Identifier) continue;
      let props: Record<string, unknown> = {};
      try {
        const p = typeof d.Properties === "string" ? JSON.parse(d.Properties) : d.Properties;
        if (p && typeof p === "object") props = p as Record<string, unknown>;
      } catch {
        props = {};
      }
      const tags = tagsOf(props);
      if (!matchesTagFilter(tags, ctx.scope.tagFilter)) continue;
      const cloudIds: CloudId[] = [];
      if (d.Identifier.startsWith("arn:")) cloudIds.push({ kind: "arn", value: d.Identifier });
      if (typeof props.Arn === "string" && props.Arn.startsWith("arn:")) cloudIds.push({ kind: "arn", value: props.Arn });
      cloudIds.push({ kind: "import-id", value: d.Identifier });
      found.push({ listedType: type, location, nativeId: d.Identifier, cloudIds, tags, properties: props, observedAt, labels: false });
    }
    nextToken = parsed?.NextToken || undefined;
    if (!nextToken) break;
  }
  for (const r of found) ctx.resources.push(buildResource(ctx, r));
  ctx.coverage.push({ listedType: type, location, ...listedVerdict(ctx.scope) });
}

function recordFailure(ctx: ListerContext, type: string, location: string, res: WireResponse): void {
  const err = awsError(res);
  const detail = describeFailure(res, err.code, err.message);
  if (err.code === "UnsupportedActionException" || err.code === "TypeNotFoundException") {
    ctx.coverage.push({ listedType: type, location, verdict: "unsupported-kind", detail });
    ctx.notes.push({ code: "no-lister", listedType: type, location, message: `Cloud Control cannot list ${type}: ${detail}` });
  } else if (err.code === "InvalidRequestException" && /ResourceModel|parent/i.test(err.message)) {
    ctx.coverage.push({ listedType: type, location, verdict: "unsupported-kind", detail: `type needs a parent identifier: ${detail}` });
    ctx.notes.push({ code: "needs-parent", listedType: type, location, message: `${type} lists only under a parent identifier (a ResourceModel), which an account-wide listing does not have: ${detail}` });
  } else if (res.status === 401 || res.status === 403 || CREDENTIAL_CODES.test(err.code)) {
    ctx.coverage.push({ listedType: type, location, verdict: "no-credentials", detail });
    ctx.notes.push({ code: "no-credentials", listedType: type, location, message: `the credentials cannot call cloudformation:ListResources for ${type}: ${detail}` });
  } else {
    ctx.coverage.push({ listedType: type, location, verdict: "read-failed", detail });
    ctx.notes.push({ code: "read-failed", listedType: type, location, message: `ListResources for ${type} in ${location} failed: ${detail}` });
  }
}
