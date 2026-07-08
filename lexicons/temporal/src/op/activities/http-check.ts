import { sleep } from "@intentius/chant/op";

export interface HttpCheckArgs {
  /** URL to GET (or `method`). */
  url: string;
  /** HTTP method. Default: `GET`. */
  method?: string;
  /** Exact expected status. Default: any 2xx. */
  status?: number;
  /** Substring the response body must contain. */
  contains?: string;
  /** Retries before failing, for a resource that may lag. Default: `0`. */
  retries?: number;
  /** Delay between retries in ms. Default: `1000`. */
  intervalMs?: number;
}

/** Injectable fetch — the response shape `httpCheck` needs. Defaults to global `fetch`. */
export type HttpFetch = (url: string, init?: { method?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/** Whether a status satisfies the expectation (exact if given, else any 2xx). Pure. */
export function statusOk(status: number, expected?: number): boolean {
  return expected === undefined ? status >= 200 && status < 300 : status === expected;
}

/**
 * Assert an HTTP endpoint responds as expected — a typed verify step, the modeled
 * replacement for `shell("curl -fs ...")`. Fails (throwing) if the status or body
 * doesn't match after the allowed retries. `fetchFn` is injectable for tests.
 * Uses fastIdempotent profile — 5m timeout.
 */
export async function httpCheck(args: HttpCheckArgs, signal?: AbortSignal, fetchFn: HttpFetch = fetch): Promise<{ status: number }> {
  const retries = args.retries ?? 0;
  const intervalMs = args.intervalMs ?? 1_000;
  let lastErr = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new Error("httpCheck aborted");
    try {
      const res = await fetchFn(args.url, { method: args.method ?? "GET", signal });
      const body = args.contains !== undefined ? await res.text() : "";
      if (!statusOk(res.status, args.status)) {
        lastErr = `status ${res.status} (want ${args.status ?? "2xx"})`;
      } else if (args.contains !== undefined && !body.includes(args.contains)) {
        lastErr = `body missing "${args.contains}"`;
      } else {
        console.log(`httpCheck OK: ${args.url} (${res.status})`);
        return { status: res.status };
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    if (attempt < retries) await sleep(intervalMs, signal);
  }
  throw new Error(`httpCheck failed for ${args.url}: ${lastErr}`);
}
