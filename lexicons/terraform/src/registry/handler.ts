/**
 * Answering registry requests as the CLIs need them: each file as stored,
 * except a version's `download`, which goes out as `downloadAnswer` (200, the
 * JSON body, and `X-Terraform-Get` from the body's location; terragucci#1287).
 *
 * `registryHandler` is a web-standard `(Request) => Response` with no Node
 * imports, so the same code answers in an edge function (chant#4566), in a
 * test as a fetch (`handlerFetch`), and on a loopback socket through
 * `serveRegistry` in ./serve, which real `terraform init` and `tofu init`
 * runs point at.
 */
import { keyFor } from "./address";
import type { RegistryFetch } from "./reader";
import { downloadAnswer, downloadLocation, isDownloadPath } from "./writer";

/** Where the handler reads the registry's files: a key in, the bytes out (or none). */
export type RegistryFiles = (key: string) => Promise<{ body?: string | Uint8Array }>;

/** A registry held by a store with a text `read` (a bucket client, a test's map). Tarballs need a store that reads bytes. */
export const storeFiles = (store: { read(key: string): Promise<{ body?: string | Uint8Array }> }): RegistryFiles => (key) => store.read(key);

export interface RegistryHandlerOptions {
  /** The registry's prefix in its store: URL path `p` reads key `<prefix>/p`. */
  prefix?: string;
  /** Called once per request, for a test's log: method, path and the status sent. */
  log?: (line: string) => void;
}

export type RegistryHandler = (request: Request) => Promise<Response>;

/**
 * The pages a release catalog writes beside the registry (chant#4599,
 * `<prefix>/catalog/`), by extension, so a browser renders them instead of
 * downloading them.
 */
const PAGE_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** The `content-type` a registry file is served with. */
export const registryContentType = (key: string): string => {
  if (key.endsWith(".tar.gz") || key.endsWith(".tgz")) return "application/gzip";
  if (key.endsWith(".json") || /(^|\/)(versions|download)$/.test(key)) return "application/json";
  const dot = key.lastIndexOf(".");
  return (dot > key.lastIndexOf("/") && PAGE_TYPES[key.slice(dot).toLowerCase()]) || "application/octet-stream";
};

// TextEncoder and TextDecoder, not Buffer: an edge runtime (a Cloudflare Worker without nodejs_compat) has no Buffer.
const asText = (body: string | Uint8Array): string => (typeof body === "string" ? body : new TextDecoder().decode(body));

/** Answers GET and HEAD for a registry's files, adding `X-Terraform-Get` to each download answer. */
export function registryHandler(files: RegistryFiles, options: RegistryHandlerOptions = {}): RegistryHandler {
  return async (request) => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const done = (res: Response): Response => {
      options.log?.(`${method} ${url.pathname} -> ${res.status}`);
      return res;
    };
    if (method !== "GET" && method !== "HEAD") return done(new Response(null, { status: 405, headers: { allow: "GET, HEAD" } }));
    let path: string;
    try {
      path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    } catch {
      return done(new Response(null, { status: 400 }));
    }
    if (!path || path.split("/").includes("..")) return done(new Response(null, { status: 404 }));
    const key = keyFor(options.prefix, path);
    const { body } = await files(key);
    if (body === undefined) return done(new Response(null, { status: 404 }));
    if (isDownloadPath(path)) {
      const location = downloadLocation(asText(body));
      if (location) {
        const answer = downloadAnswer(location);
        return done(new Response(method === "HEAD" ? null : answer.body, { status: answer.status, headers: answer.headers }));
      }
    }
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const headers = { "content-type": registryContentType(key), "content-length": String(bytes.byteLength) };
    return done(new Response(method === "HEAD" ? null : new Uint8Array(bytes), { status: 200, headers }));
  };
}

/** A fetch that answers from a handler in process, for tests that need no socket. */
export const handlerFetch = (handler: RegistryHandler): RegistryFetch => (url, init) => handler(new Request(url, { method: init?.method ?? "GET", ...(init?.headers ? { headers: init.headers } : {}) }));

