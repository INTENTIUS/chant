/**
 * behold#1029: the lister's one way onto the network.
 *
 * {@link Transport.send} runs, in order: the read-only check
 * (packages/core/src/cloud-lister/guard.ts), the origin pin, then the fetcher. The pin is
 * the goal's never-public-cloud rule in code: when a run names its own
 * endpoint (an emulator), every call must go to that endpoint's origin, so a
 * URL built wrong can never reach a public cloud host. A test passes its own
 * {@link Fetcher}; production uses {@link nodeFetcher}, which is node's own
 * http/https so a cluster's CA and client certificate can be passed
 * explicitly.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { assertReadCall, type WireCall } from "./guard";

export interface WireResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** TLS material for one target, passed explicitly; nothing is read from the environment. */
export interface TlsOptions {
  ca?: string;
  cert?: string;
  key?: string;
  /** Only for a local emulator whose certificate the caller chose not to pin. */
  insecureSkipVerify?: boolean;
}

export type Fetcher = (call: WireCall, tls: TlsOptions | undefined) => Promise<WireResponse>;

export class OriginRefused extends Error {
  constructor(readonly url: string, readonly allowed: string) {
    super(`chant's cloud lister refused ${url}: this run is pinned to ${allowed}`);
    this.name = "OriginRefused";
  }
}

export interface TransportOptions {
  fetcher?: Fetcher;
  /** When set, every call must go to this origin (an explicit endpoint). */
  pinnedOrigin?: string;
  tls?: TlsOptions;
  /** Called with each call that passed the guard, before it is sent (tests record with it). */
  onSend?: (call: WireCall, operation: string) => void;
}

export class Transport {
  readonly calls: Array<{ call: WireCall; operation: string }> = [];
  private readonly fetcher: Fetcher;

  constructor(private readonly options: TransportOptions = {}) {
    this.fetcher = options.fetcher ?? nodeFetcher;
  }

  async send(call: WireCall): Promise<WireResponse> {
    const operation = assertReadCall(call);
    if (this.options.pinnedOrigin !== undefined) {
      const origin = new URL(call.url).origin;
      if (origin !== new URL(this.options.pinnedOrigin).origin) throw new OriginRefused(call.url, this.options.pinnedOrigin);
    }
    this.calls.push({ call, operation });
    this.options.onSend?.(call, operation);
    return this.fetcher(call, this.options.tls);
  }
}

/** node's http/https, one request, the whole body read as text. */
export const nodeFetcher: Fetcher = (call, tls) =>
  new Promise((resolve, reject) => {
    const url = new URL(call.url);
    const secure = url.protocol === "https:";
    const send = secure ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: call.method,
        headers: call.headers,
        ...(secure && tls
          ? {
              ...(tls.ca !== undefined ? { ca: tls.ca } : {}),
              ...(tls.cert !== undefined ? { cert: tls.cert } : {}),
              ...(tls.key !== undefined ? { key: tls.key } : {}),
              ...(tls.insecureSkipVerify ? { rejectUnauthorized: false } : {}),
            }
          : {}),
        timeout: 60_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
          }
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timed out: ${call.method} ${call.url}`)));
    req.on("error", reject);
    if (call.body !== undefined) req.write(call.body);
    req.end();
  });

/** The body parsed as JSON, or `undefined` when it is not JSON. */
export function jsonBody(res: WireResponse): unknown {
  try {
    return res.body === "" ? undefined : JSON.parse(res.body);
  } catch {
    return undefined;
  }
}
