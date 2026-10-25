/**
 * The little of S3 a state's lock and write need: get, put, put only when
 * absent, head and delete one object, signed with AWS Signature Version 4
 * from `node:crypto`. Any S3-compatible store answers it (S3, MinIO, floci).
 * With no static keys, a role is assumed with the job's OIDC token through
 * STS AssumeRoleWithWebIdentity. `fetch` is injectable so the signing is
 * tested against recorded requests.
 *
 * Lifted from terragucci's `report/s3.ts` (c493e0e), without presigning,
 * version listing and the re-plan's traded credentials.
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { defaultFetch, encodePath, encodeStrict, StoreError, xmlText, type StoreFetch } from "./object-store";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** A role to assume with the job's OIDC token, the way the AWS SDKs read `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE`. */
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

/**
 * The target for `bucket` from the AWS environment variables. Credentials,
 * first match wins: static keys in `AWS_ACCESS_KEY_ID` and
 * `AWS_SECRET_ACCESS_KEY`; `AWS_ROLE_ARN` assumed with the token in
 * `AWS_WEB_IDENTITY_TOKEN_FILE`.
 */
export function s3FromEnv(where: { bucket: string; endpoint?: string }, env: NodeJS.ProcessEnv = process.env): S3Target {
  const endpoint = where.endpoint ?? env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL;
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
  const at = { bucket: where.bucket, ...(endpoint ? { endpoint: endpoint.replace(/\/+$/, "") } : {}), region };
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) return { ...at, accessKeyId, secretAccessKey, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) };
  const tokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE;
  if (env.AWS_ROLE_ARN && tokenFile) {
    return {
      ...at,
      webIdentity: {
        roleArn: env.AWS_ROLE_ARN,
        tokenFile,
        sessionName: env.AWS_ROLE_SESSION_NAME || "chant-state",
        endpoint: (env.AWS_ENDPOINT_URL_STS || env.AWS_ENDPOINT_URL || `https://sts.${region}.amazonaws.com`).replace(/\/+$/, ""),
      },
    };
  }
  throw new StoreError("set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE");
}

/** STS AssumeRoleWithWebIdentity. The request carries the token and is not signed. */
export async function assumeRoleWithWebIdentity(w: S3WebIdentity, fetchFn: StoreFetch, readToken: (file: string) => string = (f) => readFileSync(f, "utf-8")): Promise<S3Credentials & { expiration?: Date }> {
  let token: string;
  try {
    token = readToken(w.tokenFile).trim();
  } catch (e) {
    throw new StoreError(`cannot read the OIDC token in ${w.tokenFile}: ${(e as Error).message}`);
  }
  if (!token) throw new StoreError(`the OIDC token file ${w.tokenFile} is empty`);
  const body = new URLSearchParams({ Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: w.roleArn, RoleSessionName: w.sessionName, WebIdentityToken: token }).toString();
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

const sha256 = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");
const hmac = (key: string | Buffer, s: string): Buffer => createHmac("sha256", key).update(s).digest();

/** Signature Version 4 headers for a request; its query string, if any, is signed in canonical order. `extra` headers are signed too. */
export function sign(t: Pick<S3Location, "region"> & S3Credentials, method: string, rawUrl: string, extra: Record<string, string>, payload: string, now: Date, service = "s3"): Record<string, string> {
  const url = new URL(rawUrl);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payload,
    "x-amz-date": amzDate,
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
    ...(t.sessionToken ? { "x-amz-security-token": t.sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const query = [...url.searchParams].map(([k, v]) => `${encodeStrict(k)}=${encodeStrict(v)}`).sort().join("&");
  const canonical = [method, url.pathname, query, ...names.map((n) => `${n}:${headers[n]!.trim()}`), "", names.join(";"), payload].join("\n");
  const scope = `${day}/${t.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key4 = hmac(hmac(hmac(hmac(`AWS4${t.secretAccessKey}`, day), t.region), service), "aws4_request");
  const signature = createHmac("sha256", key4).update(toSign).digest("hex");
  const { host: _host, ...sent } = headers;
  return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${t.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

/** The address of `key` in the bucket: path-style on a custom endpoint, virtual-hosted on AWS. */
const objectUrl = (t: S3Location, key: string): string => `${t.endpoint ? `${t.endpoint}/${t.bucket}` : `https://${t.bucket}.s3.${t.region}.amazonaws.com`}/${encodePath(key)}`;

export class S3Client {
  private creds?: Promise<S3Credentials & { expiration?: Date }>;

  constructor(readonly target: S3Target, private readonly fetchFn: StoreFetch = defaultFetch) {}

  private where(key: string): string {
    return `s3://${this.target.bucket}/${key}`;
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

  private async request(method: string, key: string, body: string, extra: Record<string, string> = {}) {
    const t = await this.signer();
    const url = objectUrl(t, key);
    return this.fetchFn(url, { method, headers: sign(t, method, url, extra, sha256(body), new Date()), ...(method === "PUT" ? { body } : {}) });
  }

  /** Write an object, unconditionally. */
  async put(key: string, body: string, contentType: string): Promise<void> {
    const res = await this.request("PUT", key, body, { "content-type": contentType });
    if (!res.ok) throw new StoreError(`PUT ${this.where(key)}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  /** The object's text, or undefined when there is none. */
  async get(key: string): Promise<string | undefined> {
    const res = await this.request("GET", key, "");
    if (res.status === 404) return undefined;
    if (!res.ok) throw new StoreError(`GET ${this.where(key)}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.text();
  }

  /** The object's metadata and never its body: whether it exists, its ETag and its version id. */
  async head(key: string): Promise<{ exists: boolean; etag?: string; versionId?: string }> {
    const res = await this.request("HEAD", key, "");
    if (res.status === 404) return { exists: false };
    if (!res.ok) throw new StoreError(`HEAD ${this.where(key)}: ${res.status}`);
    const etag = res.headers?.get("etag") ?? undefined;
    const version = res.headers?.get("x-amz-version-id") ?? undefined;
    return { exists: true, ...(etag ? { etag } : {}), ...(version && version !== "null" ? { versionId: version } : {}) };
  }

  /**
   * Write an object only when there is none (If-None-Match: *): true when
   * this write made it, false when one was there. A store that refuses the
   * condition fails the write: a lock is never taken unconditionally.
   */
  async putIfAbsent(key: string, body: string, contentType: string): Promise<boolean> {
    const res = await this.request("PUT", key, body, { "content-type": contentType, "if-none-match": "*" });
    if (res.status === 412 || res.status === 409) return false;
    if (res.status === 501) throw new StoreError(`PUT ${this.where(key)}: the store does not take a conditional write (501)`);
    if (!res.ok) throw new StoreError(`PUT ${this.where(key)}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return true;
  }

  /** Delete an object. One that is not there is deleted already. */
  async remove(key: string): Promise<void> {
    const res = await this.request("DELETE", key, "");
    if (!res.ok && res.status !== 404) throw new StoreError(`DELETE ${this.where(key)}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}
