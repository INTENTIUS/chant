/**
 * Pieces the in-memory host fakes share (chant#4605): reading a request's
 * headers and body as a fetch caller passes them, JSON answers, basic and
 * bearer header parsing, and a module tarball builder, so a test (in chant
 * or in terragucci#1302) can make a real attested archive to publish.
 */
import { gzipSync } from "node:zlib";

/** One request a fake was sent. */
export interface FakeRequest {
  method: string;
  url: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  body?: Uint8Array;
}

/** The fetch a fake answers: both the target's `fetch` and the reader's `registryFetch`. */
export type FakeFetch = (url: string, init?: { method?: string; headers?: unknown; body?: unknown }) => Promise<Response>;

export function headersOf(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof (h as Headers).forEach === "function" && typeof (h as Headers).get === "function") {
    (h as Headers).forEach((v, k) => (out[k.toLowerCase()] = v));
    return out;
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = String(v);
  return out;
}

export function bodyOf(b: unknown): Uint8Array | undefined {
  if (b === undefined || b === null) return undefined;
  if (typeof b === "string") return new TextEncoder().encode(b);
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  throw new Error("the fake takes a string or bytes as a body");
}

export const jsonAnswer = (status: number, doc: unknown): Response => new Response(JSON.stringify(doc), { status, headers: { "content-type": "application/json" } });

/** The user and password of a `Basic` header, or undefined. */
export function basicOf(authorization: string | undefined): { user: string; password: string } | undefined {
  const m = /^Basic (.+)$/i.exec(authorization ?? "");
  if (!m) return undefined;
  const text = Buffer.from(m[1]!, "base64").toString("utf-8");
  const at = text.indexOf(":");
  return at < 0 ? undefined : { user: text.slice(0, at), password: text.slice(at + 1) };
}

/** The token of a `Bearer` header, or undefined. */
export const bearerOf = (authorization: string | undefined): string | undefined => /^Bearer (.+)$/i.exec(authorization ?? "")?.[1];

/** A ustar header block for one entry. */
function tarHeader(path: string, size: number, type: "0" | "5", mode: number, mtime: number): Buffer {
  const h = Buffer.alloc(512);
  const put = (text: string, at: number, len: number) => h.write(text.slice(0, len), at, len, "utf-8");
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(path, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(mtime, 12), 136, 12);
  h.fill(0x20, 148, 156);
  h.write(type, 156, 1, "latin1");
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

/**
 * A module tarball as the bucket registry serves one: a gzip of a ustar
 * archive with the given files at its root (paths under 100 bytes), each
 * directory written before its files.
 */
export function moduleTarball(files: Record<string, string | Uint8Array>, mtime = 1_700_000_000): Buffer {
  const blocks: Buffer[] = [];
  const dirs = new Set<string>();
  for (const path of Object.keys(files).sort()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (dirs.has(dir)) continue;
      dirs.add(dir);
      blocks.push(tarHeader(`${dir}/`, 0, "5", 0o755, mtime));
    }
    const raw = files[path]!;
    const data = typeof raw === "string" ? Buffer.from(raw, "utf-8") : Buffer.from(raw);
    blocks.push(tarHeader(path, data.length, "0", 0o644, mtime), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
