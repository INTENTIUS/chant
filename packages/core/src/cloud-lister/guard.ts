/**
 * behold#1029: read-only by construction.
 *
 * Every request the lister makes is a {@link WireCall}, and every WireCall
 * goes through {@link assertReadCall} before anything reaches the network
 * (packages/core/src/cloud-lister/transport.ts is the only sender). The check classifies the
 * call from what would go on the wire (method, path, `X-Amz-Target`), never
 * from a label the caller attaches, and admits only the operations in
 * {@link READ_OPERATIONS}:
 *
 *  - aws: Cloud Control `ListResources` (a POST, but the JSON protocol's only
 *    verb; the target header names the operation);
 *  - azure: Resource Graph's query, `POST /providers/Microsoft.ResourceGraph/resources`
 *    (a read that takes its KQL in the body);
 *  - gcp: Cloud Asset `searchAllResources`, a GET. Nothing under
 *    `serviceusage` is admitted, so the lister cannot enable the Cloud Asset
 *    API on a project (#1029: "nothing is enabled for the person");
 *  - kubernetes: GET discovery (`/api`, `/apis`, `/api/v1`, `/apis/<g>/<v>`)
 *    and GET collection lists, never `watch`.
 *
 * packages/core/src/cloud-lister/guard.test.ts holds the allowlist to exactly this set and
 * shows a mutating call of each substrate refused.
 */

import type { Substrate } from "./types";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/** One HTTP request as it would be sent. */
export interface WireCall {
  substrate: Substrate;
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** The only operations the lister may send, by substrate. */
export const READ_OPERATIONS: Readonly<Record<Substrate, readonly string[]>> = {
  aws: ["cloudcontrol:ListResources"],
  azure: ["resourcegraph:resources"],
  gcp: ["cloudasset:searchAllResources"],
  kubernetes: ["k8s:discovery", "k8s:list"],
};

export class MutatingCallRefused extends Error {
  constructor(
    readonly call: Pick<WireCall, "substrate" | "method" | "url">,
    readonly operation: string,
  ) {
    super(`chant's cloud lister refused ${call.method} ${call.url} (${operation}): only ${READ_OPERATIONS[call.substrate].join(", ")} may be sent`);
    this.name = "MutatingCallRefused";
  }
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/**
 * The operation a call performs, read off the wire. Anything this cannot
 * name precisely comes back as `<substrate>:unknown:<detail>`, which no
 * allowlist entry matches.
 */
export function classifyCall(call: WireCall): string {
  const url = new URL(call.url);
  const path = url.pathname;
  switch (call.substrate) {
    case "aws": {
      const target = header(call.headers, "x-amz-target") ?? "";
      const m = /^CloudApiService\.([A-Za-z]+)$/.exec(target);
      if (call.method === "POST" && m) return `cloudcontrol:${m[1]}`;
      return `aws:unknown:${call.method} ${target || path}`;
    }
    case "azure": {
      if (call.method === "POST" && /\/providers\/microsoft\.resourcegraph\/resources$/i.test(path)) {
        return "resourcegraph:resources";
      }
      return `azure:unknown:${call.method} ${path}`;
    }
    case "gcp": {
      const m = /\/v1\/(projects|folders|organizations)\/[^/:]+:([A-Za-z]+)$/.exec(path);
      if (call.method === "GET" && m && m[2] === "searchAllResources" && !/serviceusage/i.test(url.hostname + path)) {
        return "cloudasset:searchAllResources";
      }
      return `gcp:unknown:${call.method} ${path}`;
    }
    case "kubernetes": {
      if (call.method !== "GET") return `k8s:unknown:${call.method} ${path}`;
      const watch = url.searchParams.get("watch");
      if (watch !== null && watch !== "false" && watch !== "0") return `k8s:watch:${path}`;
      if (/^\/(api|apis)\/?$/.test(path)) return "k8s:discovery";
      if (/^\/api\/v1\/?$/.test(path)) return "k8s:discovery";
      if (/^\/apis\/[^/]+\/[^/]+\/?$/.test(path)) return "k8s:discovery";
      // A collection: /api/v1/<plural> or /apis/<g>/<v>/<plural>. A named
      // object, a subresource (logs, exec, proxy) or a namespaced path is not.
      if (/^\/api\/v1\/[a-z0-9.-]+$/.test(path)) return "k8s:list";
      if (/^\/apis\/[^/]+\/[^/]+\/[a-z0-9.-]+$/.test(path)) return "k8s:list";
      return `k8s:unknown:${call.method} ${path}`;
    }
  }
}

/** Throws {@link MutatingCallRefused} unless the call is one of {@link READ_OPERATIONS}. */
export function assertReadCall(call: WireCall): string {
  const operation = classifyCall(call);
  if (!READ_OPERATIONS[call.substrate].includes(operation)) throw new MutatingCallRefused(call, operation);
  return operation;
}
