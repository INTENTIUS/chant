/**
 * chant#4558: the bucket check's one way onto the network.
 *
 * Every read the check makes is a GET built here, and nothing else is sent.
 * When a target names its own endpoint (an emulator such as floci), every
 * call is pinned to that endpoint's origin, so a URL built wrong cannot reach
 * a public cloud host. The sender is the cloud lister's node http/https
 * fetcher (packages/core/src/cloud-lister/transport.ts); a test passes its
 * own {@link Fetcher} and opens no socket.
 */

import { nodeFetcher, type Fetcher, type TlsOptions, type WireResponse } from "../cloud-lister/transport";
import type { WireCall } from "../cloud-lister/guard";

export class BucketCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BucketCheckError";
  }
}

export interface WireOptions {
  /** Replaces node's http/https; tests answer from a route table. */
  fetcher?: Fetcher;
  tls?: TlsOptions;
  /** Called with each call before it is sent (tests record with it). */
  onSend?: (call: WireCall) => void;
}

/** One GET, refused unless it goes to `pinnedOrigin` when that is set. */
export async function sendGet(
  substrate: WireCall["substrate"],
  url: string,
  headers: Record<string, string>,
  pinnedOrigin: string | undefined,
  options: WireOptions,
): Promise<WireResponse> {
  if (pinnedOrigin !== undefined && new URL(url).origin !== new URL(pinnedOrigin).origin) {
    throw new BucketCheckError(`chant's bucket check refused ${url}: this check is pinned to ${pinnedOrigin}`);
  }
  const call: WireCall = { substrate, method: "GET", url, headers };
  options.onSend?.(call);
  return (options.fetcher ?? nodeFetcher)(call, options.tls);
}

/** `"tofu-records/prod"` as `"tofu-records/prod/"`; `""` stays `""`. Same rule as choudoufu's staterecord.NamespacePrefix. */
export function namespacePrefix(prefix: string): string {
  if (prefix === "") return "";
  return prefix.replace(/\/+$/, "") + "/";
}
