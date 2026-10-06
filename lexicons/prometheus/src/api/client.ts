/**
 * The HTTP transport for the ruler and Alertmanager APIs (#3371): one client
 * for observe and live export here, and for the ruler apply target (#3372),
 * so every path reaches the same endpoint with the same tenant and
 * credentials.
 *
 * `PromHttp` is the seam. The default is `fetch` against a resolved target;
 * a test hands in a function, or points the target at a local fake server
 * (./fake-servers.ts).
 *
 * Bodies are text. The ruler's config API speaks YAML both ways, the
 * Prometheus-compatible APIs answer JSON, and Mimir's Alertmanager config
 * API answers YAML, so the caller decides how to read a body.
 *
 * Status mapping is in one place ({@link statusVerdict}): a 404 is the only
 * answer that means "not there", 401 and 403 mean the credentials were
 * refused, anything else that is not a 2xx is a failed read.
 */

/** How the client authenticates. */
export type PromAuth = { readonly token: string } | { readonly user: string; readonly password: string };

/** A resolved endpoint: where, as which tenant, as whom, and where that came from. */
export interface PromTarget {
  /** Base URL, without a trailing slash. */
  readonly url: string;
  /** `X-Scope-OrgID`, for a multi-tenant Mimir, Cortex or Loki. */
  readonly tenant?: string;
  readonly auth?: PromAuth;
  /** Where the binding came from: `prometheus.profiles.prod.ruler`, `env PROMETHEUS_RULER_URL`. */
  readonly source: string;
}

export interface PromResponse {
  readonly status: number;
  readonly text: string;
}

/** One request. `path` starts with `/` and is relative to the target's URL. */
export type PromHttp = (method: string, path: string, body?: { text: string; contentType: string }) => Promise<PromResponse>;

function authHeader(auth: PromAuth | undefined): Record<string, string> {
  if (!auth) return {};
  if ("token" in auth) return { authorization: `Bearer ${auth.token}` };
  return { authorization: `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString("base64")}` };
}

/** The default transport: `fetch` against the target, with the tenant header and credentials on every request. */
export function promHttp(target: PromTarget, fetchImpl: typeof fetch = fetch): PromHttp {
  const base = target.url.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    accept: "application/json, application/yaml;q=0.9, */*;q=0.1",
    ...authHeader(target.auth),
    ...(target.tenant ? { "x-scope-orgid": target.tenant } : {}),
  };
  return async (method, path, body) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": body.contentType },
      ...(body === undefined ? {} : { body: body.text }),
    });
    return { status: res.status, text: await res.text() };
  };
}

/** What a status means for a read. */
export type StatusVerdict = "ok" | "not-found" | "refused" | "failed";

export function statusVerdict(status: number): StatusVerdict {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404) return "not-found";
  if (status === 401 || status === 403) return "refused";
  return "failed";
}

/** A non-2xx answer, with enough to classify it and to say where it came from. */
export class PromApiError extends Error {
  readonly verdict: StatusVerdict;
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    body: string,
  ) {
    const detail = body.trim().split("\n")[0].slice(0, 200);
    super(`${method} ${path} returned ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "PromApiError";
    this.verdict = statusVerdict(status);
  }
}

/** A bound client: the transport, the target it reaches, and a per-client memo so N reads share one lookup. */
export class PromClient {
  private readonly memo = new Map<string, Promise<unknown>>();

  constructor(
    readonly http: PromHttp,
    readonly target: PromTarget,
  ) {}

  /** GET, returning the body text; undefined on 404; throws {@link PromApiError} on any other non-2xx. */
  async getText(path: string): Promise<string | undefined> {
    const res = await this.http("GET", path);
    const verdict = statusVerdict(res.status);
    if (verdict === "ok") return res.text;
    if (verdict === "not-found") return undefined;
    throw new PromApiError(res.status, "GET", path, res.text);
  }

  /** GET a JSON body; undefined on 404. A 2xx body that is not JSON is a failed read. */
  async getJson<T = unknown>(path: string): Promise<T | undefined> {
    const text = await this.getText(path);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PromApiError(502, "GET", path, `the answer is not JSON: ${text.slice(0, 80)}`);
    }
  }

  /** A write. Resolves on a 2xx; throws {@link PromApiError} otherwise, a 404 included. */
  async send(method: "POST" | "PUT" | "DELETE", path: string, body?: { text: string; contentType: string }): Promise<PromResponse> {
    const res = await this.http(method, path, body);
    if (statusVerdict(res.status) !== "ok") throw new PromApiError(res.status, method, path, res.text);
    return res;
  }

  /** Run `fn` once per key for this client's lifetime; concurrent callers share the promise. A failure is not cached. */
  once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.memo.set(key, p);
      p.catch(() => this.memo.delete(key));
    }
    return p;
  }
}
