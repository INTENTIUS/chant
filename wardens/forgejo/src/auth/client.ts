/**
 * Forgejo REST client.
 *
 * A thin authed wrapper over a self-hosted Forgejo instance's REST API. Unlike
 * GitHub there are no Apps / installation tokens: auth is a single Forgejo API
 * token, and the instance host is configurable (Forgejo is self-hosted).
 *
 * The `request(method, path, body)` signature is intentionally identical to
 * github-warden's client so the shared `Cycle` interface and cycle code stay
 * portable across wardens.
 *
 *   path is relative to the API root: e.g. `request("GET", "/orgs/acme")`
 *   resolves to `<baseUrl>/api/v1/orgs/acme`. An absolute `http(s)://…` path is
 *   used as-is (e.g. for following pagination URLs).
 */

const API_PATH = "/api/v1";
const USER_AGENT = "forgejo-warden (+https://github.com/INTENTIUS/forgejo-warden)";

/** Error from a Forgejo API request. The message embeds the status code so
 *  cycles can branch on it (e.g. tolerate 403/404). */
export class ForgejoApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ForgejoApiError";
  }
}

export interface ForgejoClientOptions {
  /** Instance base URL, e.g. "https://forgejo.example.com" (no trailing /api). */
  baseUrl: string;
  /** Forgejo API token (personal or admin). Sent as `Authorization: token …`. */
  token: string;
  /** Injectable fetch for testing. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ForgejoClient {
  /** Make an authed Forgejo API request. `path` is relative to `<baseUrl>/api/v1`. */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

/** Returns a thin authed REST client for a Forgejo instance. */
export function createClient(opts: ForgejoClientOptions): ForgejoClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const root = `${opts.baseUrl.replace(/\/+$/, "")}${API_PATH}`;

  return {
    async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
      const url = /^https?:\/\//.test(path) ? path : `${root}${path}`;

      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers: {
            // Forgejo/Gitea accept the `token <token>` scheme.
            Authorization: `token ${opts.token}`,
            Accept: "application/json",
            "User-Agent": USER_AGENT,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          redirect: "manual",
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        throw new ForgejoApiError(
          `network error on ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!res.ok) {
        // Forgejo error bodies carry the failure reason and no secrets; surface
        // a capped slice. The status number is in the message so callers can
        // branch on it (e.g. tolerate 403/404).
        let detail = "";
        try {
          const text = await res.text();
          if (text) detail = `: ${text.slice(0, 500)}`;
        } catch {
          // best-effort
        }
        throw new ForgejoApiError(`${method} ${path} returned ${res.status}${detail}`, res.status);
      }

      // 204 No Content (and empty bodies) → empty object.
      if (res.status === 204) return {} as T;
      const text = await res.text();
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ForgejoApiError(`could not parse response from ${method} ${path} as JSON`);
      }
    },
  };
}
