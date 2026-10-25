/**
 * Azure Blob Storage for an azurerm backend's state, over its REST API with
 * `fetch` and `node:crypto`: a blob's properties and metadata, its text, a
 * write (under a lease when one holds it), a snapshot, a delete, and the
 * blob lease the backend locks a state with.
 *
 * Requests are signed with Shared Key for an account key, carry a SAS as it
 * is, or carry a storage token the job's OIDC identity is traded for at Entra
 * ID (a client assertion, the way the azurerm backend does it).
 *
 * Lifted from terragucci's `report/azure-blob.ts` (c493e0e), without SAS
 * links, version reads and version listing.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { defaultFetch, encodePath, StoreError, xmlText, type StoreFetch } from "./object-store";

/** The REST version every request names. */
export const AZURE_VERSION = "2021-08-06";

/** Entra ID's public cloud. */
export const AZURE_AUTHORITY = "https://login.microsoftonline.com";

const STORAGE_SCOPE = "https://storage.azure.com/.default";

export interface AzureLocation {
  account: string;
  container: string;
  /** The account's blob endpoint, no trailing slash: https://<account>.blob.core.windows.net, or an emulator's http://host:10000/<account>. */
  endpoint: string;
}

/** The job's federated identity: an Entra app or managed identity that trusts the forge's token. */
export interface AzureOidc {
  tenantId: string;
  clientId: string;
  tokenFile: string;
  /** Entra ID's address, https://host, no path. */
  authority: string;
}

export type AzureTarget = AzureLocation & ({ accountKey: string } | { oidc: AzureOidc } | { sas: string });

/** A blob's properties, as a HEAD answers them: never its body. */
export interface BlobHead {
  exists: boolean;
  etag?: string;
  /** x-ms-lease-state: `leased` while a lease holds it. */
  leaseState?: string;
  /** Its metadata, by name without the x-ms-meta- prefix. */
  metadata: Record<string, string>;
}

const hmac64 = (key: string, s: string): string => createHmac("sha256", Buffer.from(key, "base64")).update(s, "utf8").digest("base64");

/** The headers whose values Shared Key signs by position, in order. */
const SIGNED = ["content-encoding", "content-language", "content-length", "content-md5", "content-type", "date", "if-modified-since", "if-match", "if-none-match", "if-unmodified-since", "range"];

/** The Shared Key Authorization header for a request. */
export function sharedKey(account: string, accountKey: string, method: string, rawUrl: string, headers: Record<string, string>): string {
  const url = new URL(rawUrl);
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const fixed = SIGNED.map((n) => (n === "content-length" && h[n] === "0" ? "" : (h[n] ?? "")));
  const ms = Object.keys(h).filter((n) => n.startsWith("x-ms-")).sort().map((n) => `${n}:${h[n]!.trim()}\n`).join("");
  const params = new Map<string, string[]>();
  for (const [k, v] of url.searchParams) params.set(k.toLowerCase(), [...(params.get(k.toLowerCase()) ?? []), v]);
  const query = [...params.keys()].sort().map((k) => `\n${k}:${params.get(k)!.sort().join(",")}`).join("");
  const toSign = [method, ...fixed].join("\n") + "\n" + ms + `/${account}${url.pathname}` + query;
  return `SharedKey ${account}:${hmac64(accountKey, toSign)}`;
}

/** Entra ID's error, or the start of the body. */
const why = (text: string): string => {
  try {
    const j = JSON.parse(text) as { error?: string; error_description?: string };
    if (j.error) return [j.error, j.error_description?.split("\r\n")[0]].filter(Boolean).join(": ");
  } catch {
    // Not JSON: Blob Storage answers in XML.
  }
  return [xmlText(text, "Code"), xmlText(text, "Message")?.split("\n")[0]].filter(Boolean).join(": ") || text.slice(0, 300);
};

export class AzureBlobClient {
  private token?: Promise<{ token: string; expires: number }>;

  constructor(readonly target: AzureTarget, private readonly fetchFn: StoreFetch = defaultFetch, private readonly readToken: (file: string) => string = (f) => readFileSync(f, "utf-8")) {}

  private where(key: string): string {
    return `az://${this.target.account}/${this.target.container}/${key}`;
  }

  private blobUrl(key: string, query = ""): string {
    const t = this.target;
    const q = [query, "sas" in t ? t.sas.replace(/^\?/, "") : ""].filter(Boolean).join("&");
    return `${t.endpoint}/${t.container}/${encodePath(key)}${q ? `?${q}` : ""}`;
  }

  /** The storage token for the OIDC identity: once per client, again a minute before it expires. */
  private async bearer(o: AzureOidc): Promise<string> {
    const fetchToken = async (): Promise<{ token: string; expires: number }> => {
      let assertion: string;
      try {
        assertion = this.readToken(o.tokenFile).trim();
      } catch (e) {
        throw new StoreError(`cannot read the OIDC token in ${o.tokenFile}: ${(e as Error).message}`);
      }
      if (!assertion) throw new StoreError(`the OIDC token file ${o.tokenFile} is empty`);
      const body = new URLSearchParams({
        client_id: o.clientId,
        scope: STORAGE_SCOPE,
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }).toString();
      const res = await this.fetchFn(`${o.authority}/${o.tenantId}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
      const text = await res.text();
      if (!res.ok) throw new StoreError(`Entra ID refused the OIDC token for client ${o.clientId}: ${res.status} ${why(text)}`);
      let j: { access_token?: string; expires_in?: number | string } = {};
      try {
        j = JSON.parse(text) as typeof j;
      } catch {
        // Reported below as no token.
      }
      if (!j.access_token) throw new StoreError(`Entra ID answered client ${o.clientId} without a token`);
      return { token: j.access_token, expires: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
    };
    const again = (): Promise<{ token: string; expires: number }> =>
      (this.token = fetchToken().catch((e: unknown) => {
        this.token = undefined;
        throw e;
      }));
    let held = await (this.token ?? again());
    if (held.expires - Date.now() < 60_000) held = await again();
    return held.token;
  }

  /** The headers for one request, signed or with the bearer token. */
  private async headers(method: string, url: string, extra: Record<string, string>): Promise<Record<string, string>> {
    const h: Record<string, string> = { "x-ms-date": new Date().toUTCString(), "x-ms-version": AZURE_VERSION, ...extra };
    const t = this.target;
    if ("accountKey" in t) return { ...h, authorization: sharedKey(t.account, t.accountKey, method, url, h) };
    if ("sas" in t) return h;
    return { ...h, authorization: `Bearer ${await this.bearer(t.oidc)}` };
  }

  async get(key: string): Promise<string | undefined> {
    const url = this.blobUrl(key);
    const res = await this.fetchFn(url, { method: "GET", headers: await this.headers("GET", url, {}) });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new StoreError(`GET ${this.where(key)}: ${res.status} ${why(await res.text())}`);
    return res.text();
  }

  /** A blob's properties and metadata, from a HEAD. */
  async head(key: string): Promise<BlobHead> {
    const url = this.blobUrl(key);
    const res = await this.fetchFn(url, { method: "HEAD", headers: await this.headers("HEAD", url, {}) });
    if (res.status === 404) return { exists: false, metadata: {} };
    if (!res.ok) throw new StoreError(`HEAD ${this.where(key)}: ${res.status}`);
    const get = (n: string): string | undefined => res.headers?.get(n) ?? undefined;
    const metadata: Record<string, string> = {};
    const all = res.headers as unknown as { forEach?: (fn: (v: string, k: string) => void) => void } | undefined;
    all?.forEach?.((v, k) => {
      if (k.toLowerCase().startsWith("x-ms-meta-")) metadata[k.toLowerCase().slice("x-ms-meta-".length)] = v;
    });
    const etag = get("etag");
    const leaseState = get("x-ms-lease-state");
    return { exists: true, ...(etag ? { etag } : {}), ...(leaseState ? { leaseState } : {}), metadata };
  }

  /** Take a snapshot of a blob: its id, the time Azure gives it. */
  async snapshot(key: string): Promise<string> {
    const url = this.blobUrl(key, "comp=snapshot");
    const res = await this.fetchFn(url, { method: "PUT", headers: await this.headers("PUT", url, { "content-length": "0" }) });
    if (!res.ok) throw new StoreError(`snapshot of ${this.where(key)}: ${res.status} ${why(await res.text())}`);
    const id = res.headers?.get("x-ms-snapshot");
    if (!id) throw new StoreError(`snapshot of ${this.where(key)}: Azure answered without x-ms-snapshot`);
    return id;
  }

  /** Write a block blob with metadata, under a lease when one holds it; with `ifNoneMatch`, only when there is none (false when one was there). */
  async putBlob(key: string, body: string, contentType: string, options: { leaseId?: string; metadata?: Record<string, string>; ifNoneMatch?: boolean } = {}): Promise<boolean> {
    const url = this.blobUrl(key);
    const meta = Object.fromEntries(Object.entries(options.metadata ?? {}).map(([k, v]) => [`x-ms-meta-${k}`, v]));
    const extra: Record<string, string> = {
      "x-ms-blob-type": "BlockBlob",
      "content-type": contentType,
      "content-length": String(Buffer.byteLength(body)),
      ...meta,
      ...(options.leaseId ? { "x-ms-lease-id": options.leaseId } : {}),
      ...(options.ifNoneMatch ? { "if-none-match": "*" } : {}),
    };
    const res = await this.fetchFn(url, { method: "PUT", headers: await this.headers("PUT", url, extra), body });
    if (options.ifNoneMatch && (res.status === 409 || res.status === 412)) return false;
    if (!res.ok) throw new StoreError(`PUT ${this.where(key)}: ${res.status} ${why(await res.text())}`);
    return true;
  }

  /** Delete a blob. One that is not there is deleted already. */
  async remove(key: string): Promise<void> {
    const url = this.blobUrl(key);
    const res = await this.fetchFn(url, { method: "DELETE", headers: await this.headers("DELETE", url, {}) });
    if (!res.ok && res.status !== 404) throw new StoreError(`DELETE ${this.where(key)}: ${res.status} ${why(await res.text())}`);
  }

  /** A blob lease: acquire one that never expires with the id given (false when one holds it), or release it. */
  async lease(key: string, action: "acquire" | "release", id: string): Promise<boolean> {
    const url = this.blobUrl(key, "comp=lease");
    const extra: Record<string, string> = { "x-ms-lease-action": action, "content-length": "0", ...(action === "acquire" ? { "x-ms-lease-duration": "-1", "x-ms-proposed-lease-id": id } : { "x-ms-lease-id": id }) };
    const res = await this.fetchFn(url, { method: "PUT", headers: await this.headers("PUT", url, extra) });
    if (action === "acquire" && res.status === 409) return false;
    if (!res.ok) throw new StoreError(`${action} the lease of ${this.where(key)}: ${res.status} ${why(await res.text())}`);
    return true;
  }

  /** Set a blob's metadata, all of it, under its lease when one holds it. */
  async setMetadata(key: string, metadata: Record<string, string>, leaseId?: string): Promise<void> {
    const url = this.blobUrl(key, "comp=metadata");
    const extra = { "content-length": "0", ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`x-ms-meta-${k}`, v])), ...(leaseId ? { "x-ms-lease-id": leaseId } : {}) };
    const res = await this.fetchFn(url, { method: "PUT", headers: await this.headers("PUT", url, extra) });
    if (!res.ok) throw new StoreError(`set the metadata of ${this.where(key)}: ${res.status} ${why(await res.text())}`);
  }
}
