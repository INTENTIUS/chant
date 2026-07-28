/**
 * Live introspection of an Azure resource group via the az CLI.
 *
 * For each declared Azure entity, runs:
 *   az resource show --resource-group <env> --name <name> --resource-type <type> -o json
 *
 * and maps the response to a ResourceMetadata entry keyed by chant entity name
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

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ObservationResult, ResourceMetadata, UnobservedEntity, UnobservedReason } from "@intentius/chant/lexicon";
import { observation } from "@intentius/chant/observation";

const execAsync = promisify(exec);

interface AzResourceShowResponse {
  id?: string;
  name?: string;
  type?: string;
  location?: string;
  properties?: {
    provisioningState?: string;
    [k: string]: unknown;
  };
  tags?: Record<string, string>;
}

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

export async function describeResources(options: {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
}): Promise<ObservationResult> {
  const result: Record<string, ResourceMetadata> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  const skippedNested: string[] = [];

  for (const [entityName, { entityType, props }] of options.entities) {
    if (!entityType.startsWith("Microsoft.")) {
      // Not an ARM resource type, so `az resource show` has nothing to ask for.
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
      const obj: AzResourceShowResponse = JSON.parse(stdout);
      result[entityName] = {
        type: entityType,
        physicalId: obj.id,
        status: obj.properties?.provisioningState ?? "PRESENT",
        attributes: pruneUndefined({
          location: obj.location,
          tags: obj.tags,
        }),
      };
    } catch (err) {
      // Not-found leaves the entity out (absence). Auth/binding/other failures
      // are recorded as holes so they can't become creates (#1089).
      const outcome = classifyAzFailure(err);
      if (!outcome.absent) {
        unobserved[entityName] = { type: entityType, reason: outcome.reason, detail: outcome.detail };
      }
    }
  }

  if (skippedNested.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[azure] ${skippedNested.length} nested-type entity(ies) reported as unobserved (not absent) — az resource show doesn't accept compound types: ${skippedNested.slice(0, 5).join(", ")}${skippedNested.length > 5 ? ", ..." : ""}`,
    );
  }

  return observation(result, unobserved);
}
