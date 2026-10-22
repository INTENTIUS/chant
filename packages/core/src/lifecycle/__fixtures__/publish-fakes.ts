/**
 * Test stand-ins for the publish targets (#4047): an OCI registry fake that
 * listens on 127.0.0.1 inside the test process and answers with a Bearer
 * challenge as GHCR and Docker Hub do, an OCI image layout writer, a fake
 * `npm` that records each call and keeps a registry with dist-tags in a file,
 * and a forge fake with draft releases (#4048). Nothing here reaches a network or a real
 * registry, and every server a test starts is closed by it.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

const sha = (b: Uint8Array | string) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

export interface FakeRegistry {
  /** `127.0.0.1:<port>`, for a repository reference. */
  host: string;
  blobs: Map<string, Buffer>;
  manifests: Map<string, { name: string; type: string; bytes: Buffer }>;
  /** Each request: method, path and the authorization header it carried. */
  requests: Array<{ method: string; path: string; authorization: string | null }>;
  uploads: number;
  close(): Promise<void>;
}

/** A registry fake with a Bearer token service that accepts `username` and `password`. */
export async function startFakeRegistry(creds: { username: string; password: string; token: string }): Promise<FakeRegistry> {
  const blobs = new Map<string, Buffer>();
  const manifests = new Map<string, { name: string; type: string; bytes: Buffer }>();
  const requests: FakeRegistry["requests"] = [];
  const state = { uploads: 0, port: 0 };
  const read = (req: IncomingMessage) =>
    new Promise<Buffer>((res) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => res(Buffer.concat(parts)));
    });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${state.port}`);
    const body = await read(req);
    requests.push({ method: req.method ?? "", path: url.pathname, authorization: req.headers.authorization ?? null });
    const send = (status: number, headers: Record<string, string> = {}, text = "") => {
      res.writeHead(status, headers);
      res.end(text);
    };
    if (url.pathname === "/token") {
      const basic = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;
      if (req.headers.authorization !== basic) return send(401, {}, "bad credentials");
      return send(200, { "content-type": "application/json" }, JSON.stringify({ token: creds.token }));
    }
    if (req.headers.authorization !== `Bearer ${creds.token}`) {
      return send(401, { "www-authenticate": `Bearer realm="http://127.0.0.1:${state.port}/token",service="fake-registry"` }, "unauthorized");
    }
    let m = url.pathname.match(/^\/v2\/(.+)\/blobs\/uploads\/(.*)$/);
    if (m) {
      if (req.method === "POST") return send(202, { location: `/v2/${m[1]}/blobs/uploads/u${requests.length}?_state=s` });
      const digest = url.searchParams.get("digest") ?? "";
      if (req.method === "PUT" && sha(body) === digest && url.searchParams.get("_state") === "s") {
        blobs.set(digest, body);
        state.uploads++;
        return send(201, { "docker-content-digest": digest });
      }
      return send(400, {}, "digest invalid");
    }
    m = url.pathname.match(/^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]+)$/);
    if (m && req.method === "HEAD") return send(blobs.has(m[2]!) ? 200 : 404);
    m = url.pathname.match(/^\/v2\/(.+)\/manifests\/(.+)$/);
    if (m && (req.method === "HEAD" || req.method === "GET")) {
      const found = manifests.get(m[2]!);
      return found ? send(200, { "content-type": found.type, "docker-content-digest": sha(found.bytes) }, req.method === "GET" ? found.bytes.toString("utf-8") : "") : send(404);
    }
    if (m && req.method === "PUT") {
      const ref = m[2]!;
      if (ref.startsWith("sha256:") && sha(body) !== ref) return send(400, {}, "manifest digest invalid");
      const parsed = JSON.parse(body.toString("utf-8")) as { config?: { digest: string }; layers?: Array<{ digest: string }> };
      for (const d of [parsed.config, ...(parsed.layers ?? [])]) if (d && !blobs.has(d.digest)) return send(400, {}, `blob unknown ${d.digest}`);
      manifests.set(ref, { name: m[1]!, type: String(req.headers["content-type"]), bytes: body });
      return send(201, { "docker-content-digest": sha(body) });
    }
    return send(404, {}, "not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  state.port = (server.address() as AddressInfo).port;
  return {
    host: `127.0.0.1:${state.port}`,
    blobs,
    manifests,
    requests,
    get uploads() {
      return state.uploads;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Write a one-image OCI layout at `dir`, returning the manifest's and the config's digests. */
export function writeOciLayout(dir: string, content = "layer bytes"): { digest: string; configDigest: string } {
  const blobsDir = join(dir, "blobs", "sha256");
  mkdirSync(blobsDir, { recursive: true });
  const put = (bytes: string) => {
    const d = sha(bytes);
    writeFileSync(join(blobsDir, d.slice(7)), bytes);
    return { digest: d, size: Buffer.byteLength(bytes) };
  };
  const layer = put(content);
  const config = put(JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [layer.digest] } }));
  const manifest = put(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config },
      layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", ...layer }],
    }),
  );
  writeFileSync(join(dir, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  writeFileSync(join(dir, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", ...manifest }] }));
  return { digest: manifest.digest, configDigest: config.digest };
}

/** What the fake npm's registry holds: each package's versions and dist-tags. */
export interface FakeNpmRegistry {
  packages: Record<string, { versions: string[]; distTags: Record<string, string> }>;
}

/** The registry file a fake npm writing calls to `log` keeps its state in. */
export const fakeNpmRegistryFile = (log: string) => `${log}.registry.json`;

/** Read the fake npm's registry. */
export function readFakeNpmRegistry(log: string): FakeNpmRegistry {
  const file = fakeNpmRegistryFile(log);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as FakeNpmRegistry) : { packages: {} };
}

/** Seed the fake npm's registry, such as with an earlier version as `latest`. */
export function seedFakeNpmRegistry(log: string, registry: FakeNpmRegistry): void {
  writeFileSync(fakeNpmRegistryFile(log), JSON.stringify(registry));
}

/**
 * Write a fake `npm` at `<binDir>/npm` that appends `{ args, tokenSet }` to
 * `log` for each call and prints the token it was given (so a test can show
 * it is masked). It keeps a registry in `<log>.registry.json`, as npm's does:
 *
 * - `publish <dir|tgz> [--tag <t>]` adds the version under `<t>` (default
 *   `latest`), and refuses a version already there with a 403. As npm's
 *   registry does, a package's first version is also `latest`. It exits 1
 *   when the package path contains `$FAKE_NPM_FAIL`.
 * - `view <name>@<version> version` prints the version when it is there.
 * - `dist-tag add <name>@<version> <tag>` points the tag at a version that is
 *   there. It exits 1 when the name contains `$FAKE_NPM_FAIL_TAG`.
 * - `install` (#4049) checks that every dependency in `./package.json` is in
 *   its registry at that version, and installs nothing.
 * - `audit signatures` (#4049) prints what npm prints for verified
 *   signatures and attestations, and exits 1 when `$FAKE_NPM_AUDIT_FAIL` is set.
 * - `$FAKE_NPM_LAG` (#4244), `<name>=<n>[,<name>=<n>]`: after a publish of
 *   that name, the next `n` views of the version find nothing, as a registry
 *   that accepted a publish but does not serve it yet.
 * - `$FAKE_NPM_INSTALL_ETARGET` (#4244), `<n>`: the first `n` installs fail
 *   with ETARGET.
 */
export function writeFakeNpm(binDir: string, log: string): string {
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, "npm");
  writeFileSync(
    file,
    `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
const token = process.env.NODE_AUTH_TOKEN || "";
const regFile = ${JSON.stringify(log)} + ".registry.json";
const userconfig = process.env.NPM_CONFIG_USERCONFIG ? fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG, "utf-8") : "";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, tokenSet: token !== "", ...(userconfig ? { userconfig } : {}) }) + "\\n");
console.log("npm notice using //registry.example/:_authToken=" + token);
console.error("npm notice token " + token);
const reg = fs.existsSync(regFile) ? JSON.parse(fs.readFileSync(regFile, "utf-8")) : { packages: {} };
const save = () => fs.writeFileSync(regFile, JSON.stringify(reg));
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const split = (spec) => { const at = spec.lastIndexOf("@"); return [spec.slice(0, at), spec.slice(at + 1)]; };
if (args[0] === "publish") {
  if (process.env.FAKE_NPM_FAIL && args[1] && args[1].includes(process.env.FAKE_NPM_FAIL)) { console.error("npm error 403 Forbidden"); process.exit(1); }
  // A package whose trusted-publisher record is broken: only a token in the user config publishes it.
  if (process.env.FAKE_NPM_NEEDAUTH && args[1] && args[1].includes(process.env.FAKE_NPM_NEEDAUTH) && !userconfig.includes("_authToken=")) { console.error("npm error code ENEEDAUTH"); process.exit(1); }
  if (process.env.FAKE_NPM_TOKEN_NO_PROVENANCE && userconfig && args.includes("--provenance")) { console.error("npm error 422 Unprocessable Entity - provenance statement does not match the publisher"); process.exit(1); }
  const text = fs.statSync(args[1]).isDirectory() ? fs.readFileSync(path.join(args[1], "package.json"), "utf-8") : execFileSync("tar", ["-xzOf", args[1], "package/package.json"], { encoding: "utf-8" });
  const { name, version } = JSON.parse(text);
  const p = reg.packages[name] || (reg.packages[name] = { versions: [], distTags: {} });
  if (p.versions.includes(version)) { console.error("npm error 403 You cannot publish over the previously published versions: " + version); process.exit(1); }
  p.versions.push(version);
  for (const pair of (process.env.FAKE_NPM_LAG || "").split(",").filter(Boolean)) {
    const eq = pair.lastIndexOf("=");
    if (pair.slice(0, eq) === name) (p.lag || (p.lag = {}))[version] = Number(pair.slice(eq + 1));
  }
  p.distTags[flag("--tag") || "latest"] = version;
  if (!p.distTags.latest) p.distTags.latest = version;
  save();
  console.log("+ " + name + "@" + version);
} else if (args[0] === "view") {
  const [name, version] = split(args[1]);
  const p = reg.packages[name];
  if (!p) { console.error("npm error 404 Not Found - " + name); process.exit(1); }
  if (process.env.FAKE_NPM_VIEW_ERROR && name.includes(process.env.FAKE_NPM_VIEW_ERROR) && p.versions.includes(version)) { console.error("npm error code E500"); console.error("npm error 500 Internal Server Error - GET https://registry.example/" + name); process.exit(1); }
  if (p.lag && p.lag[version] > 0) {
    p.lag[version] -= 1; save();
    // A new package npm does not serve yet answers 404, as the real registry does.
    if (process.env.FAKE_NPM_LAG_404) { console.error("npm error code E404"); console.error("npm error 404 No match found for version " + version); process.exit(1); }
  }
  else if (p.versions.includes(version)) console.log(version);
} else if (args[0] === "dist-tag" && args[1] === "add") {
  const [name, version] = split(args[2]);
  if (process.env.FAKE_NPM_FAIL_TAG && name.includes(process.env.FAKE_NPM_FAIL_TAG)) { console.error("npm error 403 Forbidden - no permission to change dist-tags"); process.exit(1); }
  const p = reg.packages[name];
  if (!p || !p.versions.includes(version)) { console.error("npm error 404 " + args[2] + " is not in the npm registry"); process.exit(1); }
  p.distTags[args[3]] = version;
  save();
  console.log("+" + args[3] + ": " + args[2]);
} else if (args[0] === "install") {
  if (Number(process.env.FAKE_NPM_INSTALL_ETARGET || 0) > (reg.installs || 0)) {
    reg.installs = (reg.installs || 0) + 1; save();
    console.error("npm error code ETARGET"); console.error("npm error notarget No matching version found for a package"); process.exit(1);
  }
  const deps = JSON.parse(fs.readFileSync("package.json", "utf-8")).dependencies || {};
  for (const [name, version] of Object.entries(deps)) {
    const p = reg.packages[name];
    if (!p || !p.versions.includes(version)) { console.error("npm error 404 " + name + "@" + version + " is not in this registry"); process.exit(1); }
  }
  console.log("added " + Object.keys(deps).length + " packages");
} else if (args[0] === "audit" && args[1] === "signatures") {
  const n = Object.keys(JSON.parse(fs.readFileSync("package.json", "utf-8")).dependencies || {}).length;
  if (process.env.FAKE_NPM_AUDIT_FAIL) { console.error(n + " packages have invalid attestations"); process.exit(1); }
  console.log("audited " + n + " packages");
  console.log(n + " packages have verified registry signatures");
  console.log(n + " packages have verified attestations");
} else {
  console.error("fake npm: unknown command " + args.join(" ")); process.exit(2);
}
`,
  );
  chmodSync(file, 0o755);
  return file;
}

/** A forge release as {@link startFakeForge} keeps it. */
export interface FakeForgeRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  target: string;
  assets: Array<{ name: string; digest: string | null; bytes: string }>;
}

/** A forge fake answering through `fetch`: GitHub or Forgejo with draft releases, or GitLab with releases, links and a generic package registry. */
export interface FakeForge {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array | string }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;
  calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: Uint8Array | string }>;
  releases: FakeForgeRelease[];
  /** GitLab: the package registry's files, by URL. */
  packages: Map<string, string>;
  /** The releases a consumer sees: published (not draft) ones, with their asset names. */
  visible(): Array<{ tag: string; assets: string[] }>;
  /** Make the next request whose `METHOD url` starts with `prefix` answer 500. */
  failOnce(prefix: string): void;
}

/** A forge fake at `api` for `repo`, which holds `releases` to begin with. */
export function startFakeForge(forge: "github" | "forgejo" | "gitlab", api: string, repo: string, releases: FakeForgeRelease[] = []): FakeForge {
  const calls: FakeForge["calls"] = [];
  const packages = new Map<string, string>();
  const failures: string[] = [];
  let nextId = 100 + releases.length;
  const root = forge === "gitlab" ? `${api}/projects/${encodeURIComponent(repo)}` : `${api}/repos/${repo}`;
  const uploads = forge === "github" ? "https://uploads.forge.test" : api;
  const json = (status: number, body: unknown) => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
  const view = (r: FakeForgeRelease) =>
    forge === "gitlab"
      ? { tag_name: r.tag_name, assets: { links: r.assets.map((a) => ({ name: a.name })) } }
      : { id: r.id, tag_name: r.tag_name, draft: r.draft, upload_url: `${uploads}/repos/${repo}/releases/${r.id}/assets{?name,label}`, assets: r.assets.map((a) => ({ name: a.name, ...(forge === "github" ? { digest: a.digest } : {}) })) };
  const text = (b: Uint8Array | string | undefined) => (b === undefined ? "" : typeof b === "string" ? b : Buffer.from(b).toString("utf-8"));
  const fetch: FakeForge["fetch"] = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    const key = `${init.method} ${url}`;
    const f = failures.findIndex((p) => key.startsWith(p));
    if (f >= 0) {
      failures.splice(f, 1);
      return json(500, { message: "Internal Server Error" });
    }
    const u = new URL(url);
    const path = url.split("?")[0]!;
    if (forge === "gitlab") {
      if (init.method === "PUT" && path.startsWith(`${root}/packages/generic/`)) {
        packages.set(path, text(init.body));
        return json(201, { message: "201 Created" });
      }
      const byTag = path.startsWith(`${root}/releases/`) ? decodeURIComponent(path.slice(`${root}/releases/`.length)) : null;
      if (init.method === "GET" && byTag !== null) {
        const r = releases.find((x) => x.tag_name === byTag);
        return r ? json(200, view(r)) : json(404, { message: "404 Not Found" });
      }
      if (init.method === "POST" && path === `${root}/releases`) {
        const b = JSON.parse(text(init.body)) as { tag_name: string; ref: string; assets?: { links?: Array<{ name: string; url: string }> } };
        if (releases.some((x) => x.tag_name === b.tag_name)) return json(409, { message: "Release already exists" });
        const r: FakeForgeRelease = { id: nextId++, tag_name: b.tag_name, draft: false, target: b.ref, assets: (b.assets?.links ?? []).map((l) => ({ name: l.name, digest: null, bytes: packages.get(l.url) ?? "" })) };
        releases.push(r);
        return json(201, view(r));
      }
      return json(404, { message: "404 Not Found" });
    }
    if (init.method === "GET" && path.startsWith(`${root}/releases/tags/`)) {
      const tag = decodeURIComponent(path.slice(`${root}/releases/tags/`.length));
      const r = releases.find((x) => x.tag_name === tag && !x.draft);
      return r ? json(200, view(r)) : json(404, { message: "Not Found" });
    }
    if (init.method === "GET" && path === `${root}/releases`) return json(200, releases.map(view));
    if (init.method === "POST" && path === `${root}/releases`) {
      const b = JSON.parse(text(init.body)) as { tag_name: string; target_commitish: string; draft?: boolean };
      const r: FakeForgeRelease = { id: nextId++, tag_name: b.tag_name, draft: b.draft === true, target: b.target_commitish, assets: [] };
      releases.push(r);
      return json(201, view(r));
    }
    const asset = path.match(/\/releases\/(\d+)\/assets$/);
    if (init.method === "POST" && asset && (path.startsWith(uploads) || path.startsWith(root))) {
      const r = releases.find((x) => x.id === Number(asset[1]));
      const name = u.searchParams.get("name") ?? "";
      if (!r) return json(404, { message: "Not Found" });
      if (r.assets.some((a) => a.name === name)) return json(422, { message: "already_exists" });
      let bytes = text(init.body);
      if (forge === "forgejo") bytes = bytes.split("\r\n\r\n")[1]?.split("\r\n--")[0] ?? "";
      r.assets.push({ name, digest: sha(bytes), bytes });
      return json(201, { name, browser_download_url: `https://forge.test/${repo}/releases/download/${r.tag_name}/${name}` });
    }
    const edit = path.match(/\/releases\/(\d+)$/);
    if (init.method === "PATCH" && edit) {
      const r = releases.find((x) => x.id === Number(edit[1]));
      if (!r) return json(404, { message: "Not Found" });
      const b = JSON.parse(text(init.body)) as { draft?: boolean };
      if (b.draft === false) r.draft = false;
      return json(200, view(r));
    }
    return json(404, { message: "Not Found" });
  };
  return {
    fetch,
    calls,
    releases,
    packages,
    visible: () => releases.filter((r) => !r.draft).map((r) => ({ tag: r.tag_name, assets: r.assets.map((a) => a.name) })),
    failOnce: (prefix) => void failures.push(prefix),
  };
}

/** A small SPDX document, as `npm sbom --sbom-format spdx` writes one. */
export function spdxDocument(name: string): string {
  return `${JSON.stringify({ spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT", name, documentNamespace: `https://example.test/${name}`, creationInfo: { created: "2026-10-17T00:00:00Z", creators: ["Tool: npm"] }, packages: [] }, null, 2)}\n`;
}

/** Write an npm package directory, with an `sbom.spdx.json` at its root unless `sbom` is false (#4049). */
export function writePackage(dir: string, name: string, version: string, sbom = true): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }, null, 2));
  if (sbom) writeFileSync(join(dir, "sbom.spdx.json"), spdxDocument(name));
}

/** Write a `package-lock.json` at `dir`, which the OCI and forge targets write their SBOM from (#4049). */
export function writeLockfile(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({ name: "acme", lockfileVersion: 3, packages: { "": { name: "acme" }, "node_modules/left-pad": { version: "1.3.0" } } }, null, 2),
  );
}
