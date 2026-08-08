/**
 * Azure deep observation (#1086) — the azure row of the deep-observe contract
 * (#1014).
 *
 * `az resource show --resource-group <env> --name <name> --resource-type
 * <type> -o json` already returns the full ARM resource — the same call the
 * thin path (./describe-resources.ts) makes, which keeps `provisioningState`
 * (as `status`) plus `location`/`tags`. The depth is free; the work is
 * entirely normalization, per the issue.
 *
 * ## Why the live tree is flattened, not passed through raw
 *
 * Unlike AWS (whose declared props mirror CloudFormation's vocabulary 1:1, so
 * the Cloud Control payload normalizes and diffs as-is), chant's Azure
 * resource classes do not mirror the ARM response shape verbatim: codegen
 * (`spec/parse.ts`'s `RESOURCE_LEVEL_FIELDS` pass) flattens ARM's `properties`
 * wrapper onto the constructor's top level, so a storage account's declared
 * `minimumTlsVersion` is a sibling of `location`/`tags`, not nested under a
 * `properties` key. Passing the raw `az resource show` response through
 * unflattened would make `properties.minimumTlsVersion` a path with no
 * declared counterpart, ever — the same permanent-noise problem AWS avoids by
 * having a vocabulary match to begin with. So this reader flattens
 * `properties.*` up to the same top level chant's generated classes use,
 * alongside the resource-level fields (`name`, `location`, `sku`, `kind`,
 * `identity`, `tags`, `zones`, `plan`) ARM returns as siblings of `properties`.
 *
 * `id`, `type`, `etag` and `systemData` are the one thing that's *not*
 * flattened in — they have no declared counterpart of any kind (chant's
 * codegen skips `type`/`apiVersion` explicitly, and `id`/`etag`/`systemData`
 * are pure ARM-envelope bookkeeping), so they are simply never read into the
 * tree, the same way `type`/`physicalId` live outside `properties` on {@link
 * DeepResourceObservation} rather than inside it.
 *
 * ## Scope
 *
 * Same as the thin path: any top-level ARM type (`Microsoft.<provider>/<kind>`,
 * exactly one `/`) is readable; a nested compound type
 * (`Microsoft.Storage/storageAccounts/blobServices`) is `unsupported-kind`,
 * because `az resource show` does not accept a compound type name either.
 * Deferred, not fixed, here — same as the issue's own "worth fixing here or
 * explicitly deferring" — widening it is additive and needs no contract change.
 *
 * ## Nothing here talks to real Azure on its own terms
 *
 * ARM over the applier's own transport (`./api/read-client.ts`), exactly like
 * the thin path (#1212) — no CLI, no ARM SDK, no ambient token. The payload is
 * the same ARM JSON `az resource show` was relaying, so the normalization below
 * is untouched by the move.
 */

import { boundedConcurrently } from "@intentius/chant/observation";
import { getResource, isNotFound, type AzureReadClientOptions } from "./api/read-client";
import { LEGACY_OWNERSHIP_TAG_KEY, type AzHttp } from "./op/activities/az-apply";
import type {
  DeepArrayElement,
  DeepNode,
  DeepNormalizationHooks,
  DeepObservationResult,
  DeepResourceObservation,
  UnobservedEntity,
} from "@intentius/chant/lexicon";
import { deepObservation, normalizeDeepProperties } from "@intentius/chant/deep-observation";
import { OWNERSHIP_MANAGED_BY_VALUE } from "@intentius/chant/ownership";
import { classifyArmFailure, isTopLevelType } from "./describe-resources";
import { isBracketExpression } from "./lint/post-synth/arm-refs";
import { AZURE_TAG_OWNERSHIP_KEYS } from "./ownership";


/** The full `az resource show -o json` shape this reader reads (a superset of the thin path's `AzResourceShowResponse`). */
interface ArmResourceShowResponse {
  id?: string;
  name?: string;
  type?: string;
  location?: string;
  kind?: string;
  sku?: unknown;
  identity?: unknown;
  tags?: Record<string, string>;
  zones?: string[];
  plan?: unknown;
  etag?: string;
  systemData?: unknown;
  properties?: Record<string, unknown>;
}

/**
 * Reshape one `az resource show` response into chant's own flat declared
 * vocabulary: the resource-level fields ARM returns as siblings of
 * `properties`, plus every `properties.*` field spread onto that same top
 * level (see the module doc). `id`/`type`/`etag`/`systemData` are envelope
 * bookkeeping with no declared counterpart and are never read in at all.
 *
 * `queriedName` is the declared name the GET was addressed by. A child
 * resource is declared as `vnet/subnet` while ARM answers with the leaf
 * (`name: "subnet"`) — the same identity in two spellings, since the URL that
 * returned 200 is the declared name. The leaf is folded back to the declared
 * spelling; a name that is not the leaf of the query is kept as returned.
 */
function buildLiveProperties(obj: ArmResourceShowResponse, queriedName?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj.name !== undefined) {
    out.name =
      queriedName !== undefined && queriedName !== obj.name && queriedName.endsWith(`/${obj.name}`)
        ? queriedName
        : obj.name;
  }
  if (obj.location !== undefined) out.location = obj.location;
  if (obj.sku !== undefined) out.sku = obj.sku;
  if (obj.kind !== undefined) out.kind = obj.kind;
  if (obj.identity !== undefined) out.identity = obj.identity;
  if (obj.tags !== undefined) out.tags = obj.tags;
  if (obj.zones !== undefined) out.zones = obj.zones;
  if (obj.plan !== undefined) out.plan = obj.plan;
  if (obj.properties && typeof obj.properties === "object") {
    for (const [k, v] of Object.entries(obj.properties)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

// ── Noise rules (#1086) ──────────────────────────────────────────────────────

/**
 * Server-populated wherever they appear — matched on the final path segment,
 * the same technique AWS's `AWS_READ_ONLY_NAMES` uses, because ARM repeats
 * `provisioningState` at every resource-properties depth and a per-type list
 * of full paths would be a maintenance trap. Deliberately excludes ambiguous
 * names like `id`/`name`: a subnet's `properties.routeTable.id` is a declared
 * cross-reference, and pruning it is how a normalization pass starts hiding
 * real drift. (The resource's *own* envelope `id` is handled separately —
 * see the module doc — precisely so this list never has to touch `id` at all.)
 */
export const AZURE_READ_ONLY_NAMES: ReadonlySet<string> = new Set([
  "provisioningState",
  "resourceGuid",
  "principalId",
  "tenantId",
  // The resource's own envelope etag never reaches the tree (see the module
  // doc), but ARM also stamps one on every *nested* child — each security rule,
  // each subnet — and nobody declares those.
  "etag",
]);

/**
 * Server-injected boilerplate no chant user ever declares nor could
 * meaningfully override — Azure stamps every network security group with
 * these regardless of what was requested, so unlike `AZURE_READ_ONLY_NAMES`
 * this is dropped outright rather than compared.
 */
const AZURE_UNCONDITIONAL_PRUNE_NAMES: ReadonlySet<string> = new Set(["defaultSecurityRules"]);

/**
 * Server-computed surfaces ARM fills in on its own (#1214, the AKS row of the
 * CC round-trip): a managed cluster always comes back with `fqdn`,
 * `currentKubernetesVersion` and `nodeResourceGroup` whether or not the
 * declaration said anything about them. Unlike `AZURE_READ_ONLY_NAMES` these
 * are counterpart-gated rather than pruned outright: `nodeResourceGroup` IS
 * declarable at create time, so a declared value is still compared — only the
 * purely server-filled appearance is noise. Sparse and evidence-based, like
 * `AZURE_SERVICE_DEFAULTS`.
 */
export const AZURE_SERVER_COMPUTED_NAMES: ReadonlySet<string> = new Set([
  "currentKubernetesVersion",
  "fqdn",
  "nodeResourceGroup",
]);

/**
 * ARM service defaults, per type, as index-erased property paths. Subtracted
 * only where source never declared the property — cdk-real-drift's default
 * subtraction, same as AWS's `AWS_SERVICE_DEFAULTS`. Sparse and evidence-based
 * rather than exhaustive across 1900+ ARM types: widening this table is
 * additive and needs no contract change.
 */
export const AZURE_SERVICE_DEFAULTS: Record<string, Record<string, unknown>> = {
  "Microsoft.Storage/storageAccounts": {
    minimumTlsVersion: "TLS1_2",
  },
};

/** Arrays known to be ARM sets (server order is not authoring order), keyed by well-known ARM naming conventions. */
const AZURE_SET_ARRAY_NAMES: ReadonlySet<string> = new Set([
  "securityRules",
  "subnets",
  "ipRules",
  "virtualNetworkRules",
  "addressPrefixes",
  "dnsServers",
  "zones",
]);

/**
 * chant's own ownership marker, as tag paths (#1213 — the azure edition of
 * AWS's #1301 correction). The serializer stamps `chant-stack`/`chant-env` from
 * project config and `azApply` stamps the managed-by pair on every resource it
 * PUTs, so a managed estate always carries them live while the declared
 * *properties* the diff compares do not — chant reading its own signature back
 * as drift. Counterpart-gated at the call site, so a source that declares one
 * of these tags itself is still compared.
 */
const AZURE_OWNERSHIP_TAG_PATTERNS: ReadonlySet<string> = new Set([
  `tags.${AZURE_TAG_OWNERSHIP_KEYS.stack}`,
  `tags.${AZURE_TAG_OWNERSHIP_KEYS.env}`,
]);

/**
 * The managed-by pair is gated on the value as well: both keys always carry
 * `"chant"` when chant wrote them, so `managed-by: terraform` appearing out of
 * band still surfaces as the drift it is.
 */
const AZURE_MANAGED_BY_TAG_PATTERNS: ReadonlySet<string> = new Set([
  `tags.${AZURE_TAG_OWNERSHIP_KEYS.managedBy}`,
  `tags.${LEGACY_OWNERSHIP_TAG_KEY}`,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

/** Stable JSON with sorted keys — the fallback ordering key for a set-like array without a `name` field. */
function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_k, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v,
    ) ?? ""
  );
}

/** The final segment of an index-erased pattern (`properties.networkAcls.ipRules[]` → `ipRules`). */
function lastSegment(pattern: string): string {
  const withoutIndex = pattern.replace(/\[\]$/, "");
  const dot = withoutIndex.lastIndexOf(".");
  return dot === -1 ? withoutIndex : withoutIndex.slice(dot + 1);
}

/**
 * The azure lexicon's noise rules. Three classes, same as AWS: server-
 * populated fields (by name, unconditional), controller-injected boilerplate
 * (by name, unconditional), and ARM service defaults (gated on
 * `counterpart === "absent"`) — plus tag-map defaults, which AWS has no
 * equivalent for since its `Tags` is an array rather than a plain object (an
 * ARM tag map's key order is already canonicalized unconditionally by core,
 * since it is a plain object; only the *default empty map* needs a rule here).
 */
export const azureDeepNormalizationHooks: DeepNormalizationHooks = {
  prune(node: DeepNode): boolean {
    const name = lastSegment(node.pattern);
    if (AZURE_READ_ONLY_NAMES.has(name) || AZURE_UNCONDITIONAL_PRUNE_NAMES.has(name)) return true;

    if (node.side !== "live" || node.counterpart !== "absent") return false;

    // ARM always returns *some* tag map; an empty one when nobody declared any
    // tag at all is the default, not a finding.
    if (node.pattern === "tags" && isEmptyRecord(node.value)) return true;

    // A live `location` nobody declared is the effective placement, not drift:
    // a child resource (a subnet) has no location property of its own to
    // declare, and every top-level resource that CAN take one is declared with
    // one (or with `[resourceGroup().location]`, which is a declared
    // counterpart). Resource-level only — `pattern` is the exact top-level
    // path, so a nested `.location` inside a declared property is untouched.
    if (node.pattern === "location") return true;

    // A server-computed surface nobody declared is ARM doing its job, not
    // drift (see the set's doc for why this is counterpart-gated).
    if (AZURE_SERVER_COMPUTED_NAMES.has(name)) return true;

    // chant's own ownership marker is not drift (see the sets' docs).
    if (AZURE_OWNERSHIP_TAG_PATTERNS.has(node.pattern)) return true;
    if (AZURE_MANAGED_BY_TAG_PATTERNS.has(node.pattern) && node.value === OWNERSHIP_MANAGED_BY_VALUE) return true;

    // ARM stamps a self-`id` on every element of a nested child collection —
    // each security rule, each inline subnet. Only the element's *own* id
    // (`securityRules[].id`, directly on the element): a declared
    // cross-reference like `virtualNetworkRules[].id` has a counterpart and is
    // still compared, and object-valued references (`routeTable.id`) never
    // match the array-element shape.
    if (node.pattern.endsWith("[].id")) return true;

    const defaults = AZURE_SERVICE_DEFAULTS[node.entityType];
    if (!defaults || !Object.prototype.hasOwnProperty.call(defaults, node.pattern)) return false;
    return canonicalJson(defaults[node.pattern]) === canonicalJson(node.value);
  },

  /**
   * An ARM bracket-expression string (`"[resourceId(...)]"`) is an unevaluated
   * reference: the applier resolves it at deploy time, so the live side holds
   * the evaluated value and comparing the two is comparing a formula to its
   * result. Collapsed to UNRESOLVED on the declared side only — a live payload
   * cannot carry an unevaluated expression, and `[[`-escaped strings are ARM's
   * own literal-`[` spelling, not expressions.
   */
  unresolved(node: DeepNode): boolean {
    return (
      node.side === "declared" &&
      isBracketExpression(node.value) &&
      !(node.value as string).startsWith("[[")
    );
  },

  /**
   * The key doubles as a path segment (`securityRules[#allow-ssh]`), so a
   * `name` field is the element's own identity where ARM gives one — which it
   * does for essentially every nested rule/subnet/range collection — and
   * canonical JSON only as a fallback for primitive-valued sets
   * (`addressPrefixes`, `dnsServers`).
   */
  orderKey(element: DeepArrayElement): string | undefined {
    const name = lastSegment(element.pattern);
    if (!AZURE_SET_ARRAY_NAMES.has(name)) return undefined;
    const el = element.element;
    if (isRecord(el)) {
      const key = typeof el.name === "string" ? el.name : undefined;
      return key ?? canonicalJson(el);
    }
    return typeof el === "string" ? el : canonicalJson(el);
  },
};

// ── The reader ───────────────────────────────────────────────────────────────

export interface AzureDeepObserveOptions {
  /** Injectable transport, mirroring `azApply`'s — tests reach the reader with no network. */
  http?: AzHttp;
  environment: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
}

/**
 * Read the live property tree for each declared entity via `az resource
 * show`. One call per entity, same as the thin path — ARM has no bulk
 * "describe everything in this group" call with per-resource depth the way
 * CloudFormation's `describe-stack-resources` does, so there is no cheap
 * list-then-describe split to make here the way AWS's or temporal's readers
 * do.
 */
export async function observeResourcesDeepAzure(
  options: AzureDeepObserveOptions,
): Promise<DeepObservationResult> {
  const resources: Record<string, DeepResourceObservation> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  const readable: Array<{ entityName: string; entityType: string; name: string }> = [];

  const client: AzureReadClientOptions = {
    resourceGroup: options.environment,
    ...(process.env.AZURE_ENDPOINT_URL ? { endpoint: process.env.AZURE_ENDPOINT_URL } : {}),
    ...(process.env.AZURE_SUBSCRIPTION_ID ? { subscriptionId: process.env.AZURE_SUBSCRIPTION_ID } : {}),
    ...(options.http ? { http: options.http } : {}),
  };

  for (const [entityName, { entityType, props }] of options.entities) {
    if (!entityType.startsWith("Microsoft.")) {
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: "not an ARM resource type (expected Microsoft.<provider>/<kind>)",
      };
      continue;
    }

    if (!isTopLevelType(entityType)) {
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: "a nested ARM type needs a different read path; chant never queried this resource",
      };
      continue;
    }

    const name = props.name as string | undefined;
    if (!name) {
      unobserved[entityName] = {
        type: entityType,
        reason: "read-failed",
        detail: "declared entity has no name to query by",
      };
      continue;
    }

    readable.push({ entityName, entityType, name });
  }

  await boundedConcurrently(readable, async ({ entityName, entityType, name }) => {
    try {
      const obj = (await getResource(client, entityType, name)) as ArmResourceShowResponse;
      resources[entityName] = {
        type: entityType,
        physicalId: obj.id,
        properties: normalizeDeepProperties(buildLiveProperties(obj, name), {
          entityType,
          side: "live",
          hooks: azureDeepNormalizationHooks,
        }),
      };
    } catch (err) {
      // Not-found leaves the entity out (absence, same as the thin path).
      // Auth/binding/other failures are holes so they can't become creates.
      if (isNotFound(err)) return;
      const outcome = classifyArmFailure(err);
      unobserved[entityName] = { type: entityType, reason: outcome.reason, detail: outcome.detail };
    }
  });

  return deepObservation(resources, unobserved);
}
