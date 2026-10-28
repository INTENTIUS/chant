/**
 * An in-memory stand-in for GitLab's Terraform module registry (chant#4603),
 * for the GitLab module target's tests. It is a fetch function, so nothing
 * listens on a port and nothing leaves the process: the target's upload and
 * the registry reader's reads both go through it.
 *
 * It answers the calls GitLab documents (docs.gitlab.com/api/packages/terraform-modules/):
 *
 *   GET  /.well-known/terraform.json                                  {"modules.v1": "/api/v4/packages/terraform/modules/v1/"}
 *   PUT  /api/v4/projects/:id/packages/terraform/modules/:name/:system/:version/file
 *   GET  /api/v4/packages/terraform/modules/v1/:ns/:name/:system/versions
 *   GET  /api/v4/packages/terraform/modules/v1/:ns/:name/:system/:version/download   204, X-Terraform-Get
 *   GET  /api/v4/packages/terraform/modules/v1/:ns/:name/:system/:version/file?token=...
 *
 * The upload takes `PRIVATE-TOKEN` or `JOB-TOKEN`; the reads take
 * `Authorization: Bearer`. A token the fake does not know gets 401, and a
 * known token without write access to the project gets 403. Uploading a
 * version the project already holds gets 403 "Package already exists", as
 * GitLab answers a duplicate package. Every request is kept, headers and
 * body included, so a test can check them.
 */
import { gunzipSync } from "node:zlib";

/** One request the fake was sent. */
export interface FakeGitlabRequest {
  method: string;
  url: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface FakeGitlabOptions {
  /** The host, such as `gitlab.example.com`. */
  host: string;
  /** Projects by id, each with its full path, whose top-level group is the namespace. */
  projects: Record<string, string>;
  /** Tokens the fake knows, each with the project ids it may upload to. */
  tokens: Record<string, string[]>;
  /** Whether reads need a bearer token. Default true, as for a private project. */
  privateReads?: boolean;
}

interface Stored {
  archive: Uint8Array;
  project: string;
}

/** The fetch both the target and the reader are given. */
export type FakeGitlabFetch = (url: string, init?: { method?: string; headers?: unknown; body?: unknown }) => Promise<Response>;

export interface FakeGitlab {
  fetch: FakeGitlabFetch;
  requests: FakeGitlabRequest[];
  /** What the registry holds, keyed `<ns>/<name>/<system>/<version>`. */
  modules: Map<string, Stored>;
  /** Put a version in directly, as an upload by hand would. */
  seed(project: string, name: string, system: string, version: string, archive: Uint8Array): void;
}

const API = "/api/v4";
const MODULES_V1 = `${API}/packages/terraform/modules/v1/`;
const DOWNLOAD_TOKEN = "fake-download-grant";

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

const json = (status: number, doc: unknown) => new Response(JSON.stringify(doc), { status, headers: { "content-type": "application/json" } });

export function createFakeGitlab(o: FakeGitlabOptions): FakeGitlab {
  const requests: FakeGitlabRequest[] = [];
  const modules = new Map<string, Stored>();
  const namespaceOf = (project: string) => o.projects[project]!.split("/")[0]!;
  const projectId = (raw: string): string | undefined => {
    const id = decodeURIComponent(raw);
    if (o.projects[id]) return id;
    return Object.entries(o.projects).find(([, path]) => path === id)?.[0];
  };
  const seed = (project: string, name: string, system: string, version: string, archive: Uint8Array) => {
    modules.set(`${namespaceOf(project)}/${name}/${system}/${version}`, { archive, project });
  };

  const fetch: FakeGitlabFetch = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = headersOf(init.headers);
    const body = bodyOf(init.body);
    requests.push({ method, url, headers, ...(body ? { body } : {}) });
    const u = new URL(url);
    if (u.host !== o.host) throw new TypeError(`fetch failed: the fake answers only ${o.host}, not ${u.host}`);
    const path = u.pathname;

    if (method === "GET" && path === "/.well-known/terraform.json") return json(200, { "modules.v1": MODULES_V1 });

    const upload = /^\/api\/v4\/projects\/([^/]+)\/packages\/terraform\/modules\/([^/]+)\/([^/]+)\/([^/]+)\/file$/.exec(path);
    if (upload) {
      if (method !== "PUT") return json(405, { message: "405 Method Not Allowed" });
      const token = headers["private-token"] ?? headers["job-token"];
      if (!token || !o.tokens[token]) return json(401, { message: "401 Unauthorized" });
      const project = projectId(upload[1]!);
      if (!project) return json(404, { message: "404 Project Not Found" });
      if (!o.tokens[token]!.includes(project)) return json(403, { message: "403 Forbidden" });
      if (!body || body.length === 0) return json(400, { message: "400 Bad request - file is missing" });
      try {
        gunzipSync(body);
      } catch {
        return json(400, { message: "400 Bad request - not a gzip archive" });
      }
      const [name, system, version] = [upload[2]!, upload[3]!, upload[4]!].map(decodeURIComponent) as [string, string, string];
      const key = `${namespaceOf(project)}/${name}/${system}/${version}`;
      if (modules.has(key)) return json(403, { message: "403 Forbidden - Package already exists" });
      modules.set(key, { archive: body, project });
      return json(201, { message: "201 Created" });
    }

    if (method === "GET" && path.startsWith(MODULES_V1)) {
      const rest = path.slice(MODULES_V1.length).split("/").map(decodeURIComponent);
      const isFile = rest.length === 5 && rest[4] === "file";
      if (isFile) {
        if (u.searchParams.get("token") !== DOWNLOAD_TOKEN) return json(401, { message: "401 Unauthorized" });
      } else if (o.privateReads !== false) {
        const bearer = /^Bearer (.+)$/i.exec(headers.authorization ?? "")?.[1];
        if (!bearer || !o.tokens[bearer]) return json(401, { message: "401 Unauthorized" });
      }
      const [ns, name, system] = rest;
      const prefix = `${ns}/${name}/${system}/`;
      if (rest.length === 4 && rest[3] === "versions") {
        const versions = [...modules.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
        if (versions.length === 0) return json(404, { message: "404 Not Found" });
        return json(200, { modules: [{ versions: versions.map((version) => ({ version, submodules: [], root: { dependencies: [], providers: [] } })), source: `${o.host}/${ns}/${name}/${system}` }] });
      }
      if (rest.length === 5 && rest[4] === "download") {
        if (!modules.has(`${prefix}${rest[3]}`)) return json(404, { message: "404 Not Found" });
        return new Response(null, { status: 204, headers: { "X-Terraform-Get": `${MODULES_V1}${prefix}${rest[3]}/file?token=${DOWNLOAD_TOKEN}&archive=tgz` } });
      }
      if (isFile) {
        const stored = modules.get(`${prefix}${rest[3]}`);
        if (!stored) return json(404, { message: "404 Not Found" });
        return new Response(new Uint8Array(stored.archive), { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
    }
    return json(404, { message: "404 Not Found" });
  };

  return { fetch, requests, modules, seed };
}
