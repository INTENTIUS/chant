/**
 * An in-memory stand-in for HCP Terraform's private module registry
 * (chant#4604), for the HCP module target's tests. It is a fetch function:
 * nothing listens on a port and nothing leaves the process, and no HCP
 * account or call is involved.
 *
 * It answers the calls the API docs give
 * (developer.hashicorp.com/terraform/cloud-docs/api-docs/private-registry/modules):
 *
 *   GET  /api/v2/organizations/:org/registry-modules/private/:org/:name/:provider   attributes.version-statuses
 *   POST /api/v2/organizations/:org/registry-modules                                 201, 422 when it exists
 *   POST /api/v2/organizations/:org/registry-modules/private/:org/:name/:provider/versions   201 with links.upload, 422 when it exists
 *   PUT  https://archivist.terraform.io/v1/object/<id>                               the gzip tarball
 *
 * and the registry protocol Terraform installs through:
 *
 *   GET  /.well-known/terraform.json            {"modules.v1": "/api/registry/v1/modules/"}
 *   GET  /api/registry/v1/modules/:org/:name/:provider/:version/download   204, X-Terraform-Get
 *   GET  https://archivist.terraform.io/v1/object/<id>                     the tarball
 *
 * A token the fake does not know gets 401. A known token without Manage
 * modules, or any token when the organization has no entitlement, gets 404
 * from the registry calls, as HCP answers. A version is `pending` once
 * created, and turns `ok` after its tarball is uploaded and the module has
 * been read `parseAfterReads` more times. `throttle(n)` answers the next n
 * requests with 429. Every request is kept, headers and body included.
 */
import { gunzipSync } from "node:zlib";

export interface FakeHcpRequest {
  method: string;
  url: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface FakeHcpOptions {
  /** Default app.terraform.io. */
  host?: string;
  organization: string;
  /** Tokens the fake knows, and whether each one's team has Manage modules. */
  tokens: Record<string, { manageModules: boolean }>;
  /** Whether the organization has the private registry. Default true. */
  entitled?: boolean;
  /** Module reads after an upload before the version is `ok`. Default 0; Infinity keeps it pending. */
  parseAfterReads?: number;
}

interface FakeVersion {
  status: string;
  commitSha: string | null;
  archive?: Uint8Array;
  object: string;
  readsLeft: number;
}

export type FakeHcpFetch = (url: string, init?: { method?: string; headers?: unknown; body?: unknown }) => Promise<Response>;

export interface FakeHcp {
  fetch: FakeHcpFetch;
  requests: FakeHcpRequest[];
  /** Modules by `<name>/<provider>`, each with its versions. */
  modules: Map<string, Map<string, FakeVersion>>;
  /** Put a module, and a version with its archive, in directly. Status `ok` unless given. */
  seed(name: string, provider: string, version?: { version: string; archive: Uint8Array; status?: string }): void;
  /** Answer the next `n` requests with 429, carrying `Retry-After` when it is given. */
  throttle(n: number, retryAfter?: string): void;
}

export const ARCHIVIST = "archivist.terraform.io";

function headersOf(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof (h as Headers).forEach === "function" && typeof (h as Headers).get === "function") {
    (h as Headers).forEach((v, k) => (out[k.toLowerCase()] = v));
    return out;
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = String(v);
  return out;
}

function bodyOf(b: unknown): Uint8Array | undefined {
  if (b === undefined || b === null) return undefined;
  if (typeof b === "string") return new TextEncoder().encode(b);
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  throw new Error("the fake takes a string or bytes as a body");
}

const doc = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/vnd.api+json" } });
const errors = (status: number, title: string) => doc(status, { errors: [{ status: String(status), title }] });

export function createFakeHcp(o: FakeHcpOptions): FakeHcp {
  const host = o.host ?? "app.terraform.io";
  const org = o.organization;
  const requests: FakeHcpRequest[] = [];
  const modules = new Map<string, Map<string, FakeVersion>>();
  const objects = new Map<string, { module: string; version: string }>();
  let throttled = 0;
  let throttleAfter: string | undefined;
  let next = 0;

  const newVersion = (module: string, version: string, status: string, commitSha: string | null, archive?: Uint8Array): FakeVersion => {
    const object = `obj${++next}`;
    objects.set(object, { module, version });
    return { status, commitSha, object, readsLeft: o.parseAfterReads ?? 0, ...(archive ? { archive } : {}) };
  };
  const seed: FakeHcp["seed"] = (name, provider, version) => {
    const key = `${name}/${provider}`;
    const vs = modules.get(key) ?? new Map<string, FakeVersion>();
    modules.set(key, vs);
    if (version) vs.set(version.version, newVersion(key, version.version, version.status ?? "ok", null, version.archive));
  };

  const moduleDoc = (name: string, provider: string, vs: Map<string, FakeVersion>) =>
    doc(200, {
      data: {
        id: `mod-${name}-${provider}`,
        type: "registry-modules",
        attributes: {
          name,
          provider,
          namespace: org,
          "registry-name": "private",
          status: vs.size ? "setup_complete" : "pending",
          "version-statuses": [...vs.entries()].map(([version, v]) => ({ version, status: v.status })),
        },
      },
    });

  const fetch: FakeHcpFetch = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = headersOf(init.headers);
    const body = bodyOf(init.body);
    requests.push({ method, url, headers, ...(body ? { body } : {}) });
    if (throttled > 0) {
      throttled--;
      return new Response(JSON.stringify({ errors: [{ status: "429", title: "Too Many Requests" }] }), { status: 429, headers: throttleAfter !== undefined ? { "retry-after": throttleAfter } : {} });
    }
    const u = new URL(url);

    if (u.host === ARCHIVIST) {
      const id = /^\/v1\/object\/([^/]+)$/.exec(u.pathname)?.[1];
      const ref = id ? objects.get(id) : undefined;
      if (!ref) return errors(404, "not found");
      const v = modules.get(ref.module)!.get(ref.version)!;
      if (method === "PUT") {
        if (headers["content-type"] !== "application/octet-stream") return errors(400, "content type");
        if (!body) return errors(400, "no body");
        try {
          gunzipSync(body);
        } catch {
          v.status = "reg_ingress_failed";
          return new Response(null, { status: 200 });
        }
        v.archive = body;
        if (v.readsLeft <= 0) v.status = "ok";
        return new Response(null, { status: 200 });
      }
      if (method === "GET") return v.archive ? new Response(new Uint8Array(v.archive), { status: 200 }) : errors(404, "not found");
      return errors(405, "method");
    }
    if (u.host !== host) throw new TypeError(`fetch failed: the fake answers only ${host} and ${ARCHIVIST}, not ${u.host}`);

    if (method === "GET" && u.pathname === "/.well-known/terraform.json") return new Response(JSON.stringify({ "modules.v1": "/api/registry/v1/modules/" }), { status: 200 });

    const bearer = /^Bearer (.+)$/i.exec(headers.authorization ?? "")?.[1];
    if (!bearer || !o.tokens[bearer]) return errors(401, "unauthorized");
    const allowed = o.tokens[bearer]!.manageModules && o.entitled !== false;

    const proto = /^\/api\/registry\/v1\/modules\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/download$/.exec(u.pathname);
    if (proto && method === "GET") {
      if (proto[1] !== org || o.entitled === false) return errors(404, "not found");
      const v = modules.get(`${proto[2]}/${proto[3]}`)?.get(proto[4]!);
      if (!v || v.status !== "ok") return errors(404, "not found");
      return new Response(null, { status: 204, headers: { "X-Terraform-Get": `https://${ARCHIVIST}/v1/object/${v.object}` } });
    }

    const base = `/api/v2/organizations/${org}/registry-modules`;
    if (!u.pathname.startsWith(base)) return errors(404, "not found");
    if (!allowed) return errors(404, "not found");

    if (method === "POST" && u.pathname === base) {
      const d = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array())) as { data?: { type?: string; attributes?: Record<string, unknown> } };
      const a = d.data?.attributes ?? {};
      if (d.data?.type !== "registry-modules" || typeof a.name !== "string" || typeof a.provider !== "string" || a["registry-name"] !== "private") return errors(422, "malformed");
      const key = `${a.name}/${a.provider}`;
      if (modules.has(key)) return errors(422, "Name has already been taken");
      modules.set(key, new Map());
      return doc(201, { data: { type: "registry-modules", attributes: { name: a.name, provider: a.provider } } });
    }

    const m = /^\/private\/([^/]+)\/([^/]+)\/([^/]+)(\/versions)?$/.exec(u.pathname.slice(base.length));
    if (!m || m[1] !== org) return errors(404, "not found");
    const key = `${m[2]}/${m[3]}`;
    const vs = modules.get(key);
    if (!vs) return errors(404, "not found");

    if (!m[4] && method === "GET") {
      for (const v of vs.values()) {
        if (v.status === "pending" && v.archive) {
          if (v.readsLeft <= 0) v.status = "ok";
          else v.readsLeft--;
        }
      }
      return moduleDoc(m[2]!, m[3]!, vs);
    }
    if (m[4] && method === "POST") {
      const d = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array())) as { data?: { type?: string; attributes?: { version?: unknown; "commit-sha"?: unknown } } };
      const version = d.data?.attributes?.version;
      if (d.data?.type !== "registry-module-versions" || typeof version !== "string") return errors(422, "malformed");
      if (vs.has(version)) return errors(422, "Version has already been taken");
      const sha = d.data.attributes?.["commit-sha"];
      const v = newVersion(key, version, "pending", typeof sha === "string" ? sha : null);
      vs.set(version, v);
      return doc(201, { data: { type: "registry-module-versions", attributes: { version, status: "pending", source: "tfe-api", "commit-sha": v.commitSha }, links: { upload: `https://${ARCHIVIST}/v1/object/${v.object}` } } });
    }
    return errors(405, "method");
  };

  return {
    fetch,
    requests,
    modules,
    seed,
    throttle(n, retryAfter) {
      throttled = n;
      throttleAfter = retryAfter;
    },
  };
}
