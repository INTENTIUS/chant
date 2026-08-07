/**
 * Minimal Control Plane REST client.
 *
 * Deliberately small: observation needs list-and-index, nothing more. The API
 * is uniform enough that one `get` covers every kind — `/org/{org}/{kind}` for
 * org-scoped, `/org/{org}/{kind}` again for the GVC-scoped rollup, which is why
 * `collectionPath` in `kinds.ts` returns the org-wide form when no GVC is given.
 * That rollup is what makes observation one request per kind instead of one per
 * GVC.
 *
 * Credentials follow the CLI's own conventions so `chant plan` reads the org a
 * `cpln` command in the same shell would write to. Nothing here reads a secret
 * value: `-reveal` is never called.
 */

import { collectionPath, type CplnKind } from "./kinds";

/** Default API root. `CPLN_ENDPOINT` overrides it for a private deployment. */
export const DEFAULT_ENDPOINT = "https://api.cpln.io";

/** A resource as the API returns it. Only the envelope is typed. */
export interface CplnResource {
  id?: string;
  name?: string;
  kind?: string;
  version?: number;
  description?: string;
  tags?: Record<string, unknown>;
  created?: string;
  lastModified?: string;
  links?: Array<{ rel?: string; href?: string }>;
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A list response. Control Plane returns `{ kind: "...list", items: [...] }`. */
interface CplnList {
  items?: CplnResource[];
}

export interface CplnConfig {
  endpoint: string;
  org: string;
  token: string;
}

/** Thrown when there is no org or no token to read with. */
export class CplnCredentialsError extends Error {}

/**
 * Resolve endpoint, org and token from the environment.
 *
 * `CPLN_TOKEN` is the documented CI variable and the one Control Plane's own
 * guidance prefers over `--token`, which leaks into process listings and logs.
 * A service account key works in the same header.
 */
export function resolveConfig(overrides: Partial<CplnConfig> = {}): CplnConfig {
  const endpoint = overrides.endpoint ?? process.env.CPLN_ENDPOINT ?? DEFAULT_ENDPOINT;
  const org = overrides.org ?? process.env.CPLN_ORG ?? "";
  const token = overrides.token ?? process.env.CPLN_TOKEN ?? "";

  if (!org) {
    throw new CplnCredentialsError(
      "No Control Plane org. Set CPLN_ORG (or pass `org`) — it is the top-level isolation boundary and " +
        "every read path is scoped to it.",
    );
  }
  if (!token) {
    throw new CplnCredentialsError(
      "No Control Plane token. Set CPLN_TOKEN to a service account key or a JWT. Prefer the env var over " +
        "`--token`, which leaks into logs.",
    );
  }

  return { endpoint: endpoint.replace(/\/+$/, ""), org, token };
}

/**
 * Build the `Authorization` header value.
 *
 * The spec declares two schemes on the same header: `serviceAccountKey` is an
 * apiKey sent bare, `jwt` is an HTTP bearer token. They are distinguishable by
 * shape — a JWT is three base64url segments and always starts `eyJ` — so a
 * caller does not have to say which kind of credential they have. An
 * already-prefixed value is passed through so an explicit `Bearer …` works too.
 */
export function authorization(token: string): string {
  if (token.startsWith("Bearer ")) return token;
  return /^eyJ[A-Za-z0-9_-]+\./.test(token) ? `Bearer ${token}` : token;
}

/** The transport, injectable so tests need no network. */
export interface CplnHttp {
  get(path: string): Promise<unknown>;
}

/** The default transport — `fetch` with the documented auth header. */
export function defaultCplnHttp(config: CplnConfig): CplnHttp {
  return {
    async get(path: string): Promise<unknown> {
      const response = await fetch(`${config.endpoint}${path}`, {
        headers: { Authorization: authorization(config.token), Accept: "application/json" },
      });

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new Error(`GET ${path} → ${response.status} ${response.statusText}`);
      }
      return response.json();
    },
  };
}

/**
 * List every resource of one kind in the org, keyed by name.
 *
 * Returns an empty map for a 404, which the API uses for a kind the org has
 * none of as well as for one the token cannot see — the distinction is not
 * available here, and the observer treats an absent resource as absent either
 * way.
 */
export async function listKind(
  http: CplnHttp,
  config: CplnConfig,
  kind: CplnKind,
): Promise<Map<string, CplnResource>> {
  const body = (await http.get(collectionPath(kind, config.org))) as CplnList | undefined;
  const index = new Map<string, CplnResource>();
  for (const item of body?.items ?? []) {
    if (typeof item.name === "string") index.set(item.name, item);
  }
  return index;
}
