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
 * The stage also pushes, by digest, two referrers of the image (#4049): its
 * SBOM and the release's provenance statement (./publish-attachments.ts),
 * each an OCI artifact manifest whose `subject` is the image, so a registry
 * with the referrers API lists them under the image's digest and `oras
 * discover` or `cosign tree` finds them. A referrer the registry already
 * holds is not pushed again.
 *
 * When the publish signs (#5164, ./publish-signing.ts), the stage also
 * pushes a cosign signature and SLSA provenance of the image, each a Sigstore
 * bundle in an artifact manifest whose subject is the image. On a registry
 * without the referrers API (GHCR, Docker Hub) they are listed under the
 * referrers tag `sha256-<hex>`, as cosign does. An image that already has a
 * bundle with the same predicate type is not signed again.
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
import { IMAGE_SBOM_FILE, imageSbom, memberSbom, releaseProvenance, type Attachment } from "./publish-attachments";
import type { SbomDocument } from "../components/verbs/sbom-generator";
import { BUNDLE_PREDICATE_ANNOTATION, COSIGN_SIGN_PREDICATE, SIGSTORE_BUNDLE_MEDIA_TYPE, SLSA_PROVENANCE_PREDICATE, cosignSignStatement, slsaProvenanceStatement } from "./publish-signing";
import { readCredential, type Credential } from "./publish-credentials";
import { findingsAttachment, sbomDocumentOf } from "./publish-scan";
import type { OciPublishDeclaration } from "./publish-declaration";
import { bytesDigest, checkReleaseDigest, fileDigest, isDir, memberFile, publishTargetKey } from "./publish-targets";
import { trainName, waitUntilServed } from "./publish-train-names";
import { PublishTargetError, type PublishContext, type PublishContextBase, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget, type StatusAction, type StatusContext } from "./release-publish";
import { prereleaseOf } from "./release-prerelease";
import { NEXT_RELEASE } from "../release-floors";

/** The first chant whose oci target takes `platformTags`, a tag for each platform's image in the index (#5269). */
export const OCI_PLATFORM_TAGS_FLOOR = NEXT_RELEASE;

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
  /** An index entry's platform. */
  platform?: { os?: string; architecture?: string; variant?: string };
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
export function ociCredential(decl: Pick<OciPublishDeclaration, "usernameEnv" | "passwordEnv">, repo: OciRepository, ctx: Pick<PublishContext, "env" | "redactor">): { username: string; password: Credential } | null {
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

/** How many times an upload or a manifest is tried before the target fails (#4877). */
export const OCI_PUSH_ATTEMPTS = 4;
/** The wait before the second try, doubled for each try after it. */
export const OCI_PUSH_RETRY_MS = 2000;

/**
 * Whether a registry's answer to an upload or a manifest is worth trying
 * again (#4877): GHCR intermittently refuses a blob PUT with 403 `DENIED`
 * (`permission_denied: write_package`) under a token that pushed the blob
 * before it, and any registry can time out, throttle or fail.
 */
function retryable(status: number, body: string): boolean {
  return status === 408 || status === 429 || status >= 500 || (status === 403 && /"DENIED"/.test(body));
}

/** A registry's answer the target gave up on: what was asked, the status and the body. */
class RegistryAnswer extends Error {
  constructor(
    readonly what: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${what} answered ${status}`);
  }
}

/**
 * A registry client that answers the registry's auth challenge and keeps the
 * token. A 401 under a token it already holds, as when the registry's token
 * expires during a long push, is answered once more (#4877).
 */
export class Registry {
  private auth: string | null = null;
  constructor(
    private readonly repo: OciRepository,
    private readonly fetch: PublishFetch,
    private readonly cred: { username: string; password: Credential } | null,
    private readonly ctx: PublishContextBase,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  ) {}

  private fail(what: string, status: number, body: string): never {
    throw new PublishTargetError("publish-oci-failed", this.ctx.redactor.redact(`${what} at ${this.repo.base} answered ${status}${body ? `: ${body.slice(0, 300)}` : ""}`));
  }

  async request(method: string, path: string, headers: Record<string, string> = {}, body?: Uint8Array): Promise<Awaited<ReturnType<PublishFetch>>> {
    const url = /^https?:\/\//.test(path) ? path : `${this.repo.base}${path}`;
    const send = () => this.fetch(url, { method, headers: { ...headers, ...(this.auth ? { authorization: this.auth } : {}) }, ...(body ? { body } : {}) });
    let res = await send();
    if (res.status === 401) {
      const challenge = res.headers.get("www-authenticate") ?? "";
      if (this.auth !== null) {
        if (!challenge) return res;
        this.ctx.log(`${this.repo.base} asked for credentials again; answering its challenge once more`);
      }
      this.auth = null;
      await this.answerChallenge(challenge);
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

  /**
   * Run `attempt` up to {@link OCI_PUSH_ATTEMPTS} times while it fails with a
   * {@link retryable} answer or a dropped connection, waiting longer before
   * each try (#4877). Any other answer fails the target at once.
   */
  private async tries<T>(what: string, attempt: () => Promise<T>): Promise<T> {
    for (let n = 1; ; n++) {
      try {
        return await attempt();
      } catch (err) {
        const answer = err instanceof RegistryAnswer ? err : null;
        const dropped = !answer && !(err instanceof PublishTargetError);
        const again = n < OCI_PUSH_ATTEMPTS && (dropped || (answer !== null && retryable(answer.status, answer.body)));
        if (!again) {
          if (answer) this.fail(answer.what, answer.status, answer.body);
          throw err;
        }
        const why = answer ? `answered ${answer.status}${answer.body ? `: ${this.ctx.redactor.redact(answer.body.slice(0, 200))}` : ""}` : `failed: ${this.ctx.redactor.redact(err instanceof Error ? err.message : String(err))}`;
        const wait = OCI_PUSH_RETRY_MS * 2 ** (n - 1);
        this.ctx.log(`${what} at ${this.repo.base} ${why}; trying again in ${wait / 1000}s (${n + 1} of ${OCI_PUSH_ATTEMPTS})`);
        await this.sleep(wait);
      }
    }
  }

  /** Upload a blob unless the registry holds it. True when it was uploaded. */
  async pushBlob(digest: string, bytes: () => Uint8Array): Promise<boolean> {
    const head = await this.request("HEAD", `/v2/${this.repo.name}/blobs/${digest}`);
    if (head.status === 200) return false;
    await this.tries(`uploading ${digest}`, async () => {
      // A fresh upload session each try: a refused PUT may have ended the last one.
      const start = await this.request("POST", `/v2/${this.repo.name}/blobs/uploads/`, { "content-length": "0" });
      if (start.status !== 202) {
        const text = await start.text();
        // A refused POST means the credentials can't push here; that is not tried again.
        if (start.status === 401 || start.status === 403) this.fail(`starting an upload of ${digest}`, start.status, text);
        throw new RegistryAnswer(`starting an upload of ${digest}`, start.status, text);
      }
      const location = start.headers.get("location");
      if (!location) this.fail(`starting an upload of ${digest}`, start.status, "with no Location");
      const abs = /^https?:\/\//.test(location) ? location : `${this.repo.base}${location.startsWith("/") ? "" : "/"}${location}`;
      const put = `${abs}${abs.includes("?") ? "&" : "?"}digest=${encodeURIComponent(digest)}`;
      const data = bytes();
      const done = await this.request("PUT", put, { "content-type": "application/octet-stream", "content-length": String(data.byteLength) }, data);
      if (done.status !== 201) throw new RegistryAnswer(`uploading ${digest}`, done.status, await done.text());
    });
    return true;
  }

  /** Whether the registry holds the manifest `digest`. */
  async hasManifest(digest: string, mediaType: string): Promise<boolean> {
    const res = await this.request("HEAD", `/v2/${this.repo.name}/manifests/${digest}`, { accept: mediaType });
    return res.status === 200;
  }

  /** The manifest `ref` (a tag or a digest) names, or null when the registry has none (#5163). */
  async getManifest(ref: string): Promise<{ mediaType: string; bytes: Uint8Array; digest: string } | null> {
    const accept = [...INDEX_TYPES, IMAGE_MANIFEST, "application/vnd.docker.distribution.manifest.v2+json"].join(", ");
    const res = await this.request("GET", `/v2/${this.repo.name}/manifests/${ref}`, { accept });
    if (res.status === 404) return null;
    if (res.status !== 200 || !res.arrayBuffer) this.fail(`reading manifest ${ref}`, res.status, await res.text());
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mediaType = res.headers.get("content-type")?.split(";")[0]?.trim() || ((JSON.parse(Buffer.from(bytes).toString("utf-8")) as { mediaType?: string }).mediaType ?? IMAGE_MANIFEST);
    return { mediaType, bytes, digest: res.headers.get("docker-content-digest") ?? bytesDigest(bytes) };
  }

  /** Put a manifest. True when the registry answered with `OCI-Subject`, so its referrers API lists a manifest with a subject. */
  async putManifest(ref: string, mediaType: string, bytes: Uint8Array): Promise<boolean> {
    return this.tries(`putting manifest ${ref}`, async () => {
      const res = await this.request("PUT", `/v2/${this.repo.name}/manifests/${ref}`, { "content-type": mediaType }, bytes);
      if (res.status !== 201) throw new RegistryAnswer(`putting manifest ${ref}`, res.status, await res.text());
      return res.headers.get("oci-subject") !== null;
    });
  }

  /**
   * The referrers of `digest` (#5164): the referrers API's index, else, on a
   * registry without it (GHCR, Docker Hub), the index the referrers tag
   * schema keeps at the tag `sha256-<hex>`. Empty when there is neither.
   */
  async referrers(digest: string): Promise<ReferrerDescriptor[]> {
    const api = await this.request("GET", `/v2/${this.repo.name}/referrers/${digest}`, { accept: OCI_INDEX });
    if (api.status === 200) {
      const body = JSON.parse(await api.text()) as { manifests?: ReferrerDescriptor[] };
      return body.manifests ?? [];
    }
    return (await this.referrersTag(digest))?.manifests ?? [];
  }

  private async referrersTag(digest: string): Promise<{ manifests: ReferrerDescriptor[] } | null> {
    const res = await this.request("GET", `/v2/${this.repo.name}/manifests/${referrersTagOf(digest)}`, { accept: OCI_INDEX });
    if (res.status !== 200) return null;
    try {
      const body = JSON.parse(await res.text()) as { manifests?: ReferrerDescriptor[] };
      return { manifests: body.manifests ?? [] };
    } catch {
      return null;
    }
  }

  /** Add `descriptor` to the referrers tag of `subject` (the OCI distribution spec's fallback), unless it is listed there. */
  async addToReferrersTag(subject: string, descriptor: ReferrerDescriptor): Promise<void> {
    const index = (await this.referrersTag(subject)) ?? { manifests: [] };
    if (index.manifests.some((m) => m.digest === descriptor.digest)) return;
    const bytes = new Uint8Array(Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [...index.manifests, descriptor] })));
    await this.putManifest(referrersTagOf(subject), OCI_INDEX, bytes);
  }
}

const OCI_INDEX = "application/vnd.oci.image.index.v1+json";

/** One referrer as an index lists it. */
interface ReferrerDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  artifactType?: string;
  annotations?: Record<string, string>;
}

/** The tag the referrers tag schema keeps the referrers of `digest` under: `sha256-<hex>`. */
export function referrersTagOf(digest: string): string {
  return digest.replace(":", "-");
}

/**
 * The artifact manifest that attaches a Sigstore bundle to the image
 * `subject` (#5164), as `cosign sign` and `cosign attest` push one: the
 * bundle media type as the artifact type and the one layer, and the
 * statement's predicate type in `dev.sigstore.bundle.predicateType`.
 */
export function bundleReferrerManifest(bundle: Attachment, predicateType: string, subject: { mediaType: string; digest: string; size: number }): Uint8Array {
  const annotations = { "dev.sigstore.bundle.content": "dsse-envelope", [BUNDLE_PREDICATE_ANNOTATION]: predicateType };
  const manifest = {
    schemaVersion: 2,
    mediaType: IMAGE_MANIFEST,
    artifactType: SIGSTORE_BUNDLE_MEDIA_TYPE,
    config: { mediaType: EMPTY_CONFIG.mediaType, digest: bytesDigest(EMPTY_CONFIG.bytes), size: EMPTY_CONFIG.bytes.byteLength },
    layers: [{ mediaType: SIGSTORE_BUNDLE_MEDIA_TYPE, digest: bundle.digest, size: bundle.bytes.byteLength, annotations: { "org.opencontainers.image.title": bundle.name } }],
    subject,
    annotations,
  };
  return new Uint8Array(Buffer.from(JSON.stringify(manifest)));
}

/** The media type of the empty config an artifact manifest names. */
const EMPTY_CONFIG = { mediaType: "application/vnd.oci.empty.v1+json", bytes: new Uint8Array(Buffer.from("{}")) };
const IMAGE_MANIFEST = "application/vnd.oci.image.manifest.v1+json";

/** One referrer of the image: an attached file and the artifact manifest that names the image as its subject. */
interface Referrer {
  attachment: Attachment;
  manifest: Uint8Array;
  digest: string;
}

/**
 * The artifact manifest that attaches `a` to the image `subject` (OCI image
 * spec 1.1): `artifactType` is the file's media type, the config is the empty
 * descriptor, the one layer is the file, and `subject` is the image.
 */
export function referrerManifest(a: Attachment, subject: { mediaType: string; digest: string; size: number }): Uint8Array {
  const manifest = {
    schemaVersion: 2,
    mediaType: IMAGE_MANIFEST,
    artifactType: a.mediaType,
    config: { mediaType: EMPTY_CONFIG.mediaType, digest: bytesDigest(EMPTY_CONFIG.bytes), size: EMPTY_CONFIG.bytes.byteLength },
    layers: [{ mediaType: a.mediaType, digest: a.digest, size: a.bytes.byteLength, annotations: { "org.opencontainers.image.title": a.name } }],
    subject,
    annotations: { "org.opencontainers.image.title": a.name },
  };
  return new Uint8Array(Buffer.from(JSON.stringify(manifest)));
}

/**
 * The tag of each platform's image (#5269): `platformTags` with `{label}`,
 * `{version}`, `{os}` and `{arch}` (the architecture and its variant, `armv7`) filled in
 * for each image of the layout's index, from the index entry's platform or
 * else the image's config. None for a release with no label. Two images
 * that would take one tag are refused.
 */
export function ociPlatformTags(
  decl: Pick<OciPublishDeclaration, "platformTags" | "image">,
  label: string | null,
  manifests: ReadonlyArray<{ digest: string; platform?: Descriptor["platform"] }>,
  configPlatform: (digest: string) => Descriptor["platform"] = () => undefined,
): Array<{ tag: string; digest: string }> {
  if (!decl.platformTags || label === null) return [];
  const out: Array<{ tag: string; digest: string }> = [];
  const taken = new Map<string, string>();
  for (const m of manifests) {
    const p = m.platform ?? configPlatform(m.digest);
    if (!p?.architecture || p.architecture === "unknown") continue;
    const arch = `${p.architecture}${p.variant ?? ""}`;
    for (const t of decl.platformTags) {
      const tag = fillTag(t, label).split("{arch}").join(arch).split("{os}").join(p.os ?? "");
      const other = taken.get(tag);
      if (other !== undefined && other !== m.digest) {
        throw new PublishTargetError("publish-oci-platform-tag-taken", `${decl.image} holds two images that platformTags would both tag ${tag}`, "Name {os} in platformTags as well, or build one image per platform.");
      }
      if (other === undefined) out.push({ tag, digest: m.digest });
      taken.set(tag, m.digest);
    }
  }
  return out;
}

/** A tag that names the release, by `{label}` or `{version}` (#5269), and so belongs to it. */
const namesRelease = (t: string): boolean => t.includes("{label}") || t.includes("{version}");

/** `t` with `{label}` and `{version}` (the label from its first digit, #5269) filled in. */
function fillTag(t: string, label: string): string {
  const at = label.search(/\d/);
  return t.split("{label}").join(label).split("{version}").join(at >= 0 ? label.slice(at) : label);
}

/** The tags to point at the digest: the context's tag when set, else the declared ones with `{label}` filled in, without `latest` for a prerelease label. */
export function ociTags(decl: OciPublishDeclaration, ctx: Pick<PublishContext, "tag" | "label">): string[] {
  if (ctx.tag) return [ctx.tag];
  const declared = decl.tags ?? (ctx.label ? ["{label}"] : []);
  const tags = declared.filter((t) => ctx.label !== null || !namesRelease(t)).map((t) => (ctx.label === null ? t : fillTag(t, ctx.label)));
  // A prerelease label moves no `latest`; what is left is its own label tag.
  if (prereleaseOf(ctx.label) === null) return tags;
  const kept = tags.filter((t) => t !== "latest");
  return kept.length > 0 || ctx.label === null ? kept : [ctx.label];
}

/** The digest an OCI archive (a layout directory or a tar file of one) is pushed under: its top manifest's (#4657). */
export function ociArchiveDigest(abs: string): string {
  const layout = readLayout(abs);
  try {
    return layout.top.digest;
  } finally {
    layout.cleanup();
  }
}

/**
 * The tags a status change moves (#5163): the channel's tag when the release
 * was cut to one, else the declared tags with no `{label}` in them, such as
 * `latest`, without `latest` for a prerelease label, which never moved it
 * (#5166). A tag that names the label belongs to that release and stays.
 */
export function ociMovingTags(decl: OciPublishDeclaration, channel: string | null, label: string | null = null): string[] {
  if (channel) return [channel];
  const moving = (decl.tags ?? ["{label}"]).filter((t) => !namesRelease(t));
  return prereleaseOf(label) === null ? moving : moving.filter((t) => t !== "latest");
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
  /** #5269: each platform's image's tags, from the layout. */
  const platformTags = (ctx: PublishContext, layout: LayoutImage) =>
    ociPlatformTags(decl, ctx.label, layout.manifests, (digest) => {
      const m = layout.manifests.find((x) => x.digest === digest);
      const config = m?.blobs[0];
      if (!config) return undefined;
      const c = JSON.parse(Buffer.from(layout.readBlob(config.digest)).toString("utf-8")) as { os?: string; architecture?: string; variant?: string };
      return { ...(c.os ? { os: c.os } : {}), ...(c.architecture ? { architecture: c.architecture } : {}), ...(c.variant ? { variant: c.variant } : {}) };
    });
  const item = (ctx: PublishContext, digest: string, perPlatform: ReadonlyArray<{ tag: string }> = []): PublishItem => {
    const tags = [...ociTags(decl, ctx), ...perPlatform.map((p) => p.tag)];
    return {
      name: `${decl.image}${tags.length > 0 ? ` (tag${tags.length === 1 ? "" : "s"} ${tags.join(", ")})` : ""}`,
      destination: `${decl.repository}@${digest}`,
      digest,
    };
  };
  /**
   * #5446: whether the image's SBOM is the one made from its layers: the
   * publish scans (so syft is there and checked) and the declaration names
   * no SBOM file and does not turn it off.
   */
  const fromLayers = (ctx: PublishContext): boolean => decl.sbom === undefined && !!ctx.scan;
  /** #5446: the SBOM made from the image's layers, made once per image in a run; the scan and the stage share it. */
  const layerSboms = new Map<string, Promise<SbomDocument>>();
  const layerSbom = (ctx: PublishContext, digest: string): Promise<SbomDocument> => {
    let made = layerSboms.get(digest);
    if (!made) {
      made = ctx.scan!.scanner.imageSbom(memberFile(ctx.cwd, decl.image));
      layerSboms.set(digest, made);
    }
    return made;
  };
  /** The image's SBOM: the file the declaration names, else the one made from its layers when the publish scans, else one from the member's lockfile. */
  const sbomOf = async (ctx: PublishContext, layout: LayoutImage): Promise<Attachment | null> => {
    const image = `${decl.repository}@${layout.top.digest}`;
    if (!fromLayers(ctx)) return memberSbom(ctx, decl.sbom, image, `oci ${decl.repository}`);
    return imageSbom(ctx, (await layerSbom(ctx, layout.top.digest)).bytes, image, layout.top.digest);
  };
  /** #5446: the findings referrer, once the scan before the stage ran in this publish. */
  const findingsOf = (ctx: PublishContext, digest: string): Attachment | null => {
    const f = ctx.scanReport ? findingsAttachment(ctx.scanReport, digest) : null;
    return f ? { kind: "scan", ...f, digest: bytesDigest(f.bytes) } : null;
  };
  /** The SBOM, the provenance statement and the scan's findings, each with the artifact manifest that refers to the image. */
  const referrers = async (ctx: PublishContext, layout: LayoutImage, opts: { sbom: boolean } = { sbom: true }): Promise<Referrer[]> => {
    const subject = { mediaType: layout.top.mediaType, digest: layout.top.digest, size: layout.top.bytes.byteLength };
    const files = [
      opts.sbom ? await sbomOf(ctx, layout) : null,
      releaseProvenance(ctx, [{ name: `${decl.repository}@${layout.top.digest}`, digest: layout.top.digest }]),
      // #5446: what the scan before the stage found in the image, beside its SBOM.
      findingsOf(ctx, layout.top.digest),
    ].filter((a): a is Attachment => a !== null);
    return files.map((attachment) => {
      const manifest = referrerManifest(attachment, subject);
      return { attachment, manifest, digest: bytesDigest(manifest) };
    });
  };
  const referrerItem = (r: Referrer): PublishItem => ({ name: r.attachment.name, destination: `${decl.repository}@${r.digest}, a referrer of the image`, digest: r.digest, attachment: r.attachment.kind });
  /** #5164: the cosign signature and SLSA provenance of the image, which a stage signs when the publish signs. */
  const signatures = [
    { predicateType: COSIGN_SIGN_PREDICATE, name: "cosign signature", attachment: "signature" as const },
    { predicateType: SLSA_PROVENANCE_PREDICATE, name: "SLSA provenance", attachment: "attestation" as const },
  ];
  const signatureItem = (ctx: PublishContext, s: (typeof signatures)[number], image: string, digest?: string): PublishItem => ({
    name: s.name,
    destination: digest ? `${decl.repository}@${digest}, a referrer of the image` : `${decl.repository}, a referrer of the image, signed when staged`,
    ...(digest ? { digest } : {}),
    attachment: s.attachment,
    signs: [{ name: `${decl.repository}@${image}`, digest: image }],
    predicateType: s.predicateType,
    ...(ctx.signing ? { sigstore: ctx.signing.identity } : {}),
  });
  /** Sign the image and push each bundle as a referrer, unless the image has one with that predicate type already. */
  const sign = async (ctx: PublishContext, registry: Registry, layout: LayoutImage): Promise<PublishItem[]> => {
    if (!ctx.signing) return [];
    const subject = { mediaType: layout.top.mediaType, digest: layout.top.digest, size: layout.top.bytes.byteLength };
    const existing = await registry.referrers(layout.top.digest);
    const items: PublishItem[] = [];
    for (const s of signatures) {
      const found = existing.find((m) => m.artifactType === SIGSTORE_BUNDLE_MEDIA_TYPE && m.annotations?.[BUNDLE_PREDICATE_ANNOTATION] === s.predicateType);
      if (found) {
        ctx.log(`${layout.top.digest} already has a ${s.name}; it is not signed again`);
        items.push({ ...signatureItem(ctx, s, layout.top.digest, found.digest), present: true });
        continue;
      }
      const name = `${decl.repository}@${layout.top.digest}`;
      const statement = s.predicateType === COSIGN_SIGN_PREDICATE ? cosignSignStatement({ name: decl.repository, digest: layout.top.digest }) : slsaProvenanceStatement(ctx, [{ name, digest: layout.top.digest }]);
      ctx.log(`signing ${name} with ${ctx.signing.signer.name}: ${s.name}`);
      const bytes = await ctx.signing.signer.signStatement(statement);
      const bundle: Attachment = { kind: "provenance", name: `${s.attachment}.sigstore.json`, mediaType: SIGSTORE_BUNDLE_MEDIA_TYPE, bytes, digest: bytesDigest(bytes) };
      const manifest = bundleReferrerManifest(bundle, s.predicateType, subject);
      const digest = bytesDigest(manifest);
      await registry.pushBlob(bytesDigest(EMPTY_CONFIG.bytes), () => EMPTY_CONFIG.bytes);
      await registry.pushBlob(bundle.digest, () => bundle.bytes);
      const listed = await registry.putManifest(digest, IMAGE_MANIFEST, manifest);
      if (!listed) {
        await registry.addToReferrersTag(layout.top.digest, {
          mediaType: IMAGE_MANIFEST,
          digest,
          size: manifest.byteLength,
          artifactType: SIGSTORE_BUNDLE_MEDIA_TYPE,
          annotations: { "dev.sigstore.bundle.content": "dsse-envelope", [BUNDLE_PREDICATE_ANNOTATION]: s.predicateType },
        });
      }
      items.push(signatureItem(ctx, s, layout.top.digest, digest));
    }
    return items;
  };
  const connect = (ctx: PublishContextBase) => {
    const cred = ociCredential(decl, repo, ctx);
    return { cred, registry: new Registry(repo, fetchImpl, cred, ctx, deps.sleep) };
  };
  /** The image's digest among a release's recorded items: the one item that is not an attachment. */
  const imageDigest = (items: readonly PublishItem[]): string | undefined => items.find((i) => i.attachment === undefined && i.digest)?.digest;
  return {
    /** #5165: the repository; what the image bundles is not read from it, so a member names that with `release.dependsOn`. */
    async names() {
      return { provides: [trainName("oci", decl.repository)], needs: [] };
    },
    /** #5165: whether each tag that names the label is there; null when no declared tag names it. */
    async published(ctx) {
      const label = ctx.label;
      if (label === null) return null;
      const tags = (decl.tags ?? ["{label}"]).filter(namesRelease).map((t) => fillTag(t, label));
      if (tags.length === 0) return null;
      const { registry } = connect(ctx);
      for (const t of tags) if ((await registry.getManifest(t)) === null) return false;
      return true;
    },
    /** #5165: wait until each tag the reveal moved names the image's digest. */
    async visible(ctx, published) {
      const digest = imageDigest(published.items);
      const tags = ociTags(decl, ctx);
      if (!digest || tags.length === 0) return;
      const { registry } = connect(ctx);
      await waitUntilServed(ctx, deps, {
        what: decl.repository,
        code: "publish-oci-not-served",
        check: async () => {
          const missing: string[] = [];
          for (const t of tags) if ((await registry.getManifest(t))?.digest !== digest) missing.push(`${decl.repository}:${t}`);
          return missing;
        },
      });
    },
    /**
     * #5163: a registry has no deprecation, so deprecate does nothing here. A
     * yank points each moving tag that names this release's digest at the
     * head release's; a restore points them back when this release is the
     * head. The label's own tag stays, since a registry need not delete a tag.
     */
    async setStatus(ctx: StatusContext): Promise<StatusAction[]> {
      if (ctx.status === "deprecated") return [{ what: `${decl.repository} unchanged: a registry has no deprecation; yank moves its tags` }];
      const ours = imageDigest(ctx.revealed);
      if (!ours) return [{ what: `${decl.repository} unchanged: the publish record names no image digest`, already: true }];
      const tags = ociMovingTags(decl, ctx.tag, ctx.label);
      if (tags.length === 0) return [{ what: `${decl.repository} unchanged: every tag the target moves names the label, so none moves`, already: true }];
      const isHead = ctx.head?.releaseDigest === ctx.release.releaseDigest;
      if (ctx.status === "active" && !isHead) return [{ what: `${decl.repository} ${tags.join(", ")} unchanged: a newer active release holds them`, already: true }];
      const to = ctx.status === "active" ? ours : ctx.head ? imageDigest(ctx.head.items) : undefined;
      const actions: StatusAction[] = [];
      if (!to) {
        for (const t of tags) {
          actions.push({
            what: `${decl.repository}:${t} stays where it is`,
            refused: { code: "release-status-no-previous", message: `no earlier active release of this channel was pushed to ${decl.repository}, so ${t} has nowhere to move back to`, fix: "Cut and publish a release to move it to, or restore an earlier one." },
          });
        }
        return actions;
      }
      if (!ctx.apply) return tags.map((t) => ({ what: ctx.status === "active" ? `point ${decl.repository}:${t} at ${ours}` : `point ${decl.repository}:${t} at ${to}, if it names ${ours}` }));
      const { registry } = connect(ctx);
      let manifest: Awaited<ReturnType<Registry["getManifest"]>> | undefined;
      for (const t of tags) {
        const now = await registry.getManifest(t);
        if (now?.digest === to || (ctx.status === "yanked" && now?.digest !== ours)) {
          actions.push({ what: `${decl.repository}:${t} names ${now?.digest ?? "nothing"}; not moved`, already: true });
          continue;
        }
        manifest ??= await registry.getManifest(to);
        if (!manifest) throw new PublishTargetError("release-status-oci-failed", `${decl.repository} no longer holds ${to}, so ${t} can't point at it`);
        await registry.putManifest(t, manifest.mediaType, manifest.bytes);
        ctx.log(`tagged ${to} ${t}`);
        actions.push({ what: `point ${decl.repository}:${t} at ${to}` });
      }
      return actions;
    },
    kind: "oci",
    name: `oci ${decl.repository}`,
    destination: decl.repository,
    credentialEnv: [decl.passwordEnv ?? "OCI_PASSWORD"],
    key: publishTargetKey(decl),
    async plan(ctx) {
      const layout = inspect(ctx);
      try {
        // #5446: an SBOM made from the layers is made when the image stages, so the plan names it without a digest.
        const planned = fromLayers(ctx)
          ? [{ name: IMAGE_SBOM_FILE, destination: `${decl.repository}, a referrer of the image, made from its layers when staged`, attachment: "sbom" as const }, ...(await referrers(ctx, layout, { sbom: false })).map(referrerItem)]
          : (await referrers(ctx, layout)).map(referrerItem);
        return [item(ctx, layout.top.digest, platformTags(ctx, layout)), ...planned, ...(ctx.signing ? signatures.map((s) => signatureItem(ctx, s, layout.top.digest)) : [])];
      } finally {
        layout.cleanup();
      }
    },
    /**
     * #5446: the image, through the SBOM made from its layers, which is the
     * SBOM the stage attaches; and a file the declaration names as its SBOM,
     * scanned too. With `sbom: false` the image is still scanned.
     */
    async scanSubjects(ctx) {
      const layout = inspect(ctx);
      try {
        const image = `${decl.repository}@${layout.top.digest}`;
        const declared = typeof decl.sbom === "string" ? memberSbom(ctx, decl.sbom, image, `oci ${decl.repository}`) : null;
        const layers = ctx.scan ? await layerSbom(ctx, layout.top.digest) : null;
        return [
          ...(layers ? [{ target: this.name, name: image, sbom: layers, digest: layout.top.digest }] : [{ target: this.name, name: image, image: memberFile(ctx.cwd, decl.image), digest: layout.top.digest }]),
          ...(declared ? [{ target: this.name, name: `${declared.name} of ${image}`, sbom: sbomDocumentOf(declared.bytes, "attached"), digest: layout.top.digest }] : []),
        ];
      } finally {
        layout.cleanup();
      }
    },
    async stage(ctx) {
      const layout = inspect(ctx);
      try {
        const attached = await referrers(ctx, layout);
        const { cred, registry } = connect(ctx);
        const staged: PublishItem = { ...item(ctx, layout.top.digest, platformTags(ctx, layout)), name: decl.image };
        const items: PublishItem[] = [];
        if (await registry.hasManifest(layout.top.digest, layout.top.mediaType)) {
          ctx.log(`${decl.repository} already holds ${layout.top.digest}; the image is not pushed again`);
          items.push({ ...staged, present: true });
        } else {
          ctx.log(`pushing ${decl.image} to ${decl.repository} by digest ${layout.top.digest}, ${cred ? `with credentials from ${cred.password.from}` : "anonymously"}; no tag moves yet`);
          let uploaded = 0;
          for (const m of layout.manifests) {
            for (const b of m.blobs) if (await registry.pushBlob(b.digest, () => layout.readBlob(b.digest))) uploaded++;
            await registry.putManifest(m.digest, m.mediaType, m.bytes);
          }
          if (INDEX_TYPES.has(layout.top.mediaType)) await registry.putManifest(layout.top.digest, layout.top.mediaType, layout.top.bytes);
          ctx.log(`  ${uploaded} blob(s) uploaded`);
          items.push(staged);
        }
        // #4049: the SBOM and the provenance statement, as referrers of the image, by digest.
        for (const r of attached) {
          if (await registry.hasManifest(r.digest, IMAGE_MANIFEST)) {
            items.push({ ...referrerItem(r), present: true });
            continue;
          }
          ctx.log(`attaching ${r.attachment.name} to ${layout.top.digest} as referrer ${r.digest}`);
          await registry.pushBlob(bytesDigest(EMPTY_CONFIG.bytes), () => EMPTY_CONFIG.bytes);
          await registry.pushBlob(r.attachment.digest, () => r.attachment.bytes);
          await registry.putManifest(r.digest, IMAGE_MANIFEST, r.manifest);
          items.push(referrerItem(r));
        }
        // #5164: signed in the stage, so no tag points at an image before its signature is there.
        items.push(...(await sign(ctx, registry, layout)));
        return { target: this.name, destination: this.destination, items, state: {} };
      } finally {
        layout.cleanup();
      }
    },
    async reveal(ctx, staged) {
      const layout = inspect(ctx);
      try {
        const { registry } = connect(ctx);
        const tags = ociTags(decl, ctx);
        for (const t of tags) await registry.putManifest(t, layout.top.mediaType, layout.top.bytes);
        ctx.log(tags.length > 0 ? `tagged ${layout.top.digest} ${tags.join(", ")}` : `no tag to point at ${layout.top.digest}`);
        // #5269: each platform's image under its own tag, pushed by digest in the stage.
        const perPlatform = platformTags(ctx, layout);
        for (const p of perPlatform) {
          const m = layout.manifests.find((x) => x.digest === p.digest)!;
          await registry.putManifest(p.tag, m.mediaType, m.bytes);
          ctx.log(`tagged ${p.digest} ${p.tag}`);
        }
        const signed = (staged?.items ?? []).filter((i) => i.attachment === "signature" || i.attachment === "attestation").map(({ present: _present, ...i }) => i);
        // #5446: the findings referrer the stage pushed, which a resumed reveal can't make again.
        const listed = (await referrers({ ...ctx, scanReport: undefined }, layout)).map(referrerItem);
        const findings = (staged?.items ?? []).filter((i) => i.attachment === "scan").map(({ present: _present, ...i }) => i);
        return { target: this.name, destination: this.destination, items: [item(ctx, layout.top.digest, perPlatform), ...listed, ...findings, ...signed] };
      } finally {
        layout.cleanup();
      }
    },
  };
}
