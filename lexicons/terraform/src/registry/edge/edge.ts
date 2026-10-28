/**
 * The edge function in front of a bucket-hosted module registry (chant#4566),
 * built on `registryHandler`. It does three things:
 *
 * - Adds `X-Terraform-Get` to every download answer, which is what Terraform
 *   installs from (terragucci#1287). Always on.
 * - With `auth` set, checks the bearer token Terraform and OpenTofu send for
 *   the host (`TF_TOKEN_<host>` or credentials.tfrc.json) on discovery,
 *   `versions`, `download` and every other file, and answers 401 when it is
 *   missing or wrong. Off by default.
 * - With `auth` set, a download whose location is a tarball behind this same
 *   host is answered with a short-lived signed URL, so the CLIs' tarball fetch
 *   (go-getter, which sends no token) needs no `.netrc`. With auth off the
 *   location is the tarball's plain URL, as stored.
 * - With `auth` set, a provider mirror's `<version>.json` (chant#4564) is
 *   answered with each archive's URL signed the same way, so the CLIs'
 *   archive fetch passes too.
 *
 * Only web-standard APIs (Request, Response, URL, crypto.subtle,
 * TextEncoder), so the same code runs in a Cloudflare Worker, Lambda@Edge on
 * Node 20, Deno, or a test. Adapters for the first two are in ./worker and
 * ./lambda-edge.
 */
import { DISCOVERY, keyFor } from "../address";
import { registryHandler, type RegistryFiles } from "../handler";
import { isMirrorVersionPath } from "../mirror-paths";
import { downloadAnswer, downloadLocation, isDownloadPath } from "../writer";

/** Read auth: the tokens accepted and how tarball URLs are signed. */
export interface EdgeAuth {
  /** Accepted bearer tokens. Keep two while one is rotated out. */
  tokens: string[];
  /** The key tarball URLs are signed with. Default: the first token. */
  signingKey?: string;
  /** Seconds a signed tarball URL works. Default 300. */
  ttl?: number;
}

export interface RegistryEdgeOptions {
  /** Where the registry's files are read: the bucket behind the function. */
  files: RegistryFiles;
  /** The registry's prefix in the bucket. */
  prefix?: string;
  /** Read auth. Absent (the default) means anyone who can reach the host reads. */
  auth?: EdgeAuth;
  /** Milliseconds since the epoch; a test fixes it. Default `Date.now`. */
  now?: () => number;
  /** Called once per request: method, path and the status sent. Never given a token. */
  log?: (line: string) => void;
}

/** The query parameters a signed tarball URL carries. */
export const SIGNED_EXPIRES = "expires";
export const SIGNED_SIGNATURE = "signature";
/** Default lifetime of a signed tarball URL, in seconds. */
export const DEFAULT_SIGNED_TTL = 300;

const encoder = new TextEncoder();

const base64url = (bytes: ArrayBuffer): string => {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const hmac = async (key: string, text: string): Promise<string> => {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", k, encoder.encode(text)));
};

/** Compares two strings in time that depends only on their lengths. */
const sameText = (a: string, b: string): boolean => {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
};

const signingKeyOf = (auth: EdgeAuth): string | undefined => auth.signingKey || auth.tokens.find((t) => !!t);

/** What a signature covers: the path and the expiry, so a URL can't be moved to another file or extended. */
const signedText = (pathname: string, expires: number): string => `${pathname}\n${expires}`;

/** A location with `expires` and `signature` added, valid for `ttl` seconds from `nowMs`. */
export async function signLocation(location: string, key: string, nowMs: number, ttl = DEFAULT_SIGNED_TTL): Promise<string> {
  const url = new URL(location);
  const expires = Math.floor(nowMs / 1000) + ttl;
  url.searchParams.delete(SIGNED_EXPIRES);
  url.searchParams.delete(SIGNED_SIGNATURE);
  url.searchParams.set(SIGNED_EXPIRES, String(expires));
  url.searchParams.set(SIGNED_SIGNATURE, await hmac(key, signedText(url.pathname, expires)));
  return url.toString();
}

/** Whether a URL carries a signature this key made for its path that has not expired. */
export async function verifySignedUrl(url: URL, key: string, nowMs: number): Promise<boolean> {
  const expires = Number(url.searchParams.get(SIGNED_EXPIRES));
  const signature = url.searchParams.get(SIGNED_SIGNATURE);
  if (!signature || !Number.isInteger(expires) || expires * 1000 < nowMs) return false;
  return sameText(signature, await hmac(key, signedText(url.pathname, expires)));
}

/** Whether a request carries one of the accepted bearer tokens. */
export function bearerAccepted(request: Request, tokens: string[]): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!m) return false;
  const given = m[1]!.trim();
  // Check every token, so the time taken doesn't say which one matched.
  let ok = false;
  for (const t of tokens) if (t && sameText(given, t)) ok = true;
  return ok;
}

const unauthorized = (): Response => new Response(`${JSON.stringify({ errors: ["a token is required: set TF_TOKEN_<host> or a credentials block for this host"] })}\n`, { status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="terraform-registry"' } });

/** A tarball behind this host: the location's origin is the request's, and it names an archive. */
const isOwnTarball = (location: URL, request: URL): boolean => location.origin === request.origin && /\.(tar\.gz|tgz|zip)$/.test(location.pathname);

/**
 * The part of the function that decides before the bucket is read: a 401, a
 * download answer, or undefined for "serve this file from the bucket as it is".
 * Lambda@Edge uses this on its own and lets CloudFront fetch the rest.
 */
export function registryEdgeGate(options: RegistryEdgeOptions): (request: Request) => Promise<Response | undefined> {
  const now = options.now ?? Date.now;
  return async (request) => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const done = (res: Response): Response => {
      options.log?.(`${method} ${url.pathname} -> ${res.status}`);
      return res;
    };
    const path = url.pathname.replace(/^\/+/, "");
    const auth = options.auth;
    if (auth) {
      const protocolFile = path === DISCOVERY || isDownloadPath(path) || /(^|\/)versions$/.test(path);
      let allowed = bearerAccepted(request, auth.tokens);
      // A signed URL opens one file that is not a protocol answer: the tarball the download named.
      const key = signingKeyOf(auth);
      if (!allowed && !protocolFile && key) allowed = await verifySignedUrl(url, key, now());
      if (!allowed) return done(unauthorized());
    }
    if (method !== "GET" && method !== "HEAD") return undefined;
    if (auth && isMirrorVersionPath(path)) return signedMirrorVersion(request, url, path, options, auth, now(), done);
    if (!isDownloadPath(path)) return undefined;
    let file: { body?: string | Uint8Array };
    try {
      file = await options.files(keyFor(options.prefix, path));
    } catch {
      return done(new Response(null, { status: 502 }));
    }
    if (file.body === undefined) return done(new Response(null, { status: 404 }));
    let location = downloadLocation(typeof file.body === "string" ? file.body : new TextDecoder().decode(file.body));
    if (!location) return undefined;
    const key = auth ? signingKeyOf(auth) : undefined;
    if (auth && key) {
      const resolved = new URL(location, url);
      if (isOwnTarball(resolved, url)) location = await signLocation(resolved.toString(), key, now(), auth.ttl);
    }
    const answer = downloadAnswer(location);
    return done(new Response(method === "HEAD" ? null : answer.body, { status: answer.status, headers: answer.headers }));
  };
}

/** A mirror version file with each archive on this host signed; undefined (served as stored) when it is not the protocol's JSON. */
async function signedMirrorVersion(request: Request, url: URL, path: string, options: RegistryEdgeOptions, auth: EdgeAuth, nowMs: number, done: (res: Response) => Response): Promise<Response | undefined> {
  const key = signingKeyOf(auth);
  if (!key) return undefined;
  let file: { body?: string | Uint8Array };
  try {
    file = await options.files(keyFor(options.prefix, path));
  } catch {
    return done(new Response(null, { status: 502 }));
  }
  if (file.body === undefined) return done(new Response(null, { status: 404 }));
  let doc: { archives?: Record<string, { url?: unknown }> };
  try {
    doc = JSON.parse(typeof file.body === "string" ? file.body : new TextDecoder().decode(file.body));
  } catch {
    return undefined;
  }
  for (const archive of Object.values(doc.archives ?? {})) {
    if (!archive || typeof archive.url !== "string") continue;
    const resolved = new URL(archive.url, url);
    if (resolved.origin === url.origin) archive.url = await signLocation(resolved.toString(), key, nowMs, auth.ttl);
  }
  const body = `${JSON.stringify(doc)}\n`;
  return done(new Response(request.method.toUpperCase() === "HEAD" ? null : body, { status: 200, headers: { "content-type": "application/json" } }));
}

/** The whole function: the gate, then every other file served from the bucket by `registryHandler`. */
export function registryEdge(options: RegistryEdgeOptions): (request: Request) => Promise<Response> {
  const gate = registryEdgeGate(options);
  const serve = registryHandler(options.files, { prefix: options.prefix, log: options.log });
  return async (request) => (await gate(request)) ?? serve(request);
}

/** Registry files read from an origin over HTTP: a public bucket endpoint, a website endpoint, or a test server. */
export function originFiles(base: string, fetchFn: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i)): RegistryFiles {
  const root = base.replace(/\/+$/, "");
  return async (key) => {
    const res = await fetchFn(`${root}/${key.split("/").map(encodeURIComponent).join("/")}`, { method: "GET" });
    if (res.status === 404 || res.status === 403) return {};
    if (!res.ok) throw new Error(`origin answered ${res.status}`);
    return { body: new Uint8Array(await res.arrayBuffer()) };
  };
}

/** Accepted tokens from a secret's text: one per line or comma separated, blanks dropped. */
export const tokensFromSecret = (text: string | undefined): string[] => (text ?? "").split(/[\n,]/).map((t) => t.trim()).filter((t) => !!t);
