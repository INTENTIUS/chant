/**
 * The Grafana HTTP transport (#2946): one client for observe, export and,
 * later, the API applier (#2948), so all three reach the same instance with
 * the same credentials.
 *
 * `GrafanaHttp` is the seam. The default is `fetch` against a resolved
 * target (./target.ts); a test hands in a function that answers by path, so
 * nothing needs a module mock.
 *
 * Status mapping is in one place ({@link statusVerdict}): a 404 is the only
 * answer that means "not there", 401/403 mean the credentials were refused,
 * and anything else that is not a 2xx is a failed read. A reader that turned
 * a 500 or a refused token into "absent" would have `chant lifecycle plan`
 * propose creating a dashboard that is running.
 */

/** How the client authenticates. A service account token is the usual form; basic auth suits a local instance. */
export type GrafanaAuth = { readonly token: string } | { readonly user: string; readonly password: string };

/** A resolved Grafana instance: where, as whom, which organisation, and where that came from. */
export interface GrafanaTarget {
  /** Base URL, without a trailing slash: `https://grafana.example.com`. */
  readonly url: string;
  readonly auth?: GrafanaAuth;
  /** Organisation id; 1 when not set. Selects the `X-Grafana-Org-Id` header and the API namespace. */
  readonly orgId?: number;
  /**
   * The `dashboard.grafana.app` namespace. Defaults to `default` for org 1
   * and `org-<id>` otherwise; Grafana Cloud stacks use `stacks-<id>`.
   */
  readonly namespace?: string;
  /** Where the binding came from, in the project's vocabulary: `grafana.profiles.prod`, `env GRAFANA_URL`. */
  readonly source: string;
}

export interface GrafanaResponse {
  readonly status: number;
  /** The parsed body, or undefined when it was empty or not JSON. */
  readonly json: unknown;
}

/** One request. `path` starts with `/` and is relative to the target's URL. */
export type GrafanaHttp = (method: string, path: string, body?: unknown) => Promise<GrafanaResponse>;

/** The API namespace for a target (see {@link GrafanaTarget.namespace}). */
export function namespaceOf(target: Pick<GrafanaTarget, "orgId" | "namespace">): string {
  if (target.namespace) return target.namespace;
  const org = target.orgId ?? 1;
  return org === 1 ? "default" : `org-${org}`;
}

function authHeader(auth: GrafanaAuth | undefined): Record<string, string> {
  if (!auth) return {};
  if ("token" in auth) return { authorization: `Bearer ${auth.token}` };
  return { authorization: `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString("base64")}` };
}

/** The default transport: `fetch` against the target, JSON in and out. */
export function grafanaHttp(target: GrafanaTarget, fetchImpl: typeof fetch = fetch): GrafanaHttp {
  const base = target.url.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    accept: "application/json",
    ...authHeader(target.auth),
    ...(target.orgId !== undefined ? { "x-grafana-org-id": String(target.orgId) } : {}),
  };
  return async (method, path, body) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: unknown;
    if (text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { status: res.status, json };
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
export class GrafanaApiError extends Error {
  readonly verdict: StatusVerdict;
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    body: unknown,
  ) {
    const message = body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string" ? (body as { message: string }).message : "";
    super(`${method} ${path} returned ${status}${message ? `: ${message}` : ""}`);
    this.name = "GrafanaApiError";
    this.verdict = statusVerdict(status);
  }
}

/**
 * A bound client: the transport, the target it reaches, and per-client
 * caches (the API version a server serves, folder titles) so N reads do not
 * repeat the same lookup.
 */
export class GrafanaClient {
  private readonly memo = new Map<string, Promise<unknown>>();

  constructor(
    readonly http: GrafanaHttp,
    readonly target: GrafanaTarget,
  ) {}

  get namespace(): string {
    return namespaceOf(this.target);
  }

  /** GET, returning the body; undefined on 404; throws {@link GrafanaApiError} on any other non-2xx. */
  async get<T = unknown>(path: string): Promise<T | undefined> {
    const res = await this.http("GET", path);
    const verdict = statusVerdict(res.status);
    if (verdict === "ok") return res.json as T;
    if (verdict === "not-found") return undefined;
    throw new GrafanaApiError(res.status, "GET", path, res.json);
  }

  /** Run `fn` once per key for this client's lifetime; concurrent callers share the promise. */
  once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.memo.set(key, p);
      // A failed lookup is not cached: the next caller asks again.
      p.catch(() => this.memo.delete(key));
    }
    return p;
  }
}
