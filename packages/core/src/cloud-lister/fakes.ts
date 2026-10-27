/**
 * behold#1029: test doubles for the lister. Nothing here opens a socket: a
 * fake fetcher answers from a route function and throws on any call it was
 * not given an answer for, and fake credential chains count their calls so a
 * test can show none was touched.
 */

import type { WireCall } from "./guard";
import type { CredentialChains } from "./credentials";
import type { Fetcher, WireResponse } from "./transport";

export function json(status: number, body: unknown, headers: Record<string, string> = {}): WireResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

export interface FakeFetcher {
  fetcher: Fetcher;
  calls: WireCall[];
}

export function fakeFetcher(route: (call: WireCall) => WireResponse | undefined): FakeFetcher {
  const calls: WireCall[] = [];
  return {
    calls,
    fetcher: async (call) => {
      calls.push(call);
      const res = route(call);
      if (!res) throw new Error(`fake fetcher has no answer for ${call.method} ${call.url}`);
      return res;
    },
  };
}

export interface CountingChains extends CredentialChains {
  count: { aws: number; azure: number; gcp: number };
}

/** Chains that fail if used; `count` says how often each was asked. */
export function refusingChains(): CountingChains {
  const count = { aws: 0, azure: 0, gcp: 0 };
  return {
    count,
    async aws() {
      count.aws++;
      throw new Error("the AWS default provider chain was asked for credentials");
    },
    async azure() {
      count.azure++;
      throw new Error("DefaultAzureCredential was asked for a token");
    },
    async gcp() {
      count.gcp++;
      throw new Error("application-default credentials were asked for a token");
    },
  };
}

/** A fixed clock that advances one second per reading, so timestamps are predictable. */
export function steppingClock(start = "2026-10-26T12:00:00Z"): () => Date {
  let t = Date.parse(start);
  return () => {
    const d = new Date(t);
    t += 1000;
    return d;
  };
}
