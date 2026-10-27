/**
 * behold#1029: GCP, through Cloud Asset Inventory's `searchAllResources` on
 * one project, paged.
 *
 * Nothing is enabled for the person. The Cloud Asset API has to be on before
 * a project can be searched, and turning it on changes the project. When the
 * search answers SERVICE_DISABLED, the lister lists nothing for the project,
 * marks every coverage entry `read-failed`, and puts the enable command in a
 * note for the person to run. The guard (packages/core/src/cloud-lister/guard.ts) admits no
 * Service Usage call at all, so the lister could not enable it if it tried.
 *
 * Types go in `assetTypes`, a tag filter in the query as `labels.KEY=VALUE`
 * terms. Locations are filtered here, after the search, because floci-gcp's
 * query subset has no location term.
 *
 * The pinned floci-gcp (ghcr.io/lex00/floci-gcp, source 641e6e8) serves this
 * call under the path prefix `/cloudasset` (pass `http://localhost:4588/cloudasset`
 * as the endpoint), for project scopes only, over the assets of four
 * services (Compute, Cloud Storage, IAM, Pub/Sub), with SERVICE_DISABLED
 * answered as GCP answers it when its Service Usage enforcement is on.
 */

import { buildResource, describeFailure, listedVerdict, noteTagFilter, withThrottleRetry, type ListerContext } from "./common";
import { resolveGcpToken, ListerConfigError, type CredentialChains } from "./credentials";
import { jsonBody, type TlsOptions, type WireResponse } from "./transport";
import type { CloudId } from "./types";

export interface GcpTarget {
  /** An emulator's Cloud Asset base, e.g. `http://localhost:4588/cloudasset`. Absent means `https://cloudasset.googleapis.com`. */
  endpoint?: string;
  /** An OAuth access token; `null` sends none (an emulator with IAM enforcement off). Required with an endpoint. */
  token?: string | null;
  tls?: TlsOptions;
}

const PAGE_SIZE = 500;
const MAX_PAGES = 10_000;
const PROJECT = /^[A-Za-z0-9._:-]+$/;
const LABEL_PART = /^[A-Za-z0-9_\-]+$/;

export function enableCommand(project: string): string {
  return `gcloud services enable cloudasset.googleapis.com --project=${project}`;
}

export function searchUrl(target: GcpTarget, project: string, params: { assetTypes?: readonly string[]; query?: string; pageToken?: string }): string {
  const base = (target.endpoint ?? "https://cloudasset.googleapis.com").replace(/\/+$/, "");
  const url = new URL(`${base}/v1/projects/${encodeURIComponent(project)}:searchAllResources`);
  for (const t of params.assetTypes ?? []) url.searchParams.append("assetTypes", t);
  if (params.query) url.searchParams.set("query", params.query);
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  if (params.pageToken) url.searchParams.set("pageToken", params.pageToken);
  return url.toString();
}

/** The `query` for a tag filter, or undefined. Exported for tests. */
export function labelQuery(filter: Readonly<Record<string, string>> | undefined): string | undefined {
  const entries = Object.entries(filter ?? {});
  if (entries.length === 0) return undefined;
  return entries
    .map(([k, v]) => {
      if (!LABEL_PART.test(k) || !LABEL_PART.test(v)) throw new ListerConfigError(`gcp label filter ${k}=${v} is not a plain label key and value`);
      return `labels.${k}=${v}`;
    })
    .join(" AND ");
}

interface GcpError {
  status: string;
  message: string;
  reasons: string[];
}

function gcpError(res: WireResponse): GcpError {
  const body = jsonBody(res) as
    | { error?: { status?: string; message?: string; details?: Array<{ reason?: string }>; errors?: Array<{ reason?: string }> } }
    | Array<{ error?: { status?: string; message?: string; details?: Array<{ reason?: string }> } }>
    | undefined;
  const e = Array.isArray(body) ? body[0]?.error : body?.error;
  const reasons = [...(e?.details ?? []), ...((e as { errors?: Array<{ reason?: string }> } | undefined)?.errors ?? [])]
    .map((d) => d.reason ?? "")
    .filter(Boolean);
  return { status: e?.status ?? "", message: e?.message ?? "", reasons };
}

export function isServiceDisabled(res: WireResponse): boolean {
  if (res.status !== 403) return false;
  const err = gcpError(res);
  return err.reasons.includes("SERVICE_DISABLED") || err.reasons.includes("accessNotConfigured") || /has not been used in project|is disabled/i.test(err.message);
}

export async function listGcp(
  ctx: ListerContext,
  target: GcpTarget,
  chains: CredentialChains,
  retryDelays?: readonly number[],
): Promise<void> {
  const { scope } = ctx;
  if (!PROJECT.test(scope.scopeId)) throw new ListerConfigError(`gcp project ${JSON.stringify(scope.scopeId)} is not a project id`);
  const token = await resolveGcpToken(target, chains);
  const query = labelQuery(scope.tagFilter);
  const assetTypes = scope.types === "*" ? undefined : scope.types;
  const wantLocations = scope.locations === "*" ? undefined : new Set(scope.locations.map((l) => l.toLowerCase()));
  const typesCovered = scope.types === "*" ? ["*"] : [...scope.types];
  const locationsCovered = scope.locations === "*" ? ["*"] : [...scope.locations].map((l) => l.toLowerCase());
  noteTagFilter(ctx, "as labels terms in the Cloud Asset query");

  const found: Parameters<typeof buildResource>[1][] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = searchUrl(target, scope.scopeId, { assetTypes, query, pageToken });
    const headers: Record<string, string> = { accept: "application/json" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const res = await withThrottleRetry(
      () => ctx.transport.send({ substrate: "gcp", method: "GET", url, headers }),
      (r) => r.status === 429,
      retryDelays,
    );
    const observedAt = ctx.now().toISOString();
    if (res.status >= 400) {
      const err = gcpError(res);
      const detail = describeFailure(res, err.status, err.message);
      if (isServiceDisabled(res)) {
        const why = `Cloud Asset API is disabled on project ${scope.scopeId}`;
        for (const t of typesCovered) for (const l of locationsCovered) ctx.coverage.push({ listedType: t, location: l, verdict: "read-failed", detail: why });
        ctx.notes.push({
          code: "api-disabled",
          message: `${why}, so nothing was listed for it. chant never enables an API; enabling it changes the project. To list it, run the command yourself and index again.`,
          command: enableCommand(scope.scopeId),
        });
        return;
      }
      const verdict = res.status === 401 || res.status === 403 ? "no-credentials" : "read-failed";
      for (const t of typesCovered) for (const l of locationsCovered) ctx.coverage.push({ listedType: t, location: l, verdict, detail });
      ctx.notes.push({ code: verdict === "no-credentials" ? "no-credentials" : "read-failed", message: `searchAllResources on project ${scope.scopeId} failed: ${detail}` });
      return;
    }
    const parsed = jsonBody(res) as { results?: Array<Record<string, unknown>>; nextPageToken?: string } | undefined;
    for (const r of parsed?.results ?? []) {
      const name = typeof r.name === "string" ? r.name : undefined;
      const assetType = typeof r.assetType === "string" ? r.assetType : undefined;
      if (!name || !assetType) continue;
      const location = (typeof r.location === "string" && r.location ? r.location : "global").toLowerCase();
      if (wantLocations && !wantLocations.has(location)) continue;
      const tags: Record<string, string> = {};
      if (r.labels && typeof r.labels === "object") {
        for (const [k, v] of Object.entries(r.labels as Record<string, unknown>)) tags[k] = String(v ?? "");
      }
      const cloudIds: CloudId[] = [{ kind: "provider-id", value: name }];
      const attrs = r.additionalAttributes as Record<string, unknown> | undefined;
      if (attrs && typeof attrs.selfLink === "string") cloudIds.push({ kind: "self-link", value: attrs.selfLink });
      const { labels: _labels, ...properties } = r;
      found.push({ listedType: assetType, location, nativeId: name, cloudIds, tags, properties, observedAt, labels: true });
    }
    pageToken = parsed?.nextPageToken || undefined;
    if (!pageToken) break;
  }
  for (const r of found) ctx.resources.push(buildResource(ctx, r));
  for (const t of typesCovered) for (const l of locationsCovered) ctx.coverage.push({ listedType: t, location: l, ...listedVerdict(scope) });
}
