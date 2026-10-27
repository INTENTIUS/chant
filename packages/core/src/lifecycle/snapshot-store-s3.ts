/**
 * The `s3` medium of the index store (#4519): objects in a bucket under a
 * prefix of their own, never a record store's prefix.
 *
 * Transport is `fetch` with a SigV4 header signature from chant's one AWS
 * signer (../cloud-lister/sigv4.ts, #4554), so core takes no `@aws-sdk/*`
 * dependency. `fetch` is injectable: the conformance test runs
 * against an in-process fake and nothing leaves the process.
 *
 * ## Credentials
 *
 * The rule is the one round 2 of the engine work set for every emulator run:
 * a store pointed at an endpoint never reaches for the default AWS credential
 * chain.
 *
 * - Explicit credentials (`credentials` in chant.config.ts, or
 *   `CHANT_SNAPSHOT_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` /
 *   `_SESSION_TOKEN`) are used as given.
 * - With an `endpoint` and no explicit credentials the store refuses. It does
 *   not read `AWS_ACCESS_KEY_ID`, a profile file, or an instance role, so an
 *   emulator run can never sign with, or leak, a real account's keys.
 * - With no endpoint (real S3), `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
 *   / `AWS_SESSION_TOKEN` answer. Profiles and instance roles are not read.
 *
 * ## History
 *
 * A snapshot keeps one key, so its history is the bucket's object versions:
 * turn versioning on. An index version is a new key per read, so it needs no
 * versioning. A write of an index version sends `If-None-Match: *`, and a 412
 * means the version already exists.
 */
import { encodeRfc3986, signV4 } from "../cloud-lister/sigv4";

/** Explicit credentials. */
export interface S3StoreCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Where an s3 store keeps its objects. */
export interface S3StoreSettings {
  bucket: string;
  /** Key prefix, without leading or trailing `/`. Default `chant`. */
  prefix?: string;
  /** Signing region. Default `us-east-1`. */
  region?: string;
  /** An S3-compatible endpoint (an emulator, MinIO). With one, credentials must be explicit. */
  endpoint?: string;
  /** Path-style addressing. Default: on with an endpoint, off without. */
  forcePathStyle?: boolean;
  credentials?: S3StoreCredentials;
}

/** The `fetch` the medium calls. Tests pass a fake. */
export type S3Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export class S3StoreError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "S3StoreError";
  }
}

/** One object version, newest first in {@link S3Medium.versions}. */
export interface S3ObjectVersion {
  key: string;
  versionId: string;
  lastModified: string;
  isLatest: boolean;
}

/**
 * Resolve the credentials the medium signs with, by the rule in the module
 * header. Exported for the test that pins it.
 */
export function resolveS3Credentials(
  settings: S3StoreSettings,
  env: Record<string, string | undefined> = process.env,
): S3StoreCredentials {
  if (settings.credentials) return settings.credentials;
  const explicitId = env.CHANT_SNAPSHOT_S3_ACCESS_KEY_ID;
  const explicitSecret = env.CHANT_SNAPSHOT_S3_SECRET_ACCESS_KEY;
  if (explicitId && explicitSecret) {
    return {
      accessKeyId: explicitId,
      secretAccessKey: explicitSecret,
      ...(env.CHANT_SNAPSHOT_S3_SESSION_TOKEN ? { sessionToken: env.CHANT_SNAPSHOT_S3_SESSION_TOKEN } : {}),
    };
  }
  if (settings.endpoint) {
    throw new S3StoreError(
      `the s3 store at ${settings.endpoint} needs explicit credentials (snapshots.credentials in chant.config.ts, or CHANT_SNAPSHOT_S3_ACCESS_KEY_ID and CHANT_SNAPSHOT_S3_SECRET_ACCESS_KEY); against an endpoint it never reads the default AWS credential chain`,
    );
  }
  const id = env.AWS_ACCESS_KEY_ID;
  const secret = env.AWS_SECRET_ACCESS_KEY;
  if (!id || !secret) {
    throw new S3StoreError(
      "the s3 store has no credentials: set snapshots.credentials, CHANT_SNAPSHOT_S3_ACCESS_KEY_ID and CHANT_SNAPSHOT_S3_SECRET_ACCESS_KEY, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (profiles and instance roles are not read)",
    );
  }
  return { accessKeyId: id, secretAccessKey: secret, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) };
}

/** RFC 3986 percent-encoding, as S3 signs it: chant's one AWS signer's (../cloud-lister/sigv4.ts, #4554). */
export { encodeRfc3986 };

/**
 * SigV4 headers for one S3 request, signed by chant's one AWS signer
 * (../cloud-lister/sigv4.ts, #4554). S3 signs the path encoded once, which is
 * how {@link S3Medium} builds it, so the URL's pathname is the canonical URI
 * as it stands.
 */
export function signS3Request(req: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  credentials: S3StoreCredentials;
  now?: Date;
}): Record<string, string> {
  return signV4({ method: req.method, url: req.url, headers: req.headers, body: req.body, region: req.region, service: "s3", credentials: req.credentials, now: req.now ?? new Date(), contentSha256: true, omitHost: true });
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) =>
    e.startsWith("#x") ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith("#") ? String.fromCodePoint(parseInt(e.slice(1), 10)) : XML_ENTITIES[e],
  );
const tagAll = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
const tagOne = (xml: string, tag: string): string | undefined => {
  const v = tagAll(xml, tag)[0];
  return v === undefined ? undefined : decodeXml(v);
};

/**
 * Get, put and list over one bucket. Keys passed in are relative to the
 * store's prefix.
 */
export class S3Medium {
  private readonly prefix: string;
  private readonly region: string;
  private readonly fetchImpl: S3Fetch;
  private credentials?: S3StoreCredentials;

  constructor(
    readonly settings: S3StoreSettings,
    opts?: { fetch?: S3Fetch; env?: Record<string, string | undefined> },
  ) {
    if (!settings.bucket) throw new S3StoreError("the s3 store needs a bucket");
    this.prefix = (settings.prefix ?? "chant").replace(/^\/+|\/+$/g, "");
    this.region = settings.region ?? "us-east-1";
    this.fetchImpl = opts?.fetch ?? ((url, init) => fetch(url, init));
    // Resolved at once, so a missing credential is an error before any request.
    this.credentials = resolveS3Credentials(settings, opts?.env);
  }

  /** `s3://bucket/prefix`, for messages. */
  get where(): string {
    return `s3://${this.settings.bucket}/${this.prefix}`;
  }

  private fullKey(key: string): string {
    return this.prefix === "" ? key : `${this.prefix}/${key}`;
  }

  private stripPrefix(key: string): string {
    return this.prefix === "" ? key : key.slice(this.prefix.length + 1);
  }

  private url(key: string | null, query: Record<string, string>): string {
    const pathStyle = this.settings.forcePathStyle ?? this.settings.endpoint !== undefined;
    const base = this.settings.endpoint
      ? this.settings.endpoint.replace(/\/+$/, "")
      : pathStyle
        ? `https://s3.${this.region}.amazonaws.com`
        : `https://${this.settings.bucket}.s3.${this.region}.amazonaws.com`;
    const encodedKey = key === null ? "" : key.split("/").map(encodeRfc3986).join("/");
    const path = pathStyle ? `/${encodeRfc3986(this.settings.bucket)}${key === null ? "" : `/${encodedKey}`}` : `/${encodedKey}`;
    const qs = Object.entries(query)
      .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
      .join("&");
    return `${base}${path}${qs ? `?${qs}` : ""}`;
  }

  private async request(method: string, key: string | null, query: Record<string, string>, body = "", headers: Record<string, string> = {}) {
    const url = this.url(key, query);
    const signed = signS3Request({ method, url, headers, body, region: this.region, credentials: this.credentials! });
    return this.fetchImpl(url, { method, headers: signed, ...(body !== "" || method === "PUT" ? { body } : {}) });
  }

  /** The object's content, or null when absent. `versionId` reads an older version. */
  async get(key: string, versionId?: string): Promise<string | null> {
    const res = await this.request("GET", this.fullKey(key), versionId ? { versionId } : {});
    if (res.status === 404) return null;
    if (res.status === 400 && versionId) return null;
    if (res.status !== 200) throw new S3StoreError(`s3 GET ${key} returned ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    return res.text();
  }

  /**
   * Put an object. With `ifAbsent`, an existing key is not overwritten and
   * the result says `exists`. Returns the version id when the bucket keeps
   * versions.
   */
  async put(key: string, content: string, opts?: { ifAbsent?: boolean }): Promise<{ exists: boolean; versionId?: string }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts?.ifAbsent) headers["if-none-match"] = "*";
    const res = await this.request("PUT", this.fullKey(key), {}, content, headers);
    if (res.status === 412 || res.status === 409) return { exists: true };
    if (res.status !== 200) throw new S3StoreError(`s3 PUT ${key} returned ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    const versionId = res.headers.get("x-amz-version-id");
    return { exists: false, ...(versionId && versionId !== "null" ? { versionId } : {}) };
  }

  /** The names directly under `dir/`: files, and directories with a trailing `/`. */
  async list(dir: string): Promise<string[]> {
    const prefix = `${this.fullKey(dir)}/`;
    const names: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.request("GET", null, {
        "list-type": "2",
        prefix,
        delimiter: "/",
        ...(token ? { "continuation-token": token } : {}),
      });
      if (res.status === 404) return [];
      if (res.status !== 200) throw new S3StoreError(`s3 list ${dir} returned ${res.status}`, res.status);
      const xml = await res.text();
      for (const c of tagAll(xml, "Contents")) {
        const k = tagOne(c, "Key");
        if (k !== undefined && k.length > prefix.length) names.push(k.slice(prefix.length));
      }
      for (const p of tagAll(xml, "CommonPrefixes")) {
        const k = tagOne(p, "Prefix");
        if (k !== undefined && k.length > prefix.length) names.push(k.slice(prefix.length));
      }
      token = tagOne(xml, "IsTruncated") === "true" ? tagOne(xml, "NextContinuationToken") : undefined;
    } while (token);
    return [...new Set(names)].sort();
  }

  /** Every version of every key under `dir/` (recursively), newest first. */
  async versions(dir: string): Promise<S3ObjectVersion[]> {
    const prefix = `${this.fullKey(dir)}/`;
    const out: S3ObjectVersion[] = [];
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const res = await this.request("GET", null, {
        versions: "",
        prefix,
        ...(keyMarker ? { "key-marker": keyMarker } : {}),
        ...(versionMarker ? { "version-id-marker": versionMarker } : {}),
      });
      if (res.status === 404) return [];
      if (res.status !== 200) throw new S3StoreError(`s3 list versions ${dir} returned ${res.status}`, res.status);
      const xml = await res.text();
      for (const v of tagAll(xml, "Version")) {
        const key = tagOne(v, "Key");
        const versionId = tagOne(v, "VersionId");
        const lastModified = tagOne(v, "LastModified");
        if (key === undefined || versionId === undefined || lastModified === undefined) continue;
        out.push({ key: this.stripPrefix(key), versionId, lastModified, isLatest: tagOne(v, "IsLatest") === "true" });
      }
      const truncated = tagOne(xml, "IsTruncated") === "true";
      keyMarker = truncated ? tagOne(xml, "NextKeyMarker") : undefined;
      versionMarker = truncated ? tagOne(xml, "NextVersionIdMarker") : undefined;
    } while (keyMarker);
    return out.sort((a, b) => (a.lastModified < b.lastModified ? 1 : a.lastModified > b.lastModified ? -1 : 0));
  }
}
