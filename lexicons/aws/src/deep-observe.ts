/**
 * AWS deep observation (#1015) — the reference implementation of the epic's
 * deep-observe contract (#1014).
 *
 * `describeResources` reads `cloudformation describe-stack-resources`, which
 * returns a status, a physical id and a timestamp per resource. That is
 * CloudFormation's view of the world, and CloudFormation only compares
 * properties it was told about. A property somebody edited in the console — an
 * inline policy, a bucket setting, a security-group rule — is invisible to it.
 * That gap is why go-to-k/cdk-real-drift exists, and it is what this reader
 * closes: the live resource model comes from the **Cloud Control API**, which
 * bypasses CloudFormation entirely and returns the resource as the service
 * actually holds it.
 *
 * Correlation is unchanged: Cloud Control is addressed by the physical id that
 * `describe-stack-resources` already reports per logical id, so the results
 * line up with the same IR node ids `live-attrs.ts` relies on.
 *
 * ## Scope of the first cut
 *
 * Four high-signal types (S3 buckets, IAM roles and managed policies, EC2
 * security groups) rather than all 30+. The point of the first row is to prove
 * the contract and the noise rules; widening the type table is additive and
 * needs no contract change. A declared resource of any other type reports
 * NOT-OBSERVED with `unsupported-kind` — it may well exist, and saying nothing
 * about it is the only honest answer.
 *
 * ## Nothing here talks to real AWS on its own terms
 *
 * Every call goes through `./api/read-client.ts` — the applier's own transport,
 * pointed at the read APIs (#1206) — so `AWS_ENDPOINT_URL` redirects the whole
 * reader at a local emulator, with no CLI to spawn and typed failures instead of
 * parsed stderr.
 */

import type {
  DeepArrayElement,
  DeepNode,
  DeepNormalizationHooks,
  DeepObservationResult,
  DeepResourceObservation,
  UnobservedEntity,
  UnobservedReason,
} from "@intentius/chant/lexicon";
import {
  AwsReadError,
  describeStackResources,
  getResource,
  type AwsReadClientOptions,
  type AwsReadHttp,
} from "./api/read-client";
import { AWS_TAG_OWNERSHIP_KEYS } from "./ownership";

/**
 * CloudFormation types this reader can read live. Each is addressable in Cloud
 * Control by the physical id CloudFormation already reports.
 */
export const DEEP_READABLE_TYPES: ReadonlySet<string> = new Set([
  "AWS::S3::Bucket",
  "AWS::IAM::Role",
  "AWS::IAM::ManagedPolicy",
  "AWS::EC2::SecurityGroup",
]);

/**
 * Property names that are server-populated wherever they appear — identifiers
 * the service mints, timestamps it stamps, counters it maintains. Matched on
 * the final path segment, because AWS repeats these names at every nesting
 * depth and a per-type list of full paths would be a maintenance trap.
 *
 * Deliberately excludes ambiguous names like `Id` and `Name`: `VpcId` and
 * `BucketName` are declared inputs, and pruning a declared input is how a
 * normalization pass starts hiding real drift.
 */
export const AWS_READ_ONLY_NAMES: ReadonlySet<string> = new Set([
  "Arn",
  "RoleId",
  "PolicyId",
  "GroupId",
  "OwnerId",
  "AttachmentCount",
  "PermissionsBoundaryUsageCount",
  "DefaultVersionId",
  "IsAttachable",
  "CreateDate",
  "CreationDate",
  "UpdateDate",
  "LastModified",
  "LastModifiedTime",
  "DualStackDomainName",
  "RegionalDomainName",
  "WebsiteURL",
]);

/**
 * Service defaults, per type, as index-erased property paths. A live value
 * equal to its default is subtracted **only when source never declared that
 * property** — cdk-real-drift's default subtraction, and the reason
 * {@link DeepNode.counterpart} exists. Declaring the default explicitly keeps
 * the property in the diff, so a later change to it still reports.
 */
export const AWS_SERVICE_DEFAULTS: Record<string, Record<string, unknown>> = {
  "AWS::S3::Bucket": {
    "VersioningConfiguration.Status": "Suspended",
    "AccelerateConfiguration.AccelerationStatus": "Suspended",
    "ObjectLockEnabled": false,
  },
  "AWS::IAM::Role": {
    "Path": "/",
    "MaxSessionDuration": 3600,
  },
  "AWS::IAM::ManagedPolicy": {
    "Path": "/",
  },
  "AWS::EC2::SecurityGroup": {
    "GroupDescription": "default VPC security group",
  },
};

/** Stable JSON with sorted keys — the fallback ordering key for a set-like array. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  ) ?? "";
}

/** The final segment of an index-erased pattern (`Policies[].PolicyName` → `PolicyName`). */
function lastSegment(pattern: string): string {
  const withoutIndex = pattern.replace(/\[\]$/, "");
  const dot = withoutIndex.lastIndexOf(".");
  return dot === -1 ? withoutIndex : withoutIndex.slice(dot + 1);
}

/**
 * The aws lexicon's noise rules. The three classes the epic names for AWS —
 * server-populated fields, unstable ordering (tags, policy statements), and
 * provider defaults — plus nothing else: a rule that is not one of those is a
 * rule that hides drift.
 */
export const awsDeepNormalizationHooks: DeepNormalizationHooks = {
  prune(node: DeepNode): boolean {
    // Read-only / server-populated. Pruned on both sides: if source somehow
    // declares an arn-shaped output, comparing it to the live one is still
    // meaningless.
    if (AWS_READ_ONLY_NAMES.has(lastSegment(node.pattern))) return true;

    // Provider defaults, on the live side only, and only where source is silent
    // about the property. `"unknown"` (a one-sided normalization) never prunes:
    // the reader must not decide this before the declared tree is in hand.
    if (node.side !== "live" || node.counterpart !== "absent") return false;
    const defaults = AWS_SERVICE_DEFAULTS[node.entityType];
    if (!defaults) return false;
    if (!Object.prototype.hasOwnProperty.call(defaults, node.pattern)) return false;
    return defaults[node.pattern] === node.value;
  },

  /**
   * The key doubles as a path segment (`Tags[#env].Value`), so it is the
   * element's own identity where AWS gives one — a tag key, a statement Sid, an
   * action string — and canonical JSON only as a fallback.
   */
  orderKey(element: DeepArrayElement): string | undefined {
    const name = lastSegment(element.pattern);
    const el = element.element;

    // Tags are a set. AWS returns them in whatever order it likes, and a
    // reordered tag list is the single loudest false positive in a raw diff.
    if (name === "Tags") {
      const key = isRecord(el) ? el.Key : undefined;
      return typeof key === "string" ? key : canonicalJson(el);
    }

    // IAM policy statements are a set, and so are the Action/Resource lists
    // inside them. `Sid` is the natural identity when the author gave one.
    if (name === "Statement") {
      const sid = isRecord(el) ? el.Sid : undefined;
      return typeof sid === "string" ? sid : canonicalJson(el);
    }
    if (name === "Action" || name === "NotAction" || name === "Resource" || name === "NotResource") {
      return typeof el === "string" ? el : canonicalJson(el);
    }

    // Security-group rules are a set — the console appends, chant declares in
    // source order, and neither order means anything to EC2.
    if (name === "SecurityGroupIngress" || name === "SecurityGroupEgress" || name === "IpRanges") {
      return canonicalJson(el);
    }

    return undefined;
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One live resource as Cloud Control returns it. Exported for tests. */
export interface CloudControlResource {
  identifier: string;
  properties: Record<string, unknown>;
}

/**
 * Classify a failed read the same way the thin path does — off the API's own
 * error code where there is one (#1206), falling back to the message for a
 * transport-level failure that never reached the service.
 */
function classifyFailure(err: unknown): UnobservedReason {
  const code = err instanceof AwsReadError ? err.code ?? "" : "";
  const message = err instanceof Error ? err.message : String(err);
  return /credential|token|expired|AccessDenied|NotAuthorized|Unauthorized/i.test(`${code} ${message}`)
    ? "no-credentials"
    : "read-failed";
}

/** The message a failed read reports, without a stack trace or a stderr tail. */
function failureDetail(err: unknown): string {
  if (err instanceof AwsReadError) return err.code ? `${err.code}: ${err.message}` : err.message;
  return err instanceof Error ? err.message : String(err);
}

/** True when a CloudFormation read failed only because the stack isn't there yet. */
function isStackMissing(err: unknown): boolean {
  return err instanceof AwsReadError && /does not exist/i.test(err.message);
}

/** True when the live property tree carries chant's ownership marker tag. */
export function hasOwnershipMarker(properties: Record<string, unknown>): boolean {
  const tags = properties.Tags;
  if (!Array.isArray(tags)) return false;
  return tags.some((t) => isRecord(t) && t.Key === AWS_TAG_OWNERSHIP_KEYS.managedBy);
}

export interface AwsDeepObserveOptions {
  environment: string;
  entityNames: string[];
  entities?: Map<string, { entityType: string; props: Record<string, unknown> }>;
  stack?: string;
  /** Region this stack is deployed in (#1267). Same reason the thin path takes
   * one (#1261): without it a multi-region estate reads every stack against the
   * ambient region, the out-of-region ones come back empty, and a deep snapshot
   * silently records no properties for them. */
  region?: string;
  owned?: boolean;
  /** Injectable transport, mirroring `awsApply`'s `http` — tests reach the reader without a network. */
  http?: AwsReadHttp;
}

/**
 * Read the live property tree for each declared entity via Cloud Control.
 *
 * Two reads per run plus one per readable resource: `DescribeStackResources`
 * resolves logical id → (type, physical id), then `GetResource` fetches each
 * model. The first read's failure modes are the thin path's, verbatim — a stack
 * that does not exist yet is a real absence (nothing is deployed, so there are
 * no properties to drift), anything else is a hole for every declared entity.
 *
 * The per-resource reads run concurrently (#1201/#1206). They were serial when
 * each one was a process spawn, which made a deep snapshot of a large stack
 * cost N round trips end to end.
 */
export async function observeResourcesDeepAws(
  options: AwsDeepObserveOptions,
): Promise<DeepObservationResult> {
  const { deepObservation, normalizeDeepProperties } = await import("@intentius/chant/deep-observation");
  const { unobservedAll, boundedConcurrently } = await import("@intentius/chant/observation");

  const stackName = options.stack ?? options.environment;
  const client: AwsReadClientOptions = {
    ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL } : {}),
    ...(options.region ? { region: options.region } : {}),
    ...(options.http ? { http: options.http } : {}),
  };

  let stackResources: Awaited<ReturnType<typeof describeStackResources>>;
  try {
    stackResources = await describeStackResources(stackName, client);
  } catch (err) {
    if (isStackMissing(err)) return deepObservation({});
    return deepObservation(
      {},
      unobservedAll(
        options.entityNames,
        classifyFailure(err),
        `DescribeStackResources failed for stack "${stackName}": ${failureDetail(err)}`,
      ),
    );
  }

  const byLogicalId = new Map(stackResources.map((r) => [r.logicalId, r]));
  const resources: Record<string, DeepResourceObservation> = {};
  const unobserved: Record<string, UnobservedEntity> = {};

  await boundedConcurrently(options.entityNames, async (entityName) => {
    const stackResource = byLogicalId.get(entityName);
    // Not in the stack at all. The thin read reports that absence; restating it
    // here as a property hole would turn one finding into two.
    if (!stackResource) return;

    const type = stackResource.type;
    if (!DEEP_READABLE_TYPES.has(type)) {
      unobserved[entityName] = {
        type,
        reason: "unsupported-kind",
        detail: `no deep reader for ${type} — Cloud Control coverage is opt-in per type`,
      };
      return;
    }
    const identifier = stackResource.physicalId;
    if (!identifier) {
      unobserved[entityName] = {
        type,
        reason: "read-failed",
        detail: "the stack reports no physical id, so the live resource cannot be addressed",
      };
      return;
    }

    let parsed: CloudControlResource | null;
    try {
      parsed = await getResource(type, identifier, client);
    } catch (err) {
      unobserved[entityName] = {
        type,
        reason: classifyFailure(err),
        detail: `GetResource failed for ${type} "${identifier}": ${failureDetail(err)}`,
      };
      return;
    }

    if (!parsed) {
      unobserved[entityName] = {
        type,
        reason: "read-failed",
        detail: `unparseable GetResource response for ${type} "${identifier}"`,
      };
      return;
    }

    // Cloud Control returns tags where the service carries them, so unlike the
    // thin path this one can answer the ownership question (#1015's open note).
    // A resource withheld by the filter is `filtered`, never absent: it exists,
    // it just isn't chant's.
    const owned = hasOwnershipMarker(parsed.properties);
    if (options.owned && !owned) {
      unobserved[entityName] = {
        type,
        reason: "filtered",
        detail: `live resource carries no ${AWS_TAG_OWNERSHIP_KEYS.managedBy} tag`,
      };
      return;
    }

    resources[entityName] = {
      type,
      physicalId: identifier,
      properties: normalizeDeepProperties(parsed.properties, {
        entityType: type,
        side: "live",
        hooks: awsDeepNormalizationHooks,
      }),
    };
  });

  return deepObservation(resources, unobserved);
}
