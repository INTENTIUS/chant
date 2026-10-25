/**
 * Google Cloud Storage for a gcs backend's state, over its JSON API with
 * `fetch` and `node:crypto`: an object's text and generation, a write, a
 * write only when there is no object (the lock), and a delete.
 *
 * The identity, first match wins: a bearer token (`access_token`, or
 * GOOGLE_OAUTH_ACCESS_TOKEN), else a credentials file or its JSON:
 *
 *   external_account  the job's OIDC token, traded at Google's STS, then the
 *                     service account it impersonates.
 *   service_account   a key: requests carry a self-signed JWT.
 *
 * With `impersonate_service_account`, every request carries that service
 * account's token, which the identity asks IAM for.
 *
 * Lifted from terragucci's `report/gcs.ts` (c493e0e), without signed URLs,
 * version listing and the re-plan's traded tokens.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { defaultFetch, encodeStrict, StoreConflict, StoreError, type StoreFetch } from "./object-store";

export const GCS_ENDPOINT = "https://storage.googleapis.com";
/** IAM Credentials, where a token for an impersonated service account comes from. */
export const IAM_CREDENTIALS = "https://iamcredentials.googleapis.com";
const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";
const READ_WRITE = "https://www.googleapis.com/auth/devstorage.read_write";

export interface GcsTarget {
  bucket: string;
  /** The JSON API's address, no trailing slash. Default https://storage.googleapis.com. */
  endpoint: string;
  /** The credentials file, read at the first request. */
  credentialsFile?: string;
  /** The credentials as JSON: a gcs backend's `credentials` given inline. */
  credentialsJson?: string;
  /** A bearer token used as it is. */
  accessToken?: string;
  /** The service account every request acts as, through IAM's generateAccessToken. */
  impersonate?: string;
  /** IAM Credentials' address, no trailing slash. */
  iamEndpoint?: string;
}

interface ExternalAccount {
  type: "external_account";
  audience: string;
  subject_token_type: string;
  token_url: string;
  service_account_impersonation_url?: string;
  credential_source: { file?: string; url?: string; headers?: Record<string, string>; format?: { type?: string; subject_token_field_name?: string } };
}

interface ServiceAccountKey {
  type: "service_account";
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

type Credentials = ExternalAccount | ServiceAccountKey;

const b64url = (b: string | Buffer): string => Buffer.from(b).toString("base64url");

/** A JWT the key signs for itself, which Google's APIs take as an access token for the scope it names. */
export function selfSignedJwt(key: ServiceAccountKey, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) }));
  const body = b64url(JSON.stringify({ iss: key.client_email, sub: key.client_email, scope: READ_WRITE, iat, exp: iat + 3600 }));
  return `${head}.${body}.${createSign("RSA-SHA256").update(`${head}.${body}`).sign(key.private_key).toString("base64url")}`;
}

/** Google's error message, or the start of the body. */
const why = (text: string): string => {
  try {
    const j = JSON.parse(text) as { error?: string | { message?: string }; error_description?: string };
    if (typeof j.error === "object" && j.error?.message) return j.error.message;
    if (typeof j.error === "string") return [j.error, j.error_description].filter(Boolean).join(": ");
  } catch {
    // Not JSON.
  }
  return text.slice(0, 300);
};

type Token = { token: string; expires: number };

export class GcsClient {
  private creds?: Credentials;
  private token?: Promise<Token>;

  constructor(readonly target: GcsTarget, private readonly fetchFn: StoreFetch = defaultFetch, private readonly readFile: (file: string) => string = (f) => readFileSync(f, "utf-8")) {}

  private where(key: string): string {
    return `gs://${this.target.bucket}/${key}`;
  }

  private credentials(): Credentials {
    if (this.creds) return this.creds;
    const source = this.target.credentialsFile ?? "the backend's credentials";
    let c: Partial<Credentials>;
    try {
      c = JSON.parse(this.target.credentialsJson ?? this.readFile(this.target.credentialsFile ?? "")) as Partial<Credentials>;
    } catch (e) {
      throw new StoreError(`cannot read the credentials in ${source}: ${(e as Error).message}`);
    }
    if (c.type === "external_account" && c.token_url && c.audience && c.credential_source && (c.credential_source.file || c.credential_source.url)) return (this.creds = c as ExternalAccount);
    if (c.type === "service_account" && c.client_email && c.private_key) return (this.creds = c as ServiceAccountKey);
    throw new StoreError(`${source} is not an external_account file with a credential_source file or url, nor a service_account key`);
  }

  private async post(url: string, headers: Record<string, string>, body: string, what: string): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(url, { method: "POST", headers, body });
    const text = await res.text();
    if (!res.ok) throw new StoreError(`${what}: ${res.status} ${why(text)}`);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new StoreError(`${what}: the answer is not JSON`);
    }
  }

  /** The job's OIDC token, from the file or URL the credentials name. */
  private async subjectToken(c: ExternalAccount): Promise<string> {
    const src = c.credential_source;
    let text: string;
    if (src.file) {
      try {
        text = this.readFile(src.file);
      } catch (e) {
        throw new StoreError(`cannot read the OIDC token in ${src.file}: ${(e as Error).message}`);
      }
    } else {
      const res = await this.fetchFn(src.url!, { method: "GET", headers: src.headers ?? {} });
      text = await res.text();
      if (!res.ok) throw new StoreError(`the OIDC token at ${src.url!.split("?")[0]}: ${res.status} ${why(text)}`);
    }
    const field = src.format?.type === "json" ? src.format.subject_token_field_name : undefined;
    let token = text.trim();
    if (field) {
      try {
        token = String((JSON.parse(text) as Record<string, unknown>)[field] ?? "");
      } catch {
        throw new StoreError(`the job's OIDC token is not JSON with ${field}`);
      }
    }
    if (!token) throw new StoreError("the job's OIDC token is empty");
    return token;
  }

  private async impersonateWith(url: string, bearer: string, sa: string): Promise<Token> {
    const r = await this.post(url, { "content-type": "application/json", authorization: `Bearer ${bearer}` }, JSON.stringify({ scope: [CLOUD_PLATFORM], lifetime: "3600s" }), `impersonating ${sa}`);
    if (typeof r.accessToken !== "string") throw new StoreError(`IAM answered the impersonation of ${sa} without a token`);
    const at = typeof r.expireTime === "string" ? Date.parse(r.expireTime) : NaN;
    return { token: r.accessToken, expires: Number.isNaN(at) ? Date.now() + 3600_000 : at };
  }

  /** STS's federated token, then the impersonated service account's, when the credentials name one. */
  private async exchange(c: ExternalAccount): Promise<Token> {
    const sts = await this.post(
      c.token_url,
      { "content-type": "application/x-www-form-urlencoded" },
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience: c.audience,
        scope: CLOUD_PLATFORM,
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        subject_token: await this.subjectToken(c),
        subject_token_type: c.subject_token_type,
      }).toString(),
      `Google STS refused the OIDC token for ${c.audience}`,
    );
    if (typeof sts.access_token !== "string") throw new StoreError("Google STS answered without a token");
    const fed = { token: sts.access_token, expires: Date.now() + Number(sts.expires_in ?? 3600) * 1000 };
    if (!c.service_account_impersonation_url) return fed;
    return this.impersonateWith(c.service_account_impersonation_url, fed.token, "the service account");
  }

  /** The identity's own token: the one the target gives, a key's self-signed JWT, or STS's for the OIDC token. */
  private async own(): Promise<Token> {
    if (this.target.accessToken) return { token: this.target.accessToken, expires: Date.now() + 3600_000 };
    const c = this.credentials();
    return c.type === "service_account" ? { token: selfSignedJwt(c, new Date()), expires: Date.now() + 3600_000 } : this.exchange(c);
  }

  /** An access token: once per client, again a minute before it expires. */
  private async bearer(): Promise<string> {
    const sa = this.target.impersonate;
    const fresh = async (): Promise<Token> => {
      if (!sa) return this.own();
      const base = await this.own();
      return this.impersonateWith(`${(this.target.iamEndpoint ?? IAM_CREDENTIALS).replace(/\/+$/, "")}/v1/projects/-/serviceAccounts/${encodeURIComponent(sa)}:generateAccessToken`, base.token, sa);
    };
    const again = (): Promise<Token> =>
      (this.token = fresh().catch((e: unknown) => {
        this.token = undefined;
        throw e;
      }));
    let held = await (this.token ?? again());
    if (held.expires - Date.now() < 60_000) held = await again();
    return held.token;
  }

  private objectUrl(key: string): string {
    return `${this.target.endpoint}/storage/v1/b/${encodeURIComponent(this.target.bucket)}/o/${encodeStrict(key)}`;
  }

  /** Write an object; with `ifGenerationMatch`, only when the object still has that generation (`0`: there is none), else StoreConflict. */
  async put(key: string, body: string, contentType: string, ifGenerationMatch?: string): Promise<void> {
    const t = this.target;
    const url = `${t.endpoint}/upload/storage/v1/b/${encodeURIComponent(t.bucket)}/o?uploadType=media&name=${encodeStrict(key)}${ifGenerationMatch !== undefined ? `&ifGenerationMatch=${encodeStrict(ifGenerationMatch)}` : ""}`;
    const res = await this.fetchFn(url, { method: "POST", headers: { "content-type": contentType, authorization: `Bearer ${await this.bearer()}` }, body });
    if (res.status === 412) throw new StoreConflict(`PUT ${this.where(key)}: 412, it changed since it was read`);
    if (!res.ok) throw new StoreError(`PUT ${this.where(key)}: ${res.status} ${why(await res.text())}`);
  }

  async get(key: string): Promise<string | undefined> {
    const res = await this.fetchFn(`${this.objectUrl(key)}?alt=media`, { method: "GET", headers: { authorization: `Bearer ${await this.bearer()}` } });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new StoreError(`GET ${this.where(key)}: ${res.status} ${why(await res.text())}`);
    return res.text();
  }

  /** An object's metadata and never its body: whether it is there, and its generation. */
  async head(key: string): Promise<{ exists: boolean; generation?: string }> {
    const res = await this.fetchFn(this.objectUrl(key), { method: "GET", headers: { authorization: `Bearer ${await this.bearer()}` } });
    const text = await res.text();
    if (res.status === 404) return { exists: false };
    if (!res.ok) throw new StoreError(`GET ${this.where(key)} metadata: ${res.status} ${why(text)}`);
    let g: unknown;
    try {
      g = (JSON.parse(text) as { generation?: unknown }).generation;
    } catch {
      // Metadata that is not JSON: no generation.
    }
    return { exists: true, ...(g !== undefined && g !== null && g !== "" ? { generation: String(g) } : {}) };
  }

  /** Write an object only when there is none (ifGenerationMatch=0): true when this write made it, false when one was there. */
  async putIfAbsent(key: string, body: string, contentType: string): Promise<boolean> {
    try {
      await this.put(key, body, contentType, "0");
      return true;
    } catch (e) {
      if (e instanceof StoreConflict) return false;
      throw e;
    }
  }

  /** Delete an object's live generation. One that is not there is deleted already. */
  async remove(key: string): Promise<void> {
    const res = await this.fetchFn(this.objectUrl(key), { method: "DELETE", headers: { authorization: `Bearer ${await this.bearer()}` } });
    if (!res.ok && res.status !== 404) throw new StoreError(`DELETE ${this.where(key)}: ${res.status} ${why(await res.text())}`);
  }
}
