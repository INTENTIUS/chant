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
 * ## One reader, several sources (#1269)
 *
 * Cloud Control is the default source, not the only one. It has the property
 * this reader wants most — it returns the *CloudFormation resource model*, so
 * its payload lines up with the declared side without translation — but its
 * coverage is not the same as the provider's. A security group read through
 * Cloud Control comes back as identity and a description; read through
 * `ec2 describe-security-groups` it comes back with every ingress and egress
 * rule, which is the property people actually edit out of band.
 *
 * So each type names its source in {@link DEEP_SOURCES}, and a source that is
 * not Cloud Control supplies a `toModel` that maps the provider's shape onto
 * the CloudFormation one. Translation is the price of the richer read, and it
 * belongs next to the type it translates rather than inside the diff.
 *
 * A declared resource of a type with no source reports NOT-OBSERVED with
 * `unsupported-kind` — it may well exist, and saying nothing about it is the
 * only honest answer.
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
import { applyAwsEndpointArgv } from "./components/cloud-executor";
import { toIngressRules } from "./dependencies";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Where each type's live model comes from.
 *
 * `cloud-control` is addressed by the physical id `describe-stack-resources`
 * already reports, and needs no translation. An `ec2` source names a bulk
 * describe — one call for every id of that type, not one per resource — plus
 * the mapping from the EC2 shape onto the CloudFormation model the declared
 * side is written in.
 */
export type DeepSource =
  | { via: "cloud-control" }
  | {
      via: "ec2";
      /** Bulk describe argv, minus the ids and the region. */
      argv: string[];
      /** Flag the physical ids are passed under. */
      idFlag: string;
      /** Top-level key of the result array. */
      key: string;
      /** Field on each row carrying the physical id, for the join back. */
      id: string;
      /** EC2 row -> CloudFormation resource model. */
      toModel: (row: Record<string, unknown>) => Record<string, unknown>;
    };

export const DEEP_SOURCES: Record<string, DeepSource> = {
  "AWS::S3::Bucket": { via: "cloud-control" },
  "AWS::IAM::Role": { via: "cloud-control" },
  "AWS::IAM::ManagedPolicy": { via: "cloud-control" },
  // Cloud Control returns a security group's identity and description and none
  // of its rules (#1269). The EC2 API returns the whole thing, so the drift
  // people care about — an ingress rule edited in the console — is legible.
  "AWS::EC2::SecurityGroup": {
    via: "ec2",
    argv: ["ec2", "describe-security-groups"],
    idFlag: "--group-ids",
    key: "SecurityGroups",
    id: "GroupId",
    toModel: securityGroupToModel,
  },
};

/**
 * Types this reader can read live. Derived from {@link DEEP_SOURCES} so the two
 * cannot drift apart — the shape of bug #1280 is about.
 */
export const DEEP_READABLE_TYPES: ReadonlySet<string> = new Set(Object.keys(DEEP_SOURCES));

/**
 * `describe-security-groups` -> the `AWS::EC2::SecurityGroup` resource model.
 *
 * The two surfaces disagree about names and about nesting. EC2 says
 * `Description` where the template says `GroupDescription`, and nests rule
 * sources under `IpRanges[]` / `Ipv6Ranges[]` / `UserIdGroupPairs[]` where the
 * template writes one flat rule per source. `toIngressRules` already resolves
 * the nesting for the topology fold (#1273); this reuses it so there is one
 * translation of that shape in the lexicon, not two.
 *
 * Rules are matched by their whole canonical value (the `orderKey` hook below),
 * so a field the template carries and this mapping drops is not a smaller diff —
 * it is every rule reported twice, once absent and once undeclared. That is why
 * a range's own `Description` is carried through.
 */
export function securityGroupToModel(row: Record<string, unknown>): Record<string, unknown> {
  const ingress = toIngressRules((row.IpPermissions ?? []) as never);
  const egress = toIngressRules((row.IpPermissionsEgress ?? []) as never);
  return {
    ...(typeof row.Description === "string" ? { GroupDescription: row.Description } : {}),
    ...(typeof row.GroupName === "string" ? { GroupName: row.GroupName } : {}),
    ...(typeof row.VpcId === "string" ? { VpcId: row.VpcId } : {}),
    ...(typeof row.GroupId === "string" ? { GroupId: row.GroupId } : {}),
    // An empty tag set is the absence of tags, not a value. EC2 always sends
    // the key, so carrying it through reports `Tags: <undeclared> -> []` on
    // every untagged group — agreement rendered as drift.
    ...(Array.isArray(row.Tags) && row.Tags.length > 0 ? { Tags: row.Tags } : {}),
    ...(ingress.length > 0 ? { SecurityGroupIngress: ingress } : {}),
    ...(egress.length > 0 ? { SecurityGroupEgress: egress } : {}),
  };
}

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
    // EC2 gives every group an allow-all egress rule when the template declares
    // none (#1269). Patterns are index-erased, so these two match the default
    // rule wherever it lands in the set — and only while source declares no
    // egress at all, which is what `counterpart: "absent"` checks.
    "SecurityGroupEgress[].CidrIp": "0.0.0.0/0",
    "SecurityGroupEgress[].IpProtocol": "-1",
  },
};

/**
 * Names the service mints when a template does not supply one (#1269).
 *
 * Unlike {@link AWS_SERVICE_DEFAULTS} there is no fixed value to compare: a
 * CloudFormation-generated security-group name is a different random string on
 * every deploy. Pruned on the live side only, and only where source is silent —
 * a template that names the group keeps the property in the diff, so a later
 * rename still reports.
 */
export const AWS_GENERATED_NAMES: Record<string, ReadonlySet<string>> = {
  "AWS::EC2::SecurityGroup": new Set(["GroupName"]),
};

/** Stable JSON with sorted keys — the fallback ordering key for a set-like array. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  ) ?? "";
}

/**
 * The read-only properties of one type, as index-erased patterns, straight from
 * the CloudFormation schema's `readOnlyProperties` (#1641).
 *
 * The codegen already turns that list into each class's GetAtt attributes
 * (`attrs` in `lexicon-aws.json`), so this reads the same registry from the
 * other side: a path the schema says only the service can write is an
 * attribute, and an attribute the live read reports is not property drift. No
 * declaration can contain one, so `<undeclared> -> value` is the shape every
 * clean apply would otherwise produce. `AWS::IAM::ManagedPolicy.PolicyArn`,
 * which is also the type's Cloud Control primary identifier, is the case that
 * surfaced it.
 *
 * The manifest spells an array element `Subscribers.*.Status`; the
 * normalization pass spells the same thing `Subscribers[].Status`.
 *
 * Complements {@link AWS_READ_ONLY_NAMES} rather than replacing it: the
 * name-based list also covers translated models (an EC2 row mapped onto the
 * CloudFormation shape) and nested documents the schema never enumerates.
 */
export function schemaReadOnlyPatterns(entityType: string): ReadonlySet<string> {
  const cached = readOnlyByType.get(entityType);
  if (cached) return cached;
  const entry = manifestByType().get(entityType);
  const patterns = new Set<string>();
  for (const attr of Object.values(entry?.attrs ?? {})) {
    patterns.add(attr.replace(/\.\*(?=\.|$)/g, "[]"));
  }
  readOnlyByType.set(entityType, patterns);
  return patterns;
}

interface ManifestEntry {
  resourceType: string;
  kind: string;
  attrs?: Record<string, string>;
}

const readOnlyByType = new Map<string, ReadonlySet<string>>();
let manifestIndex: Map<string, ManifestEntry> | undefined;
function manifestByType(): Map<string, ManifestEntry> {
  if (!manifestIndex) {
    const manifest = require("./generated/lexicon-aws.json") as Record<string, ManifestEntry>;
    manifestIndex = new Map(
      Object.values(manifest)
        .filter((e) => e.kind === "resource")
        .map((e) => [e.resourceType, e]),
    );
  }
  return manifestIndex;
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
    // meaningless. The schema's own `readOnlyProperties` first (#1641), then
    // the name-based list for what the schema does not enumerate.
    if (schemaReadOnlyPatterns(node.entityType).has(node.pattern)) return true;
    if (AWS_READ_ONLY_NAMES.has(lastSegment(node.pattern))) return true;

    // Provider defaults, on the live side only, and only where source is silent
    // about the property. `"unknown"` (a one-sided normalization) never prunes:
    // the reader must not decide this before the declared tree is in hand.
    if (node.side !== "live" || node.counterpart !== "absent") return false;

    // chant's own ownership marker. The serializer stamps it onto the template,
    // so it is live on every managed resource and absent from the declared
    // *properties* the diff compares — chant reading its own signature back as
    // drift. Counterpart-gated, so a template that declares the tag itself is
    // still compared against what is live.
    if (isOwnershipTag(node.value)) return true;

    // A name the service generated because source did not supply one.
    if (AWS_GENERATED_NAMES[node.entityType]?.has(node.pattern)) return true;

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
    if (name === "SecurityGroupIngress" || name === "SecurityGroupEgress") {
      return securityGroupRuleKey(el) ?? canonicalJson(el);
    }
    if (name === "IpRanges") {
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

/**
 * What identifies a security-group rule, as a path segment.
 *
 * `canonicalJson` of a rule runs past the length a path segment may carry
 * (`MAX_KEYED_SEGMENT`, 60), so keying by it makes the flattener give up and
 * compare the set positionally. A rule added at the top then shifts every rule
 * below it, and one added rule reports as "the first rule changed, and a new
 * one appeared at the end" — detection is right, attribution is not.
 *
 * Identity is protocol, port range and source, which is what EC2 itself
 * enforces uniqueness on. `Description` is deliberately excluded: editing a
 * rule's description is a change *to that rule*, not the removal of one rule
 * and the addition of another.
 */
function securityGroupRuleKey(element: unknown): string | undefined {
  if (!isRecord(element)) return undefined;
  const source =
    typeof element.CidrIp === "string"
      ? element.CidrIp
      : typeof element.CidrIpv6 === "string"
        ? element.CidrIpv6
        : typeof element.SourceSecurityGroupId === "string"
          ? element.SourceSecurityGroupId
          : undefined;
  // No recognisable source is not a rule this can identify; the caller falls
  // back rather than keying every such rule to the same segment.
  if (source === undefined) return undefined;
  const protocol = typeof element.IpProtocol === "string" ? element.IpProtocol : "-1";
  const from = element.FromPort ?? "*";
  const to = element.ToPort ?? "*";
  return `${protocol}:${String(from)}:${String(to)}:${source}`;
}

/** Every tag key the serializer stamps as chant's ownership marker. */
const OWNERSHIP_TAG_KEYS: ReadonlySet<string> = new Set(Object.values(AWS_TAG_OWNERSHIP_KEYS));

/** True when `value` is a `{Key, Value}` tag whose key is one chant stamps itself. */
function isOwnershipTag(value: unknown): boolean {
  return isRecord(value) && typeof value.Key === "string" && OWNERSHIP_TAG_KEYS.has(value.Key);
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

  // Types with a bulk source are read once for the whole stack, before the
  // per-entity pass — one `describe-security-groups` for every group, not one
  // call per group.
  const bulk = await readBulkSources(
    options.entityNames.flatMap((name) => {
      const r = byLogicalId.get(name);
      return r?.physicalId ? [{ type: r.type, id: r.physicalId }] : [];
    }),
    options.region,
  );

  await boundedConcurrently(options.entityNames, async (entityName) => {
    const stackResource = byLogicalId.get(entityName);
    // Not in the stack at all. The thin read reports that absence; restating it
    // here as a property hole would turn one finding into two.
    if (!stackResource) return;

    const type = stackResource.type;
    const source = DEEP_SOURCES[type];
    if (!source) {
      unobserved[entityName] = {
        type,
        reason: "unsupported-kind",
        detail: `no deep reader for ${type} — coverage is opt-in per type`,
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

    let properties: Record<string, unknown>;
    if (source.via === "ec2") {
      const answer = bulk.get(type);
      if (!answer) {
        unobserved[entityName] = {
          type,
          reason: "read-failed",
          detail: `${source.argv.join(" ")} failed, so ${type} could not be read deeply`,
        };
        return;
      }
      const row = answer.get(identifier);
      // The describe answered, and this id was not in it. That is absence, and
      // the thin read already reports it — same reasoning as a resource missing
      // from the stack.
      if (!row) return;
      properties = source.toModel(row);
    } else {
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
      properties = parsed.properties;
    }

    // Both sources return tags where the service carries them, so unlike the
    // thin path this one can answer the ownership question (#1015's open note).
    // A resource withheld by the filter is `filtered`, never absent: it exists,
    // it just isn't chant's.
    const owned = hasOwnershipMarker(properties);
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
      properties: normalizeDeepProperties(properties, {
        entityType: type,
        side: "live",
        hooks: awsDeepNormalizationHooks,
      }),
    };
  });

  return deepObservation(resources, unobserved);
}

/**
 * Read every `ec2`-sourced type in bulk, keyed by physical id.
 *
 * A type whose describe fails is absent from the returned map, which the caller
 * turns into a hole for each of its resources — never into an absence, because
 * a failed read establishes nothing about what exists.
 *
 * These reads still shell the CLI, unlike the Cloud Control path (#1206). The
 * EC2 API speaks the Query protocol with its own lowerCamelCase XML, so going
 * native here is a second wire format rather than a reuse of the existing
 * client, and it belongs with the port of `properties.ts` / `ambient.ts` /
 * `dependencies.ts` — the modules that already read EC2 this way.
 */
async function readBulkSources(
  wanted: Array<{ type: string; id: string }>,
  region?: string,
): Promise<Map<string, Map<string, Record<string, unknown>>>> {
  const byType = new Map<string, string[]>();
  for (const { type, id } of wanted) {
    if (DEEP_SOURCES[type]?.via !== "ec2") continue;
    byType.set(type, [...(byType.get(type) ?? []), id]);
  }
  const out = new Map<string, Map<string, Record<string, unknown>>>();
  if (byType.size === 0) return out;

  const { getRuntime } = await import("@intentius/chant/runtime-adapter");
  const rt = getRuntime();
  const regionArgs = region ? ["--region", region] : [];

  for (const [type, ids] of byType) {
    const source = DEEP_SOURCES[type];
    if (source?.via !== "ec2") continue;
    try {
      const result = await rt.spawn(
        applyAwsEndpointArgv(
          ["aws", ...source.argv, source.idFlag, ...ids, ...regionArgs, "--output", "json"],
          process.env.AWS_ENDPOINT_URL,
        ),
      );
      if (result.exitCode !== 0) continue;
      const rows = (JSON.parse(result.stdout)[source.key] ?? []) as Array<Record<string, unknown>>;
      const byId = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const id = row[source.id];
        if (typeof id === "string") byId.set(id, row);
      }
      out.set(type, byId);
    } catch {
      // One type's transport failing is that type's hole, not the whole read's.
      continue;
    }
  }
  return out;
}
