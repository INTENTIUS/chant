/**
 * Deploy-unit status for GCP (#3143, the #1495 seam). `gcp-apply` stamps
 * `managed-by=chant` plus `chant-stack` / `chant-env` (from the object's
 * ownership labels, coerced to GCP label rules) on what it creates. This sweeps every kind the applier can list: a stack is
 * present when a chant-owned resource carries `chant-stack=<stack>`. Owned
 * resources with no stack label cannot be attributed to any stack, so they
 * make the answer indeterminate (`null`), never a confident absence. When
 * every list call fails the answer is `null` too.
 */
import type { StackStatusObservation } from "@intentius/chant/lexicon";
import { GCP_RESOURCE_OWNERSHIP_KEYS, gcpLabelValue } from "./ownership";
import { MAPPERS, isChantOwned } from "./op/activities/gcp-apply";
import type { GcpReadHttp } from "./api/read-client";

export async function describeStackStatus(
  options: { environment: string; stack: string },
  deps: { http?: GcpReadHttp; project?: string; endpoint?: string } = {},
): Promise<StackStatusObservation | null> {
  const project = deps.project ?? process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) return null; // no binding: indeterminate (NO_PROJECT)
  const endpoint = deps.endpoint ?? process.env.GCP_ENDPOINT_URL;
  const http: GcpReadHttp =
    deps.http ??
    (async (method, url) => {
      const res = await fetch(url, { method });
      return { status: res.status, text: await res.text() };
    });

  // Labels hold the coerced form (see gcpLabelValue), so compare like with like.
  const wanted = gcpLabelValue(options.stack) ?? options.stack;
  let anyRead = false;
  let stacked = 0;
  let unattributed = 0;
  for (const mapper of Object.values(MAPPERS)) {
    if (!mapper.list) continue;
    const base = (endpoint ?? mapper.defaultHost).replace(/\/$/, "");
    try {
      const res = await http("GET", mapper.list.url({ base, project }));
      if (res.status < 200 || res.status >= 300) continue;
      anyRead = true;
      for (const item of mapper.list.items(JSON.parse(res.text))) {
        if (!isChantOwned(item.labels)) continue;
        if (item.labels?.[GCP_RESOURCE_OWNERSHIP_KEYS.stack] === wanted) stacked++;
        else if (!item.labels?.[GCP_RESOURCE_OWNERSHIP_KEYS.stack]) unattributed++;
      }
    } catch {
      // One kind failing to list proves nothing about the others.
    }
  }
  if (!anyRead) return null;
  if (stacked > 0) return { stack: options.stack, present: true, status: `${stacked} resources`, healthy: true };
  if (unattributed > 0) return null;
  return { stack: options.stack, present: false };
}
