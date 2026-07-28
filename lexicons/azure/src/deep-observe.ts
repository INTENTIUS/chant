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
 * `node:child_process` `exec`, exactly like the thin path — no ARM SDK, no
 * ambient token. Every test replaces `child_process.exec`.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
  DeepArrayElement,
  DeepNode,
  DeepNormalizationHooks,
  DeepObservationResult,
  DeepResourceObservation,
  UnobservedEntity,
} from "@intentius/chant/lexicon";
import { deepObservation, normalizeDeepProperties } from "@intentius/chant/deep-observation";
import { classifyAzFailure, isTopLevelType } from "./describe-resources";

const execAsync = promisify(exec);

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
 */
function buildLiveProperties(obj: ArmResourceShowResponse): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj.name !== undefined) out.name = obj.name;
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
]);

/**
 * Server-injected boilerplate no chant user ever declares nor could
 * meaningfully override — Azure stamps every network security group with
 * these regardless of what was requested, so unlike `AZURE_READ_ONLY_NAMES`
 * this is dropped outright rather than compared.
 */
const AZURE_UNCONDITIONAL_PRUNE_NAMES: ReadonlySet<string> = new Set(["defaultSecurityRules"]);

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

    const defaults = AZURE_SERVICE_DEFAULTS[node.entityType];
    if (!defaults || !Object.prototype.hasOwnProperty.call(defaults, node.pattern)) return false;
    return canonicalJson(defaults[node.pattern]) === canonicalJson(node.value);
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
        detail: "az resource show does not accept a nested ARM type; chant never queried this resource",
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

    const cmd = [
      "az", "resource", "show",
      "--resource-group", options.environment,
      "--name", name,
      "--resource-type", entityType,
      "-o", "json",
    ].join(" ");

    try {
      const { stdout } = await execAsync(cmd);
      const obj: ArmResourceShowResponse = JSON.parse(stdout);
      resources[entityName] = {
        type: entityType,
        physicalId: obj.id,
        properties: normalizeDeepProperties(buildLiveProperties(obj), {
          entityType,
          side: "live",
          hooks: azureDeepNormalizationHooks,
        }),
      };
    } catch (err) {
      // Not-found leaves the entity out (absence, same as the thin path).
      // Auth/binding/other failures are holes so they can't become creates.
      const outcome = classifyAzFailure(err);
      if (!outcome.absent) {
        unobserved[entityName] = { type: entityType, reason: outcome.reason, detail: outcome.detail };
      }
    }
  }

  return deepObservation(resources, unobserved);
}
