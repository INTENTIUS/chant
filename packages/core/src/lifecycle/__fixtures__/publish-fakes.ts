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

/** GHCR's answer to a blob PUT it refuses intermittently (#4877). */
export const GHCR_DENIED = JSON.stringify({ errors: [{ code: "DENIED", message: "permission_denied: write_package" }] });

/**
 * Faults the registry fake can inject (#4877): `denyPuts` refuses that many
 * blob PUTs with GHCR's 403 body before it accepts one; `expireTokenAfter`
 * makes the token it handed out expire after that many accepted blob PUTs,
 * so the next request is answered 401 with the challenge again, and a new
 * token is issued.
 */
export interface FakeRegistryFaults {
  denyPuts?: number;
  expireTokenAfter?: number;
}

/** A registry fake with a Bearer token service that accepts `username` and `password`. */
export async function startFakeRegistry(creds: { username: string; password: string; token: string }, faults: FakeRegistryFaults = {}): Promise<FakeRegistry> {
  const blobs = new Map<string, Buffer>();
  const manifests = new Map<string, { name: string; type: string; bytes: Buffer }>();
  const requests: FakeRegistry["requests"] = [];
  const state = { uploads: 0, port: 0, denied: 0, token: creds.token, tokens: 0 };
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
      state.token = state.tokens === 0 ? creds.token : `${creds.token}-${state.tokens}`;
      state.tokens++;
      return send(200, { "content-type": "application/json" }, JSON.stringify({ token: state.token }));
    }
    if (req.headers.authorization !== `Bearer ${state.token}`) {
      return send(401, { "www-authenticate": `Bearer realm="http://127.0.0.1:${state.port}/token",service="fake-registry"` }, "unauthorized");
    }
    let m = url.pathname.match(/^\/v2\/(.+)\/blobs\/uploads\/(.*)$/);
    if (m) {
      if (req.method === "POST") return send(202, { location: `/v2/${m[1]}/blobs/uploads/u${requests.length}?_state=s` });
      const digest = url.searchParams.get("digest") ?? "";
      if (req.method === "PUT" && state.denied < (faults.denyPuts ?? 0)) {
        state.denied++;
        return send(403, { "content-type": "application/json" }, GHCR_DENIED);
      }
      if (req.method === "PUT" && sha(body) === digest && url.searchParams.get("_state") === "s") {
        blobs.set(digest, body);
        state.uploads++;
        if (faults.expireTokenAfter !== undefined && state.uploads === faults.expireTokenAfter) state.token = "expired";
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
  packages: Record<string, { versions: string[]; distTags: Record<string, string>; deprecated?: Record<string, string> }>;
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
 * - `view <name> versions --json` (#5154) prints every version it holds, as
 *   npm does: a string for one, an array for several; E404 for none.
 * - `view <name> dist-tags.<tag>` (#5136) prints the version the tag names.
 *   `$FAKE_NPM_TAG_LAG`, `<name>=<n>[,...]`: the first `n` such views of that
 *   name print nothing, as a registry whose tag has not propagated yet.
 * - `dist-tag add <name>@<version> <tag>` points the tag at a version that is
 *   there. It exits 1 when the name contains `$FAKE_NPM_FAIL_TAG`.
 * - `deprecate <name>@<version> <message>` (#5163) keeps the message on the
 *   version, and an empty message clears it.
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
} else if (args[0] === "view" && args[2] && args[2].startsWith("dist-tags.")) {
  const name = args[1];
  const p = reg.packages[name];
  if (!p) { console.error("npm error code E404"); console.error("npm error 404 Not Found - " + name); process.exit(1); }
  const lag = (process.env.FAKE_NPM_TAG_LAG || "").split(",").filter(Boolean).find((pair) => pair.slice(0, pair.lastIndexOf("=")) === name);
  reg.tagViews = reg.tagViews || {};
  reg.tagViews[name] = (reg.tagViews[name] || 0) + 1; save();
  if (lag && reg.tagViews[name] <= Number(lag.slice(lag.lastIndexOf("=") + 1))) process.exit(0);
  const tag = p.distTags[args[2].slice("dist-tags.".length)];
  if (tag) console.log(tag);
} else if (args[0] === "view" && args[2] === "versions") {
  // #5154: every version the registry holds, as npm prints it with --json.
  const p = reg.packages[args[1]];
  if (!p) { console.error("npm error code E404"); console.error("npm error 404 Not Found - " + args[1]); process.exit(1); }
  console.log(JSON.stringify(p.versions.length === 1 ? p.versions[0] : p.versions));
} else if (args[0] === "view" && args[2] === "version" && args[1].lastIndexOf("@") <= 0) {
  // #5230: a view of a bare name asks whether the package was ever published.
  const p = reg.packages[args[1]];
  if (!p) { console.error("npm error code E404"); console.error("npm error 404 Not Found - " + args[1]); process.exit(1); }
  console.log(p.distTags.latest || p.versions[p.versions.length - 1] || "");
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
} else if (args[0] === "deprecate") {
  const [name, version] = split(args[1]);
  const p = reg.packages[name];
  if (!p || !p.versions.includes(version)) { console.error("npm error 404 " + args[1] + " is not in the npm registry"); process.exit(1); }
  p.deprecated = p.deprecated || {};
  if (args[2]) p.deprecated[version] = args[2]; else delete p.deprecated[version];
  save();
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
  // FAKE_NPM_ATTESTATION_404=N answers the first N audits with the registry's attestation 404 ("always" never stops).
  const lateAttest = process.env.FAKE_NPM_ATTESTATION_404;
  if (lateAttest) {
    const seen = fs.existsSync(".audit-count") ? Number(fs.readFileSync(".audit-count", "utf-8")) : 0;
    fs.writeFileSync(".audit-count", String(seen + 1));
    if (lateAttest === "always" || seen < Number(lateAttest)) {
      console.error("npm error 404 Not Found - GET https://registry.npmjs.org/-/npm/v1/attestations/@acme%2fcore@1.0.0 - Not found");
      process.exit(1);
    }
  }
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
  name?: string;
  /** GitHub: the `make_latest` the release was published with. */
  make_latest?: string;
  /** The release's notes: GitHub's and Forgejo's `body`, GitLab's `description` (#4658). */
  body?: string;
  /** Forgejo: published as a prerelease. */
  prerelease?: boolean;
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
  /** GitHub and Forgejo: the repository's tags, each the commit it names. Publishing a release makes its tag at its target when there is none. */
  tags: Map<string, string>;
  /** The notes the forge generates (#5153): GitHub's `generate-notes` body, GitLab's changelog. Default: one naming the request. */
  generatedNotes?: (req: Record<string, string>) => string;
}

/** A forge fake at `api` for `repo`, which holds `releases` to begin with. */
export function startFakeForge(forge: "github" | "forgejo" | "gitlab", api: string, repo: string, releases: FakeForgeRelease[] = []): FakeForge {
  const calls: FakeForge["calls"] = [];
  const tags = new Map<string, string>(releases.filter((r) => !r.draft).map((r) => [r.tag_name, r.target]));
  const packages = new Map<string, string>();
  const failures: string[] = [];
  let nextId = 100 + releases.length;
  const root = forge === "gitlab" ? `${api}/projects/${encodeURIComponent(repo)}` : `${api}/repos/${repo}`;
  const uploads = forge === "github" ? "https://uploads.forge.test" : api;
  const json = (status: number, body: unknown) => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
  const view = (r: FakeForgeRelease) =>
    forge === "gitlab"
      ? { tag_name: r.tag_name, assets: { links: r.assets.map((a) => ({ name: a.name })) } }
      : { id: r.id, tag_name: r.tag_name, name: r.name ?? r.tag_name, draft: r.draft, prerelease: r.prerelease === true, ...(r.body !== undefined ? { body: r.body } : {}), upload_url: `${uploads}/repos/${repo}/releases/${r.id}/assets{?name,label}`, assets: r.assets.map((a) => ({ name: a.name, ...(forge === "github" ? { digest: a.digest } : {}) })) };
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
    const generated = (req: Record<string, string>) => (fake.generatedNotes ? fake.generatedNotes(req) : `generated: ${Object.entries(req).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    if (forge === "gitlab") {
      if (init.method === "GET" && path === `${root}/repository/changelog`) return json(200, { notes: generated(Object.fromEntries(u.searchParams)) });
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
        const b = JSON.parse(text(init.body)) as { tag_name: string; ref: string; description?: string; assets?: { links?: Array<{ name: string; url: string }> } };
        if (releases.some((x) => x.tag_name === b.tag_name)) return json(409, { message: "Release already exists" });
        const r: FakeForgeRelease = { id: nextId++, tag_name: b.tag_name, draft: false, target: b.ref, assets: (b.assets?.links ?? []).map((l) => ({ name: l.name, digest: null, bytes: packages.get(l.url) ?? "" })), ...(b.description !== undefined ? { body: b.description } : {}) };
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
    if (forge === "github" && init.method === "POST" && path === `${root}/releases/generate-notes`) return json(200, { name: "notes", body: generated(JSON.parse(text(init.body)) as Record<string, string>) });
    if (init.method === "POST" && path === `${root}/releases`) {
      const b = JSON.parse(text(init.body)) as { tag_name: string; target_commitish: string; draft?: boolean; name?: string; body?: string };
      const r: FakeForgeRelease = { id: nextId++, tag_name: b.tag_name, draft: b.draft === true, target: b.target_commitish, assets: [], ...(b.name ? { name: b.name } : {}), ...(b.body !== undefined ? { body: b.body } : {}) };
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
      const b = JSON.parse(text(init.body)) as { draft?: boolean; make_latest?: string; body?: string; prerelease?: boolean };
      if (b.body !== undefined) r.body = b.body;
      if (b.prerelease !== undefined) r.prerelease = b.prerelease;
      if (b.draft === false && r.draft) {
        if (releases.some((x) => x !== r && !x.draft && x.tag_name === r.tag_name)) return json(422, { message: "Validation Failed", errors: [{ code: "already_exists", field: "tag_name" }] });
        r.draft = false;
        if (!tags.has(r.tag_name)) tags.set(r.tag_name, r.target);
        if (b.make_latest !== undefined) r.make_latest = b.make_latest;
      } else if (b.draft === true) {
        r.draft = true;
      } else if (b.make_latest !== undefined) {
        r.make_latest = b.make_latest;
      }
      return json(200, view(r));
    }
    if (init.method === "DELETE" && edit) {
      const i = releases.findIndex((x) => x.id === Number(edit[1]));
      if (i < 0) return json(404, { message: "Not Found" });
      releases.splice(i, 1);
      return json(204, undefined);
    }
    const tagRef = path.startsWith(`${root}/git/refs/tags/`) ? decodeURIComponent(path.slice(`${root}/git/refs/tags/`.length)) : null;
    if (init.method === "DELETE" && tagRef !== null) {
      if (!tags.has(tagRef)) return json(422, { message: "Reference does not exist" });
      tags.delete(tagRef);
      return json(204, undefined);
    }
    return json(404, { message: "Not Found" });
  };
  const fake: FakeForge = {
    fetch,
    calls,
    releases,
    packages,
    visible: () => releases.filter((r) => !r.draft).map((r) => ({ tag: r.tag_name, assets: r.assets.map((a) => a.name) })),
    failOnce: (prefix) => void failures.push(prefix),
    tags,
  };
  return fake;
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

/** A GitHub repository fake answering through `fetch` (#4676): branches, commits of whole files, and the contents and refs APIs. */
export interface FakeGitHubRepo {
  fetch: FakeForge["fetch"];
  calls: FakeForge["calls"];
  /** The branches, each the sha of its commit. */
  branches: Map<string, string>;
  /** The file `path` on `branch`, or undefined. */
  read(branch: string, path: string): string | undefined;
  /** Commit `files` onto `branch` as someone else would, moving it. */
  push(branch: string, files: Record<string, string>): void;
  /** Each commit's message, oldest first, on `branch`'s history. */
  log(branch: string): string[];
}

/** A repository fake at `api` for `repo` whose `branch` holds `files`. */
export function startFakeGitHubRepo(api: string, repo: string, branch: string, files: Record<string, string>): FakeGitHubRepo {
  const calls: FakeGitHubRepo["calls"] = [];
  const commits = new Map<string, { parent: string | null; message: string; files: Map<string, string> }>();
  const branches = new Map<string, string>();
  let n = 0;
  const commit = (parent: string | null, message: string, change: Record<string, string>) => {
    const base = parent ? commits.get(parent)!.files : new Map<string, string>();
    const sha = createHash("sha1").update(`commit ${n++}`).digest("hex");
    commits.set(sha, { parent, message, files: new Map([...base, ...Object.entries(change)]) });
    return sha;
  };
  branches.set(branch, commit(null, "init", files));
  const blob = (text: string) => createHash("sha1").update(`blob ${text}`).digest("hex");
  const ancestor = (a: string, b: string) => {
    for (let c: string | null = b; c; c = commits.get(c)?.parent ?? null) if (c === a) return true;
    return false;
  };
  const json = (status: number, body?: unknown) => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
  const root = `${api}/repos/${repo}`;
  const fetch: FakeGitHubRepo["fetch"] = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    const u = new URL(url);
    const path = url.split("?")[0]!;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (init.method === "GET" && path === root) return json(200, { default_branch: branch });
    const ref = path.match(/\/git\/refs?\/heads\/(.+)$/);
    if (ref && path.startsWith(root)) {
      const name = decodeURIComponent(ref[1]!);
      const at = branches.get(name);
      if (init.method === "GET") return at ? json(200, { ref: `refs/heads/${name}`, object: { sha: at } }) : json(404, { message: "Not Found" });
      if (!at) return json(422, { message: "Reference does not exist" });
      if (init.method === "DELETE") return void branches.delete(name), json(204);
      if (init.method === "PATCH") {
        const to = String(body.sha);
        if (!commits.has(to)) return json(422, { message: "Object does not exist" });
        if (body.force !== true && !ancestor(at, to)) return json(422, { message: "Update is not a fast forward" });
        branches.set(name, to);
        return json(200, { object: { sha: to } });
      }
    }
    if (init.method === "POST" && path === `${root}/git/refs`) {
      const name = String(body.ref).replace(/^refs\/heads\//, "");
      if (branches.has(name)) return json(422, { message: "Reference already exists" });
      branches.set(name, String(body.sha));
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    const contents = path.startsWith(`${root}/contents/`) ? path.slice(`${root}/contents/`.length).split("/").map(decodeURIComponent).join("/") : null;
    if (init.method === "GET" && path === `${root}/commits`) {
      // #5163: the commits of a branch that touch a path, newest first.
      const file = u.searchParams.get("path") ?? "";
      const out: Array<{ sha: string }> = [];
      for (let c: string | null = branches.get(u.searchParams.get("sha") ?? branch) ?? null; c; c = commits.get(c)!.parent) {
        const parent = commits.get(c)!.parent;
        if (commits.get(c)!.files.get(file) !== (parent ? commits.get(parent)!.files.get(file) : undefined)) out.push({ sha: c });
      }
      return json(200, out);
    }
    if (contents !== null && init.method === "GET") {
      const r = u.searchParams.get("ref") ?? branch;
      const at = branches.get(r) ?? (commits.has(r) ? r : undefined);
      const text = at ? commits.get(at)!.files.get(contents) : undefined;
      return text === undefined ? json(404, { message: "Not Found" }) : json(200, { sha: blob(text), encoding: "base64", content: Buffer.from(text).toString("base64") });
    }
    if (contents !== null && init.method === "PUT") {
      const on = String(body.branch);
      const at = branches.get(on);
      if (!at) return json(404, { message: "Branch not found" });
      const current = commits.get(at)!.files.get(contents);
      if ((current === undefined ? undefined : blob(current)) !== body.sha) return json(409, { message: "sha does not match" });
      const sha = commit(at, String(body.message), { [contents]: Buffer.from(String(body.content), "base64").toString("utf-8") });
      branches.set(on, sha);
      return json(current === undefined ? 201 : 200, { content: { sha: blob(contents) }, commit: { sha } });
    }
    return json(404, { message: "Not Found" });
  };
  return {
    fetch,
    calls,
    branches,
    read: (b, p) => {
      const at = branches.get(b);
      return at ? commits.get(at)!.files.get(p) : undefined;
    },
    push: (b, change) => void branches.set(b, commit(branches.get(b)!, "someone else", change)),
    log: (b) => {
      const out: string[] = [];
      for (let c: string | null = branches.get(b) ?? null; c; c = commits.get(c)!.parent) out.unshift(commits.get(c)!.message);
      return out;
    },
  };
}

/** One entry of a fake GitHub tree: a file's text, or a submodule's commit. */
export type FakeEntry = { text: string } | { gitlink: string };

/** GitHub with several repositories over one object store, as a fork network has (#5158). */
export interface FakeGitHub {
  fetch: FakeForge["fetch"];
  calls: FakeForge["calls"];
  /** Make `repo` with `branch` holding `files` (a string is a file's text, `{ gitlink }` a submodule). */
  repo(repo: string, branch: string, files: Record<string, string | { gitlink: string }>): void;
  /** The head of `branch` of `repo`, or undefined. */
  head(repo: string, branch: string): string | undefined;
  /** The file at `path` on `ref` (a branch of `repo`, or a commit), or undefined. */
  read(repo: string, ref: string, path: string): string | undefined;
  /** The submodule's commit at `path` on `ref`, or undefined. */
  gitlink(repo: string, ref: string, path: string): string | undefined;
  /** The commit's message and parent. */
  commit(sha: string): { message: string; parent: string | null } | undefined;
  /** Commit `files` onto `branch` of `repo` as someone else would. */
  push(repo: string, branch: string, files: Record<string, string>): void;
  /** Every repository's name. */
  repos(): string[];
  pulls: Array<{ number: number; repo: string; head: string; base: string; title: string; body: string; state: "open" | "closed"; merged: boolean }>;
}

/**
 * A GitHub fake for the index target (#5158): `GET /user` names `user`; the
 * repository, refs, contents (files and submodules), git data (blobs, trees,
 * commits), fork and pull request APIs. A fork made by `POST .../forks`
 * answers 404 to its first `forkDelay` reads, as GitHub makes forks in the
 * background.
 */
export function startFakeGitHub(api: string, opts: { user: string; forkDelay?: number; scopes?: string | null }): FakeGitHub {
  const calls: FakeGitHub["calls"] = [];
  const commits = new Map<string, { parent: string | null; message: string; tree: Map<string, FakeEntry> }>();
  const trees = new Map<string, Map<string, FakeEntry>>();
  const blobs = new Map<string, string>();
  const repos = new Map<string, { defaultBranch: string; branches: Map<string, string>; fork: boolean; hiddenReads: number }>();
  const pulls: FakeGitHub["pulls"] = [];
  let n = 0;
  const id = (what: string) => createHash("sha1").update(`${what} ${n++}`).digest("hex");
  const commitOf = (parent: string | null, message: string, tree: Map<string, FakeEntry>) => {
    const sha = id("commit");
    commits.set(sha, { parent, message, tree });
    trees.set(`t${sha}`, tree);
    return sha;
  };
  const entries = (files: Record<string, string | { gitlink: string }>) => new Map<string, FakeEntry>(Object.entries(files).map(([p, v]) => [p, typeof v === "string" ? { text: v } : v]));
  const resolve = (repo: string, ref: string) => repos.get(repo)?.branches.get(ref) ?? (commits.has(ref) ? ref : undefined);
  const blobSha = (text: string) => createHash("sha1").update(`blob ${text}`).digest("hex");
  const headers = { get: (name: string) => (name.toLowerCase() === "x-oauth-scopes" && opts.scopes !== undefined && opts.scopes !== null ? opts.scopes : null) };
  const json = (status: number, body?: unknown) => ({ ok: status < 300, status, headers, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
  const fetch: FakeGitHub["fetch"] = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    const u = new URL(url);
    const path = url.split("?")[0]!;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (path === `${api}/user` && init.method === "GET") return json(200, { login: opts.user });
    const m = path.slice(api.length).match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    if (!m) return json(404, { message: "Not Found" });
    const name = m[1]!;
    const rest = m[2] ?? "";
    const r = repos.get(name);
    if (r && r.hiddenReads > 0 && init.method === "GET" && rest === "") {
      r.hiddenReads--;
      return json(404, { message: "Not Found" });
    }
    if (rest === "/forks" && init.method === "POST") {
      if (!r) return json(404, { message: "Not Found" });
      const forkName = `${opts.user}/${name.split("/")[1]}`;
      if (forkName === name) return json(403, { message: "cannot fork your own repository" });
      if (!repos.has(forkName)) repos.set(forkName, { defaultBranch: r.defaultBranch, branches: new Map([[r.defaultBranch, r.branches.get(r.defaultBranch)!]]), fork: true, hiddenReads: opts.forkDelay ?? 0 });
      return json(202, { full_name: forkName });
    }
    if (!r) return json(404, { message: "Not Found" });
    if (rest === "" && init.method === "GET") return json(200, { full_name: name, default_branch: r.defaultBranch, fork: r.fork, permissions: { push: name.startsWith(`${opts.user}/`) } });
    const ref = rest.match(/^\/git\/refs?\/heads\/(.+)$/);
    if (ref) {
      const branch = decodeURIComponent(ref[1]!);
      const at = r.branches.get(branch);
      if (init.method === "GET") return at ? json(200, { ref: `refs/heads/${branch}`, object: { sha: at } }) : json(404, { message: "Not Found" });
      if (!at) return json(422, { message: "Reference does not exist" });
      if (init.method === "DELETE") return void r.branches.delete(branch), json(204);
      if (init.method === "PATCH") {
        const to = String(body.sha);
        if (!commits.has(to)) return json(422, { message: "Object does not exist" });
        let ancestor = false;
        for (let c: string | null = to; c; c = commits.get(c)?.parent ?? null) if (c === at) ancestor = true;
        if (body.force !== true && !ancestor) return json(422, { message: "Update is not a fast forward" });
        r.branches.set(branch, to);
        return json(200, { object: { sha: to } });
      }
    }
    if (rest === "/git/refs" && init.method === "POST") {
      const branch = String(body.ref).replace(/^refs\/heads\//, "");
      if (r.branches.has(branch)) return json(422, { message: "Reference already exists" });
      if (!commits.has(String(body.sha))) return json(422, { message: "Object does not exist" });
      r.branches.set(branch, String(body.sha));
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    const gc = rest.match(/^\/git\/commits\/([0-9a-f]+)$/);
    if (gc && init.method === "GET") return commits.has(gc[1]!) ? json(200, { sha: gc[1], tree: { sha: `t${gc[1]}` } }) : json(404, { message: "Not Found" });
    if (rest === "/git/blobs" && init.method === "POST") {
      const text = Buffer.from(String(body.content), "base64").toString("utf-8");
      const sha = blobSha(text);
      blobs.set(sha, text);
      return json(201, { sha });
    }
    if (rest === "/git/trees" && init.method === "POST") {
      const base = trees.get(String(body.base_tree));
      if (!base) return json(422, { message: "base_tree not found" });
      const tree = new Map(base);
      for (const e of body.tree as Array<{ path: string; mode: string; sha: string | null }>) {
        if (e.sha === null) tree.delete(e.path);
        else if (e.mode === "160000") tree.set(e.path, { gitlink: e.sha });
        else if (blobs.has(e.sha)) tree.set(e.path, { text: blobs.get(e.sha)! });
        else return json(422, { message: "blob not found" });
      }
      const sha = id("tree");
      trees.set(sha, tree);
      return json(201, { sha });
    }
    if (rest === "/git/commits" && init.method === "POST") {
      const tree = trees.get(String(body.tree));
      const parents = body.parents as string[];
      if (!tree || parents.length !== 1 || !commits.has(parents[0]!)) return json(422, { message: "bad commit" });
      const sha = id("commit");
      commits.set(sha, { parent: parents[0]!, message: String(body.message), tree });
      trees.set(`t${sha}`, tree);
      return json(201, { sha });
    }
    if (rest === "/commits" && init.method === "GET") {
      // #5163: the commits of a branch that touch a path, newest first.
      const file = u.searchParams.get("path") ?? "";
      const text = (c: string) => {
        const e = commits.get(c)!.tree.get(file);
        return e && "text" in e ? e.text : undefined;
      };
      const out: Array<{ sha: string }> = [];
      for (let c: string | null = resolve(name, u.searchParams.get("sha") ?? r.defaultBranch) ?? null; c; c = commits.get(c)!.parent) {
        const parent = commits.get(c)!.parent;
        if (text(c) !== (parent ? text(parent) : undefined)) out.push({ sha: c });
      }
      return json(200, out);
    }
    const contents = rest.startsWith("/contents/") ? rest.slice("/contents/".length).split("/").map(decodeURIComponent).join("/") : null;
    if (contents !== null && init.method === "GET") {
      const at = resolve(name, u.searchParams.get("ref") ?? r.defaultBranch);
      const e = at ? commits.get(at)!.tree.get(contents) : undefined;
      if (!e) return json(404, { message: "Not Found" });
      if ("gitlink" in e) return json(200, { type: "submodule", sha: e.gitlink });
      return json(200, { type: "file", sha: blobSha(e.text), encoding: "base64", content: Buffer.from(e.text).toString("base64") });
    }
    if (contents !== null && init.method === "PUT") {
      const on = String(body.branch);
      const at = r.branches.get(on);
      if (!at) return json(404, { message: "Branch not found" });
      const current = commits.get(at)!.tree.get(contents);
      if ((current && "text" in current ? blobSha(current.text) : undefined) !== body.sha) return json(409, { message: "sha does not match" });
      const tree = new Map(commits.get(at)!.tree);
      tree.set(contents, { text: Buffer.from(String(body.content), "base64").toString("utf-8") });
      const sha = commitOf(at, String(body.message), tree);
      r.branches.set(on, sha);
      return json(current === undefined ? 201 : 200, { commit: { sha } });
    }
    if (rest === "/pulls" && init.method === "GET") {
      const head = u.searchParams.get("head");
      return json(200, pulls.filter((p) => p.repo === name && (!head || p.head === head)).map((p) => ({ number: p.number, html_url: `https://github.test/${name}/pull/${p.number}`, state: p.state, merged_at: p.merged ? "2026-11-16T00:00:00Z" : null, head: { label: p.head } })));
    }
    if (rest === "/pulls" && init.method === "POST") {
      const head = String(body.head);
      const [owner, branch] = head.split(":");
      const from = [...repos.entries()].find(([k]) => k.split("/")[0] === owner && repos.get(k)!.branches.has(branch!));
      if (!from) return json(422, { message: "head not found" });
      if (pulls.some((p) => p.repo === name && p.head === head && p.state === "open")) return json(422, { message: "A pull request already exists" });
      const p = { number: pulls.length + 1, repo: name, head, base: String(body.base), title: String(body.title), body: String(body.body), state: "open" as const, merged: false };
      pulls.push(p);
      return json(201, { number: p.number, html_url: `https://github.test/${name}/pull/${p.number}`, state: "open", merged_at: null, head: { label: head } });
    }
    return json(404, { message: "Not Found" });
  };
  return {
    fetch,
    calls,
    pulls,
    repo: (repo, branch, files) => void repos.set(repo, { defaultBranch: branch, branches: new Map([[branch, commitOf(null, "init", entries(files))]]), fork: false, hiddenReads: 0 }),
    head: (repo, branch) => repos.get(repo)?.branches.get(branch),
    read: (repo, ref, p) => {
      const at = resolve(repo, ref);
      const e = at ? commits.get(at)!.tree.get(p) : undefined;
      return e && "text" in e ? e.text : undefined;
    },
    gitlink: (repo, ref, p) => {
      const at = resolve(repo, ref);
      const e = at ? commits.get(at)!.tree.get(p) : undefined;
      return e && "gitlink" in e ? e.gitlink : undefined;
    },
    commit: (sha) => {
      const c = commits.get(sha);
      return c ? { message: c.message, parent: c.parent } : undefined;
    },
    push: (repo, branch, files) => {
      const r = repos.get(repo)!;
      const at = r.branches.get(branch)!;
      r.branches.set(branch, commitOf(at, "someone else", new Map([...commits.get(at)!.tree, ...entries(files)])));
    },
    repos: () => [...repos.keys()],
  };
}
