/**
 * A registry's files on a loopback socket, for tests that run real
 * `terraform init` and `tofu init` (terragucci#1287) and for a local preview.
 * The answers come from `registryHandler` in ./handler; this file adds the
 * directory reader and the Node server around it.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join, normalize, sep } from "node:path";
import type { RegistryFiles, RegistryHandler } from "./handler";

/** A registry written into a directory, read back as bytes. Keys that climb out of the directory read as missing. */
export function dirFiles(root: string): RegistryFiles {
  const base = normalize(root);
  return async (key) => {
    const file = normalize(join(base, key));
    if (file !== base && !file.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)) return {};
    if (!existsSync(file) || !statSync(file).isFile()) return {};
    return { body: readFileSync(file) };
  };
}

export interface ServeOptions {
  /** Default 127.0.0.1. A loopback address keeps the registry off the network. */
  hostname?: string;
  /** Default 0, a free port. */
  port?: number;
  /** PEM key and certificate: the server speaks HTTPS, as both CLIs require for discovery. */
  tls?: { key: string | Buffer; cert: string | Buffer };
}

export interface ServedRegistry {
  /** `<scheme>://<hostname>:<port>`, no trailing slash. */
  url: string;
  /** `<hostname>:<port>`, the host a registry source names. */
  host: string;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

/** Serves a handler on a local socket until `close`. */
export async function serveRegistry(handler: RegistryHandler, options: ServeOptions = {}): Promise<ServedRegistry> {
  const hostname = options.hostname ?? "127.0.0.1";
  const scheme = options.tls ? "https" : "http";
  const listener = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const method = req.method ?? "GET";
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const answer = await handler(new Request(`${scheme}://${req.headers.host ?? hostname}${req.url ?? "/"}`, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}) }));
      const out: Record<string, string> = {};
      answer.headers.forEach((v, k) => (out[k] = v));
      res.writeHead(answer.status, out);
      res.end(answer.body ? Buffer.from(await answer.arrayBuffer()) : undefined);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String((e as Error).message));
    }
  };
  const server: Server = options.tls ? createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, (q, r) => void listener(q, r)) : createHttpServer((q, r) => void listener(q, r));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, hostname, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const host = `${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
  return {
    url: `${scheme}://${host}`,
    host,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
