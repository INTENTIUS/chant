/**
 * The little of S3 a product, a report URL or a state needs: put an object
 * (conditionally), get one, head one, its versions, and a presigned link to
 * one, signed with chant's AWS Signature Version 4 (../cloud-lister/sigv4.ts).
 * Any S3-compatible store answers it: S3, R2, MinIO, floci, Google Cloud
 * Storage's interoperability API. With no static keys, a role is assumed
 * with the job's OIDC token through STS AssumeRoleWithWebIdentity. `fetch`
 * is injectable so the signing is tested against recorded requests.
 */
import { readFileSync } from "node:fs";
import { presignV4, sha256Hex, signV4 } from "../cloud-lister/sigv4";
import { defaultFetch, encodePath, encodeStrict, PRESIGN_MAX_SECONDS, StoreConflict, StoreError, tradedVars, xmlBlocks, xmlText, type ObjectStore, type ObjectVersion, type StoreCondition, type StoreFetch } from "./common";
import { CLOUD_TARGETS_ENV } from "../ci-identity";

export type S3Fetch = StoreFetch;
export { PRESIGN_MAX_SECONDS, StoreConflict as S3Conflict, StoreError as S3Error };

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * A role to assume with the job's OIDC token (AssumeRoleWithWebIdentity),
 * the way the AWS SDKs read `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE`.
 * The token file is read when the first request is signed, so a step that
 * writes it after the target is made is in time.
 */
export interface S3WebIdentity {
  roleArn: string;
  tokenFile: string;
  sessionName: string;
  /** STS's address, https://host[:port], no path. */
  endpoint: string;
}

export interface S3Location {
  bucket: string;
  /** https://host[:port], no path. Default: AWS's regional endpoint. */
  endpoint?: string;
  region: string;
}

export type S3Target = S3Location & (S3Credentials | { webIdentity: S3WebIdentity });

/** `s3://bucket` or a bare bucket name. `setting` names the value in the error. */
export function parseBucket(url: string, setting = "the bucket"): string {
  const m = /^(?:s3:\/\/)?([^/]+)\/?$/.exec(url.trim());
  if (!m) throw new StoreError(`${setting} must be s3://<bucket>, not ${url}`);
  return m[1]!;
}

/** Where a store is and how a product names it in its messages (#4554). */
export interface S3Where {
  /** `s3://<bucket>` or a bare bucket name. */
  bucket: string;
  /** https://host[:port], no path. Default AWS_ENDPOINT_URL_S3, AWS_ENDPOINT_URL, or AWS's regional endpoint. */
  endpoint?: string;
  /** A role to assume with the job's OIDC token, ahead of static keys. */
  role?: string;
  /** The STS session name when AWS_ROLE_SESSION_NAME is unset. Default `chant`. */
  sessionName?: string;
  /** What the bucket is called in messages, such as `reports.bucket`. Default `the bucket`. */
  setting?: string;
  /** What the role is called in messages, such as `reports.role`. Default `the role`. */
  roleSetting?: string;
}

/**
 * The target from where the store is and the AWS environment variables.
 * Credentials, first match wins: `role` assumed with the job's OIDC token
 * (or, when the job already traded its token, the keys its trade left for
 * `role`); static keys in `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`;
 * `AWS_ROLE_ARN` assumed with the token in `AWS_WEB_IDENTITY_TOKEN_FILE`.
 */
export function s3FromEnv(where: S3Where, env: NodeJS.ProcessEnv = process.env): S3Target {
  const setting = where.setting ?? "the bucket";
  const roleSetting = where.roleSetting ?? "the role";
  const endpoint = where.endpoint ?? env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL;
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
  const at = {
    bucket: parseBucket(where.bucket, setting),
    ...(endpoint ? { endpoint: endpoint.replace(/\/+$/, "") } : {}),
    region,
  };
  const tokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE;
  const assume = (roleArn: string): S3Target => ({
    ...at,
    webIdentity: {
      roleArn,
      tokenFile: tokenFile!,
      sessionName: env.AWS_ROLE_SESSION_NAME || where.sessionName || "chant",
      endpoint: (env.AWS_ENDPOINT_URL_STS || env.AWS_ENDPOINT_URL || `https://sts.${region}.amazonaws.com`).replace(/\/+$/, ""),
    },
  });
  // A job that traded its OIDC token holds none: its trade step left the role's keys (../ci-identity.ts).
  if (where.role && env[CLOUD_TARGETS_ENV] && !tokenFile) {
    const c = tradedVars(env, "aws", where.role)!;
    return { ...at, accessKeyId: c.AWS_ACCESS_KEY_ID!, secretAccessKey: c.AWS_SECRET_ACCESS_KEY!, ...(c.AWS_SESSION_TOKEN ? { sessionToken: c.AWS_SESSION_TOKEN } : {}) };
  }
  if (where.role) {
    if (!tokenFile) throw new StoreError(`${roleSetting} is set, but AWS_WEB_IDENTITY_TOKEN_FILE is not: the job needs an OIDC token to assume ${where.role}`);
    return assume(where.role);
  }
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) return { ...at, accessKeyId, secretAccessKey, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) };
  if (env.AWS_ROLE_ARN && tokenFile) return assume(env.AWS_ROLE_ARN);
  throw new StoreError(`${setting} is set, but the job has no credentials for it: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE, or ${roleSetting}`);
}

/** STS AssumeRoleWithWebIdentity. The request carries the token and is not signed. */
export async function assumeRoleWithWebIdentity(w: S3WebIdentity, fetchFn: S3Fetch, readToken: (file: string) => string = (f) => readFileSync(f, "utf-8")): Promise<S3Credentials & { expiration?: Date }> {
  let token: string;
  try {
    token = readToken(w.tokenFile).trim();
  } catch (e) {
    throw new StoreError(`cannot read the OIDC token in ${w.tokenFile}: ${(e as Error).message}`);
  }
  if (!token) throw new StoreError(`the OIDC token file ${w.tokenFile} is empty`);
  const body = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: w.roleArn,
    RoleSessionName: w.sessionName,
    WebIdentityToken: token,
  }).toString();
  const res = await fetchFn(`${w.endpoint}/`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8", accept: "application/xml" }, body });
  const xml = await res.text();
  if (!res.ok) {
    const why = [xmlText(xml, "Code"), xmlText(xml, "Message")].filter(Boolean).join(": ") || xml.slice(0, 300);
    throw new StoreError(`AssumeRoleWithWebIdentity for ${w.roleArn}: ${res.status} ${why}`);
  }
  const accessKeyId = xmlText(xml, "AccessKeyId");
  const secretAccessKey = xmlText(xml, "SecretAccessKey");
  const sessionToken = xmlText(xml, "SessionToken");
  if (!accessKeyId || !secretAccessKey || !sessionToken) throw new StoreError(`AssumeRoleWithWebIdentity for ${w.roleArn} answered without credentials`);
  const expires = xmlText(xml, "Expiration");
  return { accessKeyId, secretAccessKey, sessionToken, ...(expires && !Number.isNaN(Date.parse(expires)) ? { expiration: new Date(expires) } : {}) };
}

/** The URL and signed headers for one request. A custom endpoint is addressed path-style, AWS virtual-hosted. */
export function signRequest(t: S3Location & S3Credentials, method: string, key: string, body: string | Uint8Array, now = new Date(), contentType?: string, extra: Record<string, string> = {}): { url: string; headers: Record<string, string> } {
  const url = objectUrl(t, key);
  return { url, headers: sign(t, method, url, { ...(contentType ? { "content-type": contentType } : {}), ...extra }, sha256Hex(body), now) };
}

/**
 * Signature Version 4 headers for a request to `service` (S3 by default),
 * with `payload` as its SHA-256 sent in x-amz-content-sha256: chant's one
 * signer (../cloud-lister/sigv4.ts). `extra` headers are signed too.
 */
export function sign(t: Pick<S3Location, "region"> & S3Credentials, method: string, rawUrl: string, extra: Record<string, string>, payload: string, now: Date, service = "s3"): Record<string, string> {
  return signV4({ method, url: rawUrl, headers: extra, body: "", payloadHash: payload, contentSha256: true, omitHost: true, region: t.region, service, credentials: t, now });
}

/** The address of `key` in the bucket: path-style on a custom endpoint, virtual-hosted on AWS. */
const objectUrl = (t: S3Location, key: string): string => `${t.endpoint ? `${t.endpoint}/${t.bucket}` : `https://${t.bucket}.s3.${t.region}.amazonaws.com`}/${encodePath(key)}`;

/**
 * A presigned GET (Signature Version 4 in the query string): whoever holds
 * the URL reads that one object, and nothing else, for `seconds`.
 */
export function presign(t: Pick<S3Location, "region"> & S3Credentials, rawUrl: string, seconds: number, now: Date): string {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > PRESIGN_MAX_SECONDS) throw new StoreError(`a presigned link lives 1 to ${PRESIGN_MAX_SECONDS} seconds, not ${seconds}`);
  return presignV4({ url: rawUrl, region: t.region, service: "s3", credentials: t, seconds, now });
}

/** A condition on a PUT: the ETag the object must still have, or `*` for "there is no object yet". */
export type S3Condition = StoreCondition;

export class S3Client implements ObjectStore {
  private creds?: Promise<S3Credentials & { expiration?: Date }>;
  /** False once the store refused a conditional header (501), so writes go unconditional, as they did before it. */
  private conditional = true;

  constructor(readonly target: S3Target, private readonly fetchFn: S3Fetch = defaultFetch) {}

  get location(): string {
    return `s3://${this.target.bucket}`;
  }

  /** Static keys as given; a web identity's keys once per client, again a minute before they expire. */
  private async signer(): Promise<S3Location & S3Credentials> {
    const t = this.target;
    if (!("webIdentity" in t)) return t;
    const assume = (): Promise<S3Credentials & { expiration?: Date }> =>
      (this.creds = assumeRoleWithWebIdentity(t.webIdentity, this.fetchFn).catch((e: unknown) => {
        this.creds = undefined;
        throw e;
      }));
    let held = await (this.creds ?? assume());
    if (held.expiration && held.expiration.getTime() - Date.now() < 60_000) held = await assume();
    const { accessKeyId, secretAccessKey, sessionToken } = held;
    return { bucket: t.bucket, ...(t.endpoint ? { endpoint: t.endpoint } : {}), region: t.region, accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  }

  /**
   * Write an object; with `when`, only if it still holds. A write that lost
   * throws S3Conflict. The answer carries the new ETag when the store sends one.
   */
  async put(key: string, body: string | Uint8Array, contentType: string, when?: S3Condition): Promise<{ etag?: string }> {
    const cond: Record<string, string> = !when || !this.conditional ? {} : "ifMatch" in when ? { "if-match": when.ifMatch } : { "if-none-match": "*" };
    const { url, headers } = signRequest(await this.signer(), "PUT", key, body, new Date(), contentType, cond);
    const res = await this.fetchFn(url, { method: "PUT", headers, body });
    if (res.status === 501 && Object.keys(cond).length) {
      this.conditional = false;
      return this.put(key, body, contentType);
    }
    if (res.status === 412 || (res.status === 409 && Object.keys(cond).length)) throw new StoreConflict(`PUT s3://${this.target.bucket}/${key}: ${res.status}, it changed since it was read`);
    if (!res.ok) throw new StoreError(`PUT s3://${this.target.bucket}/${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const etag = res.headers?.get("etag") ?? undefined;
    return etag ? { etag } : {};
  }

  /** The object's text and ETag, or no text when there is none. */
  async read(key: string): Promise<{ body?: string; etag?: string }> {
    const { url, headers } = signRequest(await this.signer(), "GET", key, "");
    const res = await this.fetchFn(url, { method: "GET", headers });
    if (res.status === 404) return {};
    if (!res.ok) throw new StoreError(`GET s3://${this.target.bucket}/${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const etag = res.headers?.get("etag") ?? undefined;
    return { body: await res.text(), ...(etag ? { etag } : {}) };
  }

  /**
   * A presigned GET of `key` for `seconds`. `expires` is when it stops
   * working: then, or sooner when the keys that signed it expire first (an
   * assumed role's session).
   */
  async presign(key: string, seconds: number, now = new Date()): Promise<{ url: string; expires: Date }> {
    const t = await this.signer();
    const url = presign(t, objectUrl(t, key), seconds, now);
    let expires = new Date(now.getTime() + seconds * 1000);
    const held = this.creds ? await this.creds : undefined;
    if (held?.expiration && held.expiration < expires) expires = held.expiration;
    return { url, expires };
  }

  /** The object's text, or undefined when there is none. */
  async get(key: string): Promise<string | undefined> {
    return (await this.read(key)).body;
  }

  /**
   * The object's metadata and never its body: whether it exists, its ETag,
   * and its version id when the bucket keeps versions. S3 sends no version id
   * for a bucket whose versioning was never on, and `null` for an object
   * written while it was suspended; both read as no version.
   */
  async head(key: string): Promise<{ exists: boolean; etag?: string; versionId?: string }> {
    const { url, headers } = signRequest(await this.signer(), "HEAD", key, "");
    const res = await this.fetchFn(url, { method: "HEAD", headers });
    if (res.status === 404) return { exists: false };
    if (!res.ok) throw new StoreError(`HEAD s3://${this.target.bucket}/${key}: ${res.status}`);
    const etag = res.headers?.get("etag") ?? undefined;
    const version = res.headers?.get("x-amz-version-id") ?? undefined;
    return { exists: true, ...(etag ? { etag } : {}), ...(version && version !== "null" ? { versionId: version } : {}) };
  }

  /**
   * Write an object only when there is none (If-None-Match: *): true when
   * this write made it, false when one was there. Unlike put, a store that
   * refuses the condition fails the write: a lock must never be taken
   * unconditionally.
   */
  async putIfAbsent(key: string, body: string, contentType: string): Promise<boolean> {
    const { url, headers } = signRequest(await this.signer(), "PUT", key, body, new Date(), contentType, { "if-none-match": "*" });
    const res = await this.fetchFn(url, { method: "PUT", headers, body });
    if (res.status === 412 || res.status === 409) return false;
    if (res.status === 501) throw new StoreError(`PUT s3://${this.target.bucket}/${key}: the store does not take a conditional write (501)`);
    if (!res.ok) throw new StoreError(`PUT s3://${this.target.bucket}/${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return true;
  }

  /** One version of an object's text, by its version id; undefined when there is no such version. */
  async readVersion(key: string, versionId: string): Promise<string | undefined> {
    const t = await this.signer();
    const url = `${objectUrl(t, key)}?versionId=${encodeStrict(versionId)}`;
    const res = await this.fetchFn(url, { method: "GET", headers: sign(t, "GET", url, {}, sha256Hex(""), new Date()) });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new StoreError(`GET s3://${this.target.bucket}/${key}?versionId=${versionId}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.text();
  }

  /** Whether a version of an object is in the bucket, from a HEAD by its version id: its metadata, never its body. */
  async hasVersion(key: string, versionId: string): Promise<boolean> {
    const t = await this.signer();
    const url = `${objectUrl(t, key)}?versionId=${encodeStrict(versionId)}`;
    const res = await this.fetchFn(url, { method: "HEAD", headers: sign(t, "HEAD", url, {}, sha256Hex(""), new Date()) });
    // S3 answers 400 for a version id it never issued.
    if (res.status === 404 || res.status === 400) return false;
    if (!res.ok) throw new StoreError(`HEAD s3://${this.target.bucket}/${key}?versionId=${versionId}: ${res.status}`);
    return true;
  }

  /**
   * Every version the bucket keeps of one object, delete markers too, from
   * ListObjectVersions: each one's id, its LastModified and whether it is the
   * latest. Metadata only; it needs s3:ListBucketVersions. A bucket in
   * another region than the client's answers 301 with its region, and the
   * list is asked there.
   */
  async listVersions(key: string): Promise<ObjectVersion[]> {
    const t = await this.signer();
    let region = t.region;
    const out: ObjectVersion[] = [];
    let marker: { key: string; version: string } | undefined;
    let redirected = false;
    for (let page = 0; page < 1000; page++) {
      const at = { ...t, region };
      const query = [`prefix=${encodeStrict(key)}`, "versions=", ...(marker ? [`key-marker=${encodeStrict(marker.key)}`, `version-id-marker=${encodeStrict(marker.version)}`] : [])].join("&");
      const url = `${objectUrl(at, "")}?${query}`;
      const res = await this.fetchFn(url, { method: "GET", headers: sign(at, "GET", url, {}, sha256Hex(""), new Date()) });
      const moved = res.headers?.get("x-amz-bucket-region") ?? undefined;
      if ((res.status === 301 || res.status === 400) && moved && moved !== region && !t.endpoint && !redirected) {
        region = moved;
        redirected = true;
        continue;
      }
      const xml = await res.text();
      if (!res.ok) throw new StoreError(`list the versions of s3://${this.target.bucket}/${key}: ${res.status} ${[xmlText(xml, "Code"), xmlText(xml, "Message")].filter(Boolean).join(": ") || xml.slice(0, 300)}`);
      for (const [tag, deleted] of [["Version", false], ["DeleteMarker", true]] as const) {
        for (const b of xmlBlocks(xml, tag)) {
          const id = xmlText(b, "VersionId");
          const when = xmlText(b, "LastModified");
          // The prefix lists the lock file and any key that starts with this one: only the object itself counts.
          if (xmlText(b, "Key") !== key || !id || id === "null" || !when) continue;
          out.push({ version_id: id, written_at: new Date(when).toISOString(), latest: xmlText(b, "IsLatest") === "true", ...(deleted ? { deleted: true } : {}) });
        }
      }
      const nextKey = xmlText(xml, "NextKeyMarker");
      const nextVersion = xmlText(xml, "NextVersionIdMarker");
      if (xmlText(xml, "IsTruncated") !== "true" || !nextKey || !nextVersion) break;
      marker = { key: nextKey, version: nextVersion };
    }
    return out.sort((a, b) => Date.parse(b.written_at) - Date.parse(a.written_at));
  }

  /** Delete an object. One that is not there is deleted already. */
  async remove(key: string): Promise<void> {
    const { url, headers } = signRequest(await this.signer(), "DELETE", key, "");
    const res = await this.fetchFn(url, { method: "DELETE", headers });
    if (!res.ok && res.status !== 404) throw new StoreError(`DELETE s3://${this.target.bucket}/${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}
