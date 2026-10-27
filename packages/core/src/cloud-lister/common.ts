/**
 * behold#1029: what every substrate's lister shares: building one masked
 * {@link ListedResource}, recording coverage and notes, and the coverage rule
 * for a tag filter.
 */

import { listedNodeId } from "./ids";
import { readMarkers } from "./markers";
import { maskProperties, maskTags } from "./mask";
import type { Transport, WireResponse } from "./transport";
import type { CloudId, CloudScope, CoverageEntry, IndexNote, ListedResource } from "./types";

export interface ListerContext {
  scope: CloudScope;
  transport: Transport;
  now: () => Date;
  resources: ListedResource[];
  coverage: CoverageEntry[];
  notes: IndexNote[];
}

export function buildResource(
  ctx: ListerContext,
  r: {
    listedType: string;
    location: string;
    nativeId: string;
    cloudIds: CloudId[];
    tags: Record<string, string>;
    properties: Record<string, unknown>;
    observedAt: string;
    labels: boolean;
  },
): ListedResource {
  const tags = maskTags(r.tags);
  const markers = readMarkers(r.tags, { labels: r.labels });
  const cloudIds = dedupeCloudIds(r.cloudIds);
  return {
    id: listedNodeId({ substrate: ctx.scope.substrate, scopeId: ctx.scope.scopeId, location: r.location, listedType: r.listedType, nativeId: r.nativeId }),
    listedType: r.listedType,
    location: r.location,
    nativeId: r.nativeId,
    cloudIds,
    tags,
    properties: maskProperties(r.properties),
    observedAt: r.observedAt,
    facts: { ...(markers ? { markers } : {}), cloudIds, observedAt: r.observedAt },
  };
}

function dedupeCloudIds(ids: CloudId[]): CloudId[] {
  const seen = new Set<string>();
  const out: CloudId[] = [];
  for (const id of ids) {
    if (!id.value) continue;
    const key = `${id.kind}\u0000${id.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/**
 * The verdict for a (type, location) the lister read in full. Under a tag
 * filter it is `filtered`, because a filtered listing cannot tell an untagged
 * object from a missing one (#1025 "Coverage"); the objects it did list are
 * still observed.
 */
export function listedVerdict(scope: CloudScope): Pick<CoverageEntry, "verdict" | "detail"> {
  if (scope.tagFilter && Object.keys(scope.tagFilter).length > 0) {
    return { verdict: "filtered", detail: `tag filter ${JSON.stringify(scope.tagFilter)}` };
  }
  return { verdict: "listed" };
}

export function noteTagFilter(ctx: ListerContext, how: string): void {
  if (!ctx.scope.tagFilter || Object.keys(ctx.scope.tagFilter).length === 0) return;
  ctx.notes.push({
    code: "tag-filter",
    message: `the tag filter ${JSON.stringify(ctx.scope.tagFilter)} was applied ${how}; every coverage entry is "filtered", since a tag-filtered listing cannot say an untagged object is absent`,
  });
}

export function sortResult(ctx: ListerContext): void {
  ctx.resources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  ctx.coverage.sort((a, b) =>
    a.listedType !== b.listedType ? (a.listedType < b.listedType ? -1 : 1) : a.location < b.location ? -1 : a.location > b.location ? 1 : 0,
  );
}

/** A short, credential-free description of a failed response for a note or a coverage detail. */
export function describeFailure(res: WireResponse, code?: string, message?: string): string {
  const parts = [`HTTP ${res.status}`];
  if (code) parts.push(code);
  if (message) parts.push(message.length > 300 ? `${message.slice(0, 300)}...` : message);
  return parts.join(": ");
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retries a throttled call (HTTP 429 or a substrate's throttling code) a few times with backoff. */
export async function withThrottleRetry(
  send: () => Promise<WireResponse>,
  isThrottled: (res: WireResponse) => boolean,
  delays: readonly number[] = [500, 2000, 5000],
): Promise<WireResponse> {
  let res = await send();
  for (const d of delays) {
    if (!isThrottled(res)) return res;
    await sleep(d);
    res = await send();
  }
  return res;
}
