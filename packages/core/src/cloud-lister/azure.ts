/**
 * behold#1029: Azure, through Resource Graph: one KQL query per run, paged,
 * over the `Resources` table and the subscription's resource groups.
 *
 * Resource Graph answers for every ARM type with one call shape, so coverage
 * is the scope's own types and locations, each `listed` (or `filtered` under
 * a tag filter, which goes into the query). Types are the lowercase ARM types
 * Resource Graph returns (`microsoft.storage/storageaccounts`).
 *
 * Every value that goes into the query (types, locations, tag keys and
 * values) is checked against a plain character set rather than escaped, so a
 * scope can never change the query's shape.
 *
 * The pinned floci-az (ghcr.io/lex00/floci-az, source 7f079c2) serves this
 * call: `POST /providers/Microsoft.ResourceGraph/resources`, the KQL subset
 * used here (`where`, `in~`, `union`, `project`, `order by`), and
 * `$top`/`$skipToken` paging (docs/services/resource-graph.md).
 */

import { buildResource, describeFailure, listedVerdict, noteTagFilter, withThrottleRetry, type ListerContext } from "./common";
import { resolveAzureToken, ListerConfigError, type CredentialChains } from "./credentials";
import { jsonBody, type TlsOptions, type WireResponse } from "./transport";
import type { CloudId } from "./types";

export interface AzureTarget {
  /** An emulator's ARM endpoint, e.g. `https://localhost:4577`. Absent means `https://management.azure.com`. */
  endpoint?: string;
  /** A bearer token for ARM. Required with an endpoint. */
  token?: string;
  tls?: TlsOptions;
}

export const RESOURCE_GRAPH_API_VERSION = "2022-10-01";
const RESOURCE_GROUP_TYPE = "microsoft.resources/subscriptions/resourcegroups";
const PAGE_SIZE = 1000;
const MAX_PAGES = 10_000;
const SAFE = /^[A-Za-z0-9._\-\/: ]+$/;

function safe(what: string, value: string): string {
  if (!SAFE.test(value)) throw new ListerConfigError(`azure ${what} ${JSON.stringify(value)} has characters a Resource Graph query does not take from a flag`);
  return value;
}

function list(values: readonly string[], what: string): string {
  return values.map((v) => `'${safe(what, v)}'`).join(", ");
}

/** The KQL for a scope. Exported for tests. */
export function resourceGraphQuery(scope: ListerContext["scope"]): string {
  const lines: string[] = [];
  const wantsGroups = scope.types === "*" || scope.types.some((t) => t.toLowerCase() === RESOURCE_GROUP_TYPE);
  lines.push(wantsGroups ? `Resources | union (ResourceContainers | where type =~ '${RESOURCE_GROUP_TYPE}')` : "Resources");
  if (scope.types !== "*") lines.push(`| where type in~ (${list(scope.types, "type")})`);
  if (scope.locations !== "*") lines.push(`| where location in~ (${list(scope.locations, "location")})`);
  for (const [k, v] of Object.entries(scope.tagFilter ?? {})) {
    lines.push(`| where tags['${safe("tag key", k)}'] == '${safe("tag value", v)}'`);
  }
  lines.push("| project id, name, type, kind, location, resourceGroup, subscriptionId, managedBy, tags, sku, plan, identity, zones, extendedLocation, properties");
  lines.push("| order by id asc");
  return lines.join("\n");
}

export function resourceGraphUrl(target: AzureTarget): string {
  const base = target.endpoint ?? "https://management.azure.com";
  const url = new URL("/providers/Microsoft.ResourceGraph/resources", base);
  url.searchParams.set("api-version", RESOURCE_GRAPH_API_VERSION);
  return url.toString();
}

function azureError(res: WireResponse): { code: string; message: string } {
  const body = jsonBody(res) as { error?: { code?: string; message?: string } } | undefined;
  return { code: body?.error?.code ?? "", message: body?.error?.message ?? "" };
}

export async function listAzure(
  ctx: ListerContext,
  target: AzureTarget,
  chains: CredentialChains,
  retryDelays?: readonly number[],
): Promise<void> {
  const { scope } = ctx;
  safe("subscription", scope.scopeId);
  const query = resourceGraphQuery(scope);
  const token = await resolveAzureToken(target, chains);
  const url = resourceGraphUrl(target);
  noteTagFilter(ctx, "in the Resource Graph query");

  const typesCovered = scope.types === "*" ? ["*"] : [...scope.types].map((t) => t.toLowerCase());
  const locationsCovered = scope.locations === "*" ? ["*"] : [...scope.locations].map((l) => l.toLowerCase());
  const found: Parameters<typeof buildResource>[1][] = [];
  let skipToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = JSON.stringify({
      subscriptions: [scope.scopeId],
      query,
      options: { $top: PAGE_SIZE, resultFormat: "objectArray", ...(skipToken ? { $skipToken: skipToken } : {}) },
    });
    const send = () =>
      ctx.transport.send({
        substrate: "azure",
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      });
    const res = await withThrottleRetry(send, (r) => r.status === 429, retryDelays);
    const observedAt = ctx.now().toISOString();
    if (res.status >= 400) {
      const err = azureError(res);
      const detail = describeFailure(res, err.code, err.message);
      const verdict = res.status === 401 || res.status === 403 ? "no-credentials" : "read-failed";
      for (const t of typesCovered) for (const l of locationsCovered) ctx.coverage.push({ listedType: t, location: l, verdict, detail });
      ctx.notes.push({
        code: verdict === "no-credentials" ? "no-credentials" : "read-failed",
        message: `Resource Graph query on subscription ${scope.scopeId} failed: ${detail}`,
      });
      return;
    }
    const parsed = jsonBody(res) as { data?: unknown; $skipToken?: string } | undefined;
    const rows = Array.isArray(parsed?.data) ? (parsed!.data as Array<Record<string, unknown>>) : [];
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id : undefined;
      if (!id) continue;
      const type = String(row.type ?? "").toLowerCase();
      const loc = String(row.location ?? "").toLowerCase() || "global";
      const tags: Record<string, string> = {};
      if (row.tags && typeof row.tags === "object") {
        for (const [k, v] of Object.entries(row.tags as Record<string, unknown>)) tags[k] = String(v ?? "");
      }
      const { tags: _tags, ...properties } = row;
      const cloudIds: CloudId[] = [
        { kind: "provider-id", value: id },
        { kind: "provider-id", value: id.toLowerCase() },
      ];
      found.push({ listedType: type, location: loc, nativeId: id, cloudIds, tags, properties, observedAt, labels: false });
    }
    skipToken = parsed?.$skipToken || undefined;
    if (!skipToken) break;
  }
  for (const r of found) ctx.resources.push(buildResource(ctx, r));
  for (const t of typesCovered) for (const l of locationsCovered) ctx.coverage.push({ listedType: t, location: l, ...listedVerdict(scope) });
}
