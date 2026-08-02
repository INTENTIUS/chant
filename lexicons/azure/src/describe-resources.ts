/**
 * Live introspection of an Azure resource group over ARM (#1212).
 *
 * For each declared Azure entity, GETs
 *   {endpoint}/subscriptions/{sub}/resourceGroups/{env}/providers/{type}/{name}
 *
 * on the applier's own transport (`./api/read-client.ts`, which is
 * `az-apply.ts`'s client pointed at the read side) rather than shelling
 * `az resource show`. The payload is the same ARM JSON either way — the CLI was
 * only ever relaying it — so this is transport, not translation: no CLI to
 * spawn, reads that run concurrently, failures carrying ARM's own error code,
 * and an emulator override that reaches floci-az the same way every other
 * lexicon's does.
 *
 * The response maps to a ResourceMetadata entry keyed by chant entity name
 * (using props.name from #39's entity-prop pass-through). The environment
 * argument is treated as the Azure resource group name.
 *
 * Resource-not-found is an absence — `state diff --live` then reports it as
 * missing. Nested resource types (e.g.
 * `Microsoft.Storage/storageAccounts/blobServices`) are NOT-OBSERVED
 * (`unsupported-kind`, #1089): `az resource show` doesn't accept a compound
 * type, so chant never asks, and a blob service that already exists must not
 * come back as a proposed `create`. Auth failures and unreachable subscriptions
 * are holes for the same reason.
 */

import type { ObservationResult, ResourceMetadata, UnobservedEntity, UnobservedReason } from "@intentius/chant/lexicon";
import { boundedConcurrently, observation } from "@intentius/chant/observation";
import { AzureReadError, getResource, isNotFound, type AzureReadClientOptions } from "./api/read-client";
import type { AzHttp } from "./op/activities/az-apply";

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Top-level ARM type — i.e. exactly one `/` separating provider from kind.
 * Nested types like `Microsoft.Storage/storageAccounts/blobServices` need a
 * different query path that this implementation doesn't yet support.
 *
 * Exported so the deep reader (./deep-observe.ts, #1086) applies the exact
 * same scope limit — a nested type is `unsupported-kind` at both depths, not
 * silently deeper on one and not the other.
 */
export function isTopLevelType(entityType: string): boolean {
  const slashCount = (entityType.match(/\//g) ?? []).length;
  return slashCount === 1;
}

/**
 * Classify an `az resource show` failure (#1089). Only the CLI's explicit
 * not-found establishes absence; everything else — an expired login, a
 * subscription that can't be resolved, a network failure — proves nothing.
 */
export function classifyAzFailure(err: unknown): { absent: true } | { absent: false; reason: UnobservedReason; detail: string } {
  const raw =
    typeof err === "object" && err !== null && typeof (err as { stderr?: unknown }).stderr === "string"
      ? ((err as { stderr: string }).stderr.trim() || String((err as { message?: unknown }).message ?? err))
      : String((err as { message?: unknown } | undefined)?.message ?? err);
  const lower = raw.toLowerCase();
  const detail = (raw.split("\n").find((l) => l.trim().length > 0) ?? raw).trim().slice(0, 200);

  if (
    lower.includes("resourcenotfound") ||
    lower.includes("was not found") ||
    lower.includes("could not be found") ||
    lower.includes("does not exist")
  ) {
    return { absent: true };
  }
  if (
    lower.includes("please run 'az login'") ||
    lower.includes("az login") ||
    lower.includes("authenticationfailed") ||
    lower.includes("expired") ||
    lower.includes("authorizationfailed") ||
    lower.includes("forbidden")
  ) {
    return { absent: false, reason: "no-credentials", detail };
  }
  if (
    lower.includes("subscriptionnotfound") ||
    lower.includes("no subscription") ||
    lower.includes("please run 'az account set'")
  ) {
    return { absent: false, reason: "no-binding", detail };
  }
  return { absent: false, reason: "read-failed", detail };
}

/**
 * Classify an ARM failure off its own error code (#1212).
 *
 * The CLI classifier above matched on prose because stderr was all it had.
 * ARM sends `{ error: { code, message } }`, so the code is the signal and the
 * message is only for the human — the same distinction the AWS read client
 * makes. Kept beside `classifyAzFailure` rather than replacing it: the CLI
 * path still exists for a signed read against real ARM.
 */
export function classifyArmFailure(err: unknown): { reason: UnobservedReason; detail: string } {
  const code = err instanceof AzureReadError ? (err.code ?? "") : "";
  const message = err instanceof Error ? err.message : String(err);
  const detail = (code ? `${code}: ${message}` : message).slice(0, 200);
  const both = `${code} ${message}`.toLowerCase();

  if (
    both.includes("authenticationfailed") ||
    both.includes("authorizationfailed") ||
    both.includes("expired") ||
    both.includes("forbidden") ||
    (err instanceof AzureReadError && (err.status === 401 || err.status === 403))
  ) {
    return { reason: "no-credentials", detail };
  }
  if (both.includes("subscriptionnotfound") || both.includes("resourcegroupnotfound")) {
    return { reason: "no-binding", detail };
  }
  return { reason: "read-failed", detail };
}

export async function describeResources(options: {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  /** Injectable transport, mirroring `azApply`'s — tests reach the reader with no network. */
  http?: AzHttp;
}): Promise<ObservationResult> {
  const result: Record<string, ResourceMetadata> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  const skippedNested: string[] = [];
  const readable: Array<{ entityName: string; entityType: string; name: string }> = [];

  // The environment is the resource group, as it has always been on this path.
  const client: AzureReadClientOptions = {
    resourceGroup: options.environment,
    ...(process.env.AZURE_ENDPOINT_URL ? { endpoint: process.env.AZURE_ENDPOINT_URL } : {}),
    ...(process.env.AZURE_SUBSCRIPTION_ID ? { subscriptionId: process.env.AZURE_SUBSCRIPTION_ID } : {}),
    ...(options.http ? { http: options.http } : {}),
  };

  for (const [entityName, { entityType, props }] of options.entities) {
    if (!entityType.startsWith("Microsoft.")) {
      // Not an ARM resource type, so there is no ARM URL to GET.
      // Unobserved rather than skipped: a silent skip reads as absence (#1089).
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: "not an ARM resource type (expected Microsoft.<provider>/<kind>)",
      };
      continue;
    }

    if (!isTopLevelType(entityType)) {
      skippedNested.push(entityName);
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

  // Concurrent, where the CLI path was one spawn after another (#1201/#1212).
  await boundedConcurrently(readable, async ({ entityName, entityType, name }) => {
    try {
      const body = await getResource(client, entityType, name);
      result[entityName] = {
        type: entityType,
        physicalId: body.id,
        status: (body.properties?.provisioningState as string | undefined) ?? "PRESENT",
        attributes: pruneUndefined({
          location: body.location,
          tags: body.tags,
        }),
      };
    } catch (err) {
      // Not-found leaves the entity out (absence). Auth/binding/other failures
      // are recorded as holes so they can't become creates (#1089).
      if (isNotFound(err)) return;
      const outcome = classifyArmFailure(err);
      unobserved[entityName] = { type: entityType, reason: outcome.reason, detail: outcome.detail };
    }
  });

  if (skippedNested.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[azure] ${skippedNested.length} nested-type entity(ies) reported as unobserved (not absent) — az resource show doesn't accept compound types: ${skippedNested.slice(0, 5).join(", ")}${skippedNested.length > 5 ? ", ..." : ""}`,
    );
  }

  return observation(result, unobserved);
}
