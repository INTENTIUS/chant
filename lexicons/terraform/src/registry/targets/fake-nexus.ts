/**
 * An in-memory stand-in for a Sonatype Nexus Repository hosted Terraform
 * repository (chant#4605), for the Nexus module target's tests here and in
 * terragucci#1302. It is a fetch function: nothing listens on a port and
 * nothing leaves the process.
 *
 * It answers the calls terragucci#1299's research found in Sonatype's docs,
 * under `/repository/<repo>/`:
 *
 *   PUT  v1/modules/<ns>/<name>/<system>/<version>/<file>      basic credentials, the archive as the body
 *   GET  v1/modules/<ns>/<name>/<system>/<version>/<file>
 *   GET  v1/modules/<ns>/<name>/<system>/versions
 *   GET  v1/modules/<ns>/<name>/<system>/<version>/download    204, X-Terraform-Get
 *   GET  v1/api/token                                            the 3.95 bearer token, for basic credentials
 *
 * There is no `/.well-known/terraform.json`: a Nexus repository is reached
 * through a CLI `host` block. Without credentials every call gets 401.
 * `bearer: false` drops the token call (Nexus before 3.95), and reads then
 * take basic credentials only. A body that is not a zip or a gzip holding a
 * `.tf` file gets 400, and an upload over a version already held gets 400,
 * as a deployment policy that disallows redeploy does, unless `redeploy` is
 * set. `cacheNotFound` keeps a new version's versions list answering 404 for
 * that many reads, as Nexus before 3.95 kept a "not found" in its cache.
 * Every request is kept, headers and body included.
 */
import { gunzipSync } from "node:zlib";
import { readZip } from "./zip";
import { basicOf, bearerOf, bodyOf, headersOf, jsonAnswer, type FakeFetch, type FakeRequest } from "./fake-http";

export interface FakeNexusOptions {
  /** The host, such as `nexus.example.com`. */
  host: string;
  /** The hosted Terraform repositories' names. */
  repos: string[];
  /** Users (or user token name codes) and their passwords (or pass codes). */
  users: Record<string, string>;
  /** Whether the 3.95 token call is there. Default true. */
  bearer?: boolean;
  /** Whether an upload over a held version is taken. Default false: 400. */
  redeploy?: boolean;
  /** How many versions reads a new version answers 404 for. Default 0. */
  cacheNotFound?: number;
}

export interface FakeNexus {
  fetch: FakeFetch;
  requests: FakeRequest[];
  /** Uploaded assets, keyed `<repo>/<ns>/<name>/<system>/<version>/<file>`. */
  assets: Map<string, Uint8Array>;
  /** Bearer tokens the token call issued. */
  issued: Set<string>;
  /** Put an asset in directly, as an upload by hand would. */
  seed(repo: string, ns: string, name: string, system: string, version: string, file: string, bytes: Uint8Array): void;
}

const holdsTf = (body: Uint8Array): boolean => {
  if (body[0] === 0x50 && body[1] === 0x4b) return readZip(body).entries.some((e) => !e.dir && e.path.endsWith(".tf"));
  if (body[0] === 0x1f && body[1] === 0x8b) return gunzipSync(body).includes(Buffer.from(".tf"));
  return false;
};

export function createFakeNexus(o: FakeNexusOptions): FakeNexus {
  const requests: FakeRequest[] = [];
  const assets = new Map<string, Uint8Array>();
  const issued = new Set<string>();
  const cached = new Map<string, number>();

  const userOf = (headers: Record<string, string>): string | undefined => {
    const b = basicOf(headers.authorization);
    return b && o.users[b.user] === b.password ? b.user : undefined;
  };
  const mayRead = (headers: Record<string, string>): boolean => {
    if (userOf(headers)) return true;
    const bearer = bearerOf(headers.authorization);
    return o.bearer !== false && bearer !== undefined && issued.has(bearer);
  };
  const versionOf = (key: string) => key.split("/").slice(0, 5).join("/");

  const seed: FakeNexus["seed"] = (repo, ns, name, system, version, file, bytes) => void assets.set(`${repo}/${ns}/${name}/${system}/${version}/${file}`, bytes);

  const fetch: FakeFetch = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = headersOf(init.headers);
    const body = bodyOf(init.body);
    requests.push({ method, url, headers, ...(body ? { body } : {}) });
    const u = new URL(url);
    if (u.host !== o.host) throw new TypeError(`fetch failed: the fake answers only ${o.host}, not ${u.host}`);
    const m = /^\/repository\/([^/]+)\/(.*)$/.exec(u.pathname);
    if (!m || !o.repos.includes(decodeURIComponent(m[1]!))) return jsonAnswer(404, { message: "Not Found" });
    const repo = decodeURIComponent(m[1]!);
    const rest = m[2]!.split("/").map(decodeURIComponent);

    if (rest.join("/") === "v1/api/token") {
      if (method !== "GET" || o.bearer === false) return jsonAnswer(404, { message: "Not Found" });
      const user = userOf(headers);
      if (!user) return jsonAnswer(401, { message: "Unauthorized" });
      const token = `TerraformBearerToken.fake-${user}-${issued.size + 1}`;
      issued.add(token);
      return jsonAnswer(200, { token });
    }
    if (rest[0] !== "v1" || rest[1] !== "modules") return jsonAnswer(404, { message: "Not Found" });
    const [ns, name, system] = rest.slice(2, 5);
    const prefix = `${repo}/${ns}/${name}/${system}/`;
    const tail = rest.slice(5);

    if (method === "PUT") {
      if (tail.length !== 2) return jsonAnswer(404, { message: "Not Found" });
      if (!userOf(headers)) return jsonAnswer(401, { message: "Unauthorized" });
      if (!body || body.length === 0) return jsonAnswer(400, { message: "empty body" });
      let ok = false;
      try {
        ok = holdsTf(body);
      } catch {
        ok = false;
      }
      if (!ok) return jsonAnswer(400, { message: "the archive must be a .zip, .tar.gz or .tgz holding .tf files" });
      const k = `${prefix}${tail[0]}/${tail[1]}`;
      const held = [...assets.keys()].some((a) => versionOf(a) === versionOf(k));
      if (held && !o.redeploy) return jsonAnswer(400, { message: "Repository does not allow updating assets" });
      assets.set(k, body);
      if (o.cacheNotFound) cached.set(`${prefix}`, o.cacheNotFound);
      return new Response(null, { status: 201 });
    }
    if (method !== "GET") return jsonAnswer(405, { message: "Method Not Allowed" });
    if (!mayRead(headers)) return jsonAnswer(401, { message: "Unauthorized" });

    if (tail.length === 1 && tail[0] === "versions") {
      const left = cached.get(prefix) ?? 0;
      if (left > 0) {
        cached.set(prefix, left - 1);
        return jsonAnswer(404, { message: "Not Found" });
      }
      const versions = [...new Set([...assets.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]!))];
      if (versions.length === 0) return jsonAnswer(404, { message: "Not Found" });
      return jsonAnswer(200, { modules: [{ versions: versions.map((version) => ({ version })) }] });
    }
    if (tail.length === 2 && tail[1] === "download") {
      const asset = [...assets.keys()].find((k) => k.startsWith(`${prefix}${tail[0]}/`));
      if (!asset) return jsonAnswer(404, { message: "Not Found" });
      const file = asset.slice(`${prefix}${tail[0]}/`.length);
      return new Response(null, { status: 204, headers: { "X-Terraform-Get": `${u.origin}/repository/${repo}/v1/modules/${ns}/${name}/${system}/${tail[0]}/${file}` } });
    }
    if (tail.length === 2) {
      const stored = assets.get(`${prefix}${tail[0]}/${tail[1]}`);
      if (!stored) return jsonAnswer(404, { message: "Not Found" });
      return new Response(new Uint8Array(stored), { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    return jsonAnswer(404, { message: "Not Found" });
  };

  return { fetch, requests, assets, issued, seed };
}
