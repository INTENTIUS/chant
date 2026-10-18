/**
 * The OCI publish target (#4047): an image pushed to an OCI registry, such
 * as GHCR or Docker Hub, by digest, then tagged.
 *
 * The image is an OCI image layout (`index.json` and `blobs/`), as a
 * directory or a tar file such as `docker save` writes. Its `index.json`
 * names one manifest: an image manifest, or an index of them. The target
 * speaks the registry HTTP API (the OCI distribution spec) through an
 * injectable `fetch`, so it needs no docker, crane or oras, and the tests
 * run it against a registry fake on 127.0.0.1. A publish is two steps
 * (#4048). The stage pushes by digest only: for each image manifest it
 * uploads the config and layers the registry does not hold yet, then puts
 * the manifest by its digest, then the index when there is one. A registry
 * that already holds the top manifest's digest is sent nothing. Every blob
 * is checked against its digest before it is sent. Nothing a consumer pulls
 * by tag changes until the reveal, which points each tag at that digest.
 *
 * Credentials come from `usernameEnv` and `passwordEnv` (default
 * `OCI_USERNAME`, `OCI_PASSWORD`), or else from the `auths` entry for the
 * registry in the docker config file (`$DOCKER_CONFIG/config.json` or
 * `~/.docker/config.json`), which `docker login` writes; a credential helper
 * (`credsStore`) is not read. With none, the push is anonymous. The registry
 * decides how they are used: a `Basic` challenge takes them as they are, and
 * a `Bearer` challenge (GHCR, Docker Hub) exchanges them for a token at the
 * realm it names. The password and the token are masked in all output.
 *
 * A host of `localhost`, `127.0.0.1` or `[::1]` is spoken to over http, as
 * docker does; any other over https. `docker.io` is `registry-1.docker.io`,
 * and a one-part Docker Hub name is under `library/`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredential, type Credential } from "./publish-credentials";
import type { OciPublishDeclaration } from "./publish-declaration";
import { bytesDigest, checkReleaseDigest, fileDigest, isDir, memberFile, publishTargetKey } from "./publish-targets";
import { PublishTargetError, type PublishContext, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget } from "./release-publish";

const INDEX_TYPES = new Set(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"]);

/** A repository reference split into where the registry is and the name in it. */
export interface OciRepository {
  /** The host as written, used to find docker config credentials. */
  host: string;
  /** `http(s)://<host>` the API is under. */
  base: string;
  /** The repository's name in the registry. */
  name: string;
}

export function parseRepository(repository: string): OciRepository {
  const parts = repository.split("/");
  const first = parts[0]!;
  const isHost = parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  let host = isHost ? first : "docker.io";
  let path = isHost ? parts.slice(1) : parts;
  if (host === "docker.io" || host === "index.docker.io") {
    host = "docker.io";
    if (path.length === 1) path = ["library", ...path];
  }
  const apiHost = host === "docker.io" ? "registry-1.docker.io" : host;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(apiHost);
  return { host, base: `${local ? "http" : "https"}://${apiHost}`, name: path.join("/") };
}

interface Descriptor {
  mediaType: string;
  digest: string;
  size?: number;
}

/** What a layout holds, in the order it is pushed. */
interface LayoutImage {
  top: Descriptor & { bytes: Uint8Array };
  /** The image manifests: one, or an index's children. */
  manifests: Array<Descriptor & { bytes: Uint8Array; blobs: Descriptor[] }>;
  configDigests: string[];
  readBlob(digest: string): Uint8Array;
  cleanup(): void;
}

function readLayout(abs: string): LayoutImage {
  let dir = abs;
  let tmp: string | null = null;
  if (!isDir(abs)) {
    tmp = mkdtempSync(join(tmpdir(), "chant-oci-"));
    try {
      execFileSync("tar", ["-xf", abs, "-C", tmp], { stdio: "ignore" });
    } catch {
      rmSync(tmp, { recursive: true, force: true });
      throw new PublishTargetError("publish-oci-not-a-layout", `${abs} is neither an OCI image layout directory nor a tar file of one`);
    }
    dir = tmp;
  }
  const cleanup = () => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  };
  try {
    const readBlob = (digest: string): Uint8Array => {
      const [alg, hex] = digest.split(":");
      const file = join(dir, "blobs", alg ?? "", hex ?? "");
      if (!alg || !hex || !existsSync(file)) throw new PublishTargetError("publish-oci-not-a-layout", `the layout has no blob ${digest}`);
      const bytes = readFileSync(file);
      if (bytesDigest(bytes) !== digest) throw new PublishTargetError("publish-oci-blob-corrupt", `blob ${digest} in the layout does not match its digest`);
      return bytes;
    };
    const indexFile = join(dir, "index.json");
    if (!existsSync(indexFile)) throw new PublishTargetError("publish-oci-not-a-layout", `${abs} has no index.json, so it is not an OCI image layout`);
    const index = JSON.parse(readFileSync(indexFile, "utf-8")) as { manifests?: Descriptor[] };
    const tops = index.manifests ?? [];
    if (tops.length !== 1) {
      throw new PublishTargetError("publish-oci-not-one-image", `${abs} names ${tops.length} manifests in its index.json, and a target pushes one image`, "Save one image per layout.");
    }
    const topDesc = tops[0]!;
    const topBytes = readBlob(topDesc.digest);
    const manifests: LayoutImage["manifests"] = [];
    const configDigests: string[] = [];
    const image = (d: Descriptor, bytes: Uint8Array) => {
      const m = JSON.parse(Buffer.from(bytes).toString("utf-8")) as { config?: Descriptor; layers?: Descriptor[]; mediaType?: string };
      if (!m.config) throw new PublishTargetError("publish-oci-not-a-layout", `manifest ${d.digest} has no config`);
      configDigests.push(m.config.digest);
      manifests.push({ ...d, mediaType: d.mediaType ?? m.mediaType, bytes, blobs: [m.config, ...(m.layers ?? [])] });
    };
    const topParsed = JSON.parse(Buffer.from(topBytes).toString("utf-8")) as { mediaType?: string; manifests?: Descriptor[] };
    const topType = topDesc.mediaType ?? topParsed.mediaType ?? "application/vnd.oci.image.manifest.v1+json";
    if (INDEX_TYPES.has(topType)) {
      for (const child of topParsed.manifests ?? []) image(child, readBlob(child.digest));
    } else {
      image({ ...topDesc, mediaType: topType }, topBytes);
    }
    return { top: { ...topDesc, mediaType: topType, bytes: topBytes }, manifests, configDigests, readBlob, cleanup };
  } catch (err) {
    cleanup();
    if (err instanceof SyntaxError) throw new PublishTargetError("publish-oci-not-a-layout", `${abs} holds a manifest or index.json that is not JSON`);
    throw err;
  }
}

/** The credential for `repo`: the declared variables, else the docker config's `auths` entry. */
function ociCredential(decl: OciPublishDeclaration, repo: OciRepository, ctx: PublishContext): { username: string; password: Credential } | null {
  const password = readCredential(ctx.env, [decl.passwordEnv ?? "OCI_PASSWORD"], ctx.redactor);
  if (password) {
    const user = ctx.env[decl.usernameEnv ?? "OCI_USERNAME"];
    return { username: user && user !== "" ? user : "oauth2", password };
  }
  const dir = ctx.env.DOCKER_CONFIG ?? (ctx.env.HOME ? join(ctx.env.HOME, ".docker") : null);
  if (!dir || !existsSync(join(dir, "config.json"))) return null;
  try {
    const conf = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")) as { auths?: Record<string, { auth?: string }> };
    const keys = repo.host === "docker.io" ? ["https://index.docker.io/v1/", "docker.io", "index.docker.io"] : [repo.host, `https://${repo.host}`];
    for (const k of keys) {
      const auth = conf.auths?.[k]?.auth;
      if (!auth) continue;
      ctx.redactor.add(auth);
      const decoded = Buffer.from(auth, "base64").toString("utf-8");
      const at = decoded.indexOf(":");
      if (at < 0) continue;
      const value = decoded.slice(at + 1);
      ctx.redactor.add(value);
      return { username: decoded.slice(0, at), password: { value, from: "docker config" } };
    }
  } catch {
    // An unreadable docker config gives no credential.
  }
  return null;
}

/** A registry client that answers the registry's auth challenge once and keeps the token. */
class Registry {
  private auth: string | null = null;
  constructor(
    private readonly repo: OciRepository,
    private readonly fetch: PublishFetch,
    private readonly cred: { username: string; password: Credential } | null,
    private readonly ctx: PublishContext,
  ) {}

  private fail(what: string, status: number, body: string): never {
    throw new PublishTargetError("publish-oci-failed", this.ctx.redactor.redact(`${what} at ${this.repo.base} answered ${status}${body ? `: ${body.slice(0, 300)}` : ""}`));
  }

  async request(method: string, path: string, headers: Record<string, string> = {}, body?: Uint8Array): Promise<Awaited<ReturnType<PublishFetch>>> {
    const url = /^https?:\/\//.test(path) ? path : `${this.repo.base}${path}`;
    const send = () => this.fetch(url, { method, headers: { ...headers, ...(this.auth ? { authorization: this.auth } : {}) }, ...(body ? { body } : {}) });
    let res = await send();
    if (res.status === 401 && this.auth === null) {
      await this.answerChallenge(res.headers.get("www-authenticate") ?? "");
      res = await send();
    }
    return res;
  }

  private async answerChallenge(header: string): Promise<void> {
    const basic = this.cred ? `Basic ${Buffer.from(`${this.cred.username}:${this.cred.password.value}`).toString("base64")}` : null;
    if (basic) this.ctx.redactor.add(basic.slice(6));
    if (/^basic/i.test(header)) {
      if (!basic) throw new PublishTargetError("publish-credentials-missing", `${this.repo.base} asks for credentials, and none are set`, "Set OCI_USERNAME and OCI_PASSWORD, or the variables usernameEnv and passwordEnv name, or docker login.");
      this.auth = basic;
      return;
    }
    if (!/^bearer/i.test(header)) this.fail("the registry", 401, "with no challenge chant can answer");
    const params = Object.fromEntries([...header.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!.toLowerCase(), m[2]!]));
    if (!params.realm) this.fail("the registry", 401, "with a Bearer challenge that names no realm");
    const u = new URL(params.realm);
    if (params.service) u.searchParams.set("service", params.service);
    u.searchParams.set("scope", `repository:${this.repo.name}:pull,push`);
    const res = await this.fetch(u.toString(), { method: "GET", headers: basic ? { authorization: basic } : {} });
    const text = await res.text();
    if (!res.ok) this.fail("the token service", res.status, text);
    const json = JSON.parse(text) as { token?: string; access_token?: string };
    const token = json.token ?? json.access_token;
    if (!token) this.fail("the token service", res.status, "with no token");
    this.ctx.redactor.add(token);
    this.auth = `Bearer ${token}`;
  }

  /** Upload a blob unless the registry holds it. True when it was uploaded. */
  async pushBlob(digest: string, bytes: () => Uint8Array): Promise<boolean> {
    const head = await this.request("HEAD", `/v2/${this.repo.name}/blobs/${digest}`);
    if (head.status === 200) return false;
    const start = await this.request("POST", `/v2/${this.repo.name}/blobs/uploads/`, { "content-length": "0" });
    if (start.status !== 202) this.fail(`starting an upload of ${digest}`, start.status, await start.text());
    const location = start.headers.get("location");
    if (!location) this.fail(`starting an upload of ${digest}`, start.status, "with no Location");
    const abs = /^https?:\/\//.test(location) ? location : `${this.repo.base}${location.startsWith("/") ? "" : "/"}${location}`;
    const put = `${abs}${abs.includes("?") ? "&" : "?"}digest=${encodeURIComponent(digest)}`;
    const data = bytes();
    const done = await this.request("PUT", put, { "content-type": "application/octet-stream", "content-length": String(data.byteLength) }, data);
    if (done.status !== 201) this.fail(`uploading ${digest}`, done.status, await done.text());
    return true;
  }

  /** Whether the registry holds the manifest `digest`. */
  async hasManifest(digest: string, mediaType: string): Promise<boolean> {
    const res = await this.request("HEAD", `/v2/${this.repo.name}/manifests/${digest}`, { accept: mediaType });
    return res.status === 200;
  }

  async putManifest(ref: string, mediaType: string, bytes: Uint8Array): Promise<void> {
    const res = await this.request("PUT", `/v2/${this.repo.name}/manifests/${ref}`, { "content-type": mediaType }, bytes);
    if (res.status !== 201) this.fail(`putting manifest ${ref}`, res.status, await res.text());
  }
}

/** The tags to point at the digest: the context's tag when set, else the declared ones with `{label}` filled in. */
export function ociTags(decl: OciPublishDeclaration, ctx: Pick<PublishContext, "tag" | "label">): string[] {
  if (ctx.tag) return [ctx.tag];
  const declared = decl.tags ?? (ctx.label ? ["{label}"] : []);
  return declared.filter((t) => ctx.label !== null || !t.includes("{label}")).map((t) => t.split("{label}").join(ctx.label ?? ""));
}

export function ociTarget(decl: OciPublishDeclaration, deps: PublishDeps): PublishTarget {
  const repo = parseRepository(decl.repository);
  const fetchImpl: PublishFetch = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const inspect = (ctx: PublishContext) => {
    const abs = memberFile(ctx.cwd, decl.image);
    const layout = readLayout(abs);
    try {
      const identities = [layout.top.digest, ...layout.configDigests, ...(isDir(abs) ? [] : [fileDigest(abs)])];
      checkReleaseDigest(ctx.release, "image", ctx.cwd, decl.image, identities);
    } catch (err) {
      layout.cleanup();
      throw err;
    }
    return layout;
  };
  const item = (ctx: PublishContext, digest: string): PublishItem => {
    const tags = ociTags(decl, ctx);
    return {
      name: `${decl.image}${tags.length > 0 ? ` (tag${tags.length === 1 ? "" : "s"} ${tags.join(", ")})` : ""}`,
      destination: `${decl.repository}@${digest}`,
      digest,
    };
  };
  const connect = (ctx: PublishContext) => {
    const cred = ociCredential(decl, repo, ctx);
    return { cred, registry: new Registry(repo, fetchImpl, cred, ctx) };
  };
  return {
    kind: "oci",
    name: `oci ${decl.repository}`,
    destination: decl.repository,
    credentialEnv: [decl.passwordEnv ?? "OCI_PASSWORD"],
    key: publishTargetKey(decl),
    async plan(ctx) {
      const layout = inspect(ctx);
      layout.cleanup();
      return [item(ctx, layout.top.digest)];
    },
    async stage(ctx) {
      const layout = inspect(ctx);
      try {
        const { cred, registry } = connect(ctx);
        const staged = { ...item(ctx, layout.top.digest), name: decl.image };
        if (await registry.hasManifest(layout.top.digest, layout.top.mediaType)) {
          ctx.log(`${decl.repository} already holds ${layout.top.digest}; nothing pushed`);
          return { target: this.name, destination: this.destination, items: [{ ...staged, present: true }], state: {} };
        }
        ctx.log(`pushing ${decl.image} to ${decl.repository} by digest ${layout.top.digest}, ${cred ? `with credentials from ${cred.password.from}` : "anonymously"}; no tag moves yet`);
        let uploaded = 0;
        for (const m of layout.manifests) {
          for (const b of m.blobs) if (await registry.pushBlob(b.digest, () => layout.readBlob(b.digest))) uploaded++;
          await registry.putManifest(m.digest, m.mediaType, m.bytes);
        }
        if (INDEX_TYPES.has(layout.top.mediaType)) await registry.putManifest(layout.top.digest, layout.top.mediaType, layout.top.bytes);
        ctx.log(`  ${uploaded} blob(s) uploaded`);
        return { target: this.name, destination: this.destination, items: [staged], state: {} };
      } finally {
        layout.cleanup();
      }
    },
    async reveal(ctx) {
      const layout = inspect(ctx);
      try {
        const { registry } = connect(ctx);
        const tags = ociTags(decl, ctx);
        for (const t of tags) await registry.putManifest(t, layout.top.mediaType, layout.top.bytes);
        ctx.log(tags.length > 0 ? `tagged ${layout.top.digest} ${tags.join(", ")}` : `no tag to point at ${layout.top.digest}`);
        return { target: this.name, destination: this.destination, items: [item(ctx, layout.top.digest)] };
      } finally {
        layout.cleanup();
      }
    },
  };
}
