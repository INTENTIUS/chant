/**
 * A read-only Docker Engine API client for live export (#4388), and the tar
 * reader for `GET /containers/{id}/archive`.
 *
 * The client is a single function, `(path) => { status, body }`, so tests hand
 * export a fake Engine and never need a daemon. The default one speaks HTTP
 * over the socket `DOCKER_HOST` names (`unix://…`, or plain `tcp://host:port`),
 * else `/var/run/docker.sock`, with the unversioned API paths the daemon
 * serves at its own version.
 */

import { request } from "node:http";

/** One GET against the Engine API. `path` starts with `/`. */
export type DockerEngine = (path: string, signal?: AbortSignal) => Promise<{ status: number; body: Buffer }>;

const DEFAULT_SOCKET = "/var/run/docker.sock";

/** Where `DOCKER_HOST` points: a unix socket path, or a host and port. */
export function engineAddress(dockerHost = process.env.DOCKER_HOST): { socketPath: string } | { host: string; port: number } {
  if (!dockerHost) return { socketPath: DEFAULT_SOCKET };
  if (dockerHost.startsWith("unix://")) return { socketPath: dockerHost.slice("unix://".length) };
  if (dockerHost.startsWith("tcp://")) {
    if (process.env.DOCKER_TLS_VERIFY) {
      throw new Error("docker live export: DOCKER_TLS_VERIFY is set, and a TLS Engine endpoint is not supported; use a unix socket or a plain tcp:// endpoint");
    }
    const url = new URL(`http://${dockerHost.slice("tcp://".length)}`);
    return { host: url.hostname, port: Number(url.port || 2375) };
  }
  throw new Error(`docker live export: DOCKER_HOST ${dockerHost} is not a unix:// or tcp:// endpoint`);
}

/** The Engine at `DOCKER_HOST` (or the default socket). */
export function defaultDockerEngine(dockerHost?: string): DockerEngine {
  const address = engineAddress(dockerHost);
  return (path, signal) =>
    new Promise((resolve, reject) => {
      const req = request({ ...address, path, method: "GET", headers: { Host: "docker" }, signal }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
}

/** One entry of a tar stream. `type` is the ustar typeflag (`0` file, `5` directory, …). */
export interface TarEntry {
  name: string;
  type: string;
  data: Buffer;
}

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

/** The entries of an uncompressed tar stream. PAX and GNU long-name records are applied to the entry after them. */
export function readTar(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = field(header, 156, 1) || "0";
    const prefix = field(header, 345, 155);
    let name = prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "x") {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (path) longName = path[1];
      continue;
    }
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (type === "g") continue;
    if (longName !== undefined) {
      name = longName;
      longName = undefined;
    }
    out.push({ name, type: type === "\0" ? "0" : type, data: Buffer.from(data) });
  }
  return out;
}

/**
 * The text of the one regular file an archive holds, or undefined when it
 * holds anything else (a directory, a link, several entries) or the bytes
 * are not UTF-8 text.
 */
export function singleFileText(tar: Buffer): string | undefined {
  const entries = readTar(tar);
  if (entries.length !== 1 || entries[0]!.type !== "0") return undefined;
  const bytes = entries[0]!.data;
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
}
