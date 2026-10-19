/**
 * The bucket, for real: `chant-demo` in the stack's floci, path-style S3 over
 * http. floci takes unsigned requests, so the driver needs no AWS CLI on the
 * host. Readers get the same objects with a plain GetObject.
 */
import type { Bucket } from "./ports.js";

const TIMEOUT_MS = 30_000;

export class FlociBucket implements Bucket {
  /** `endpoint` is floci as the driver reaches it, http://localhost:<port>. */
  constructor(
    private readonly endpoint: string,
    private readonly bucket: string,
  ) {}

  private url(key = ""): string {
    return `${this.endpoint.replace(/\/$/, "")}/${this.bucket}${key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : ""}`;
  }

  /** The bucket itself. An existing one is kept. */
  async create(): Promise<void> {
    const res = await fetch(this.url(), { method: "PUT", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok && res.status !== 409) throw new Error(`floci PUT ${this.bucket} answered ${res.status}`);
  }

  async get(key: string): Promise<string | null> {
    const res = await fetch(this.url(key), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`floci GET ${key} answered ${res.status}`);
    return res.text();
  }

  async put(key: string, body: string, contentType: string): Promise<void> {
    const res = await fetch(this.url(key), {
      method: "PUT",
      headers: { "content-type": contentType },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`floci PUT ${key} answered ${res.status}`);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    for (;;) {
      const q = new URLSearchParams({ "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) });
      const res = await fetch(`${this.url()}?${q.toString()}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`floci list ${prefix} answered ${res.status}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(decodeXml(m[1]!));
      const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
      if (!next || !/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
      token = decodeXml(next);
    }
    return keys;
  }

  async delete(key: string): Promise<void> {
    const res = await fetch(this.url(key), { method: "DELETE", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok && res.status !== 404) throw new Error(`floci DELETE ${key} answered ${res.status}`);
  }
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
