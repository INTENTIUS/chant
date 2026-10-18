/**
 * Test stand-ins for the publish targets (#4047): an OCI registry fake that
 * listens on 127.0.0.1 inside the test process and answers with a Bearer
 * challenge as GHCR and Docker Hub do, an OCI image layout writer, and a fake
 * `npm` that records each call. Nothing here reaches a network or a real
 * registry, and every server a test starts is closed by it.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

const sha = (b: Uint8Array | string) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

export interface FakeRegistry {
  /** `127.0.0.1:<port>`, for a repository reference. */
  host: string;
  blobs: Map<string, Buffer>;
  manifests: Map<string, { name: string; type: string; bytes: Buffer }>;
  /** Each request: method, path and the authorization header it carried. */
  requests: Array<{ method: string; path: string; authorization: string | null }>;
  uploads: number;
  close(): Promise<void>;
}

/** A registry fake with a Bearer token service that accepts `username` and `password`. */
export async function startFakeRegistry(creds: { username: string; password: string; token: string }): Promise<FakeRegistry> {
  const blobs = new Map<string, Buffer>();
  const manifests = new Map<string, { name: string; type: string; bytes: Buffer }>();
  const requests: FakeRegistry["requests"] = [];
  const state = { uploads: 0, port: 0 };
  const read = (req: IncomingMessage) =>
    new Promise<Buffer>((res) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => res(Buffer.concat(parts)));
    });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${state.port}`);
    const body = await read(req);
    requests.push({ method: req.method ?? "", path: url.pathname, authorization: req.headers.authorization ?? null });
    const send = (status: number, headers: Record<string, string> = {}, text = "") => {
      res.writeHead(status, headers);
      res.end(text);
    };
    if (url.pathname === "/token") {
      const basic = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;
      if (req.headers.authorization !== basic) return send(401, {}, "bad credentials");
      return send(200, { "content-type": "application/json" }, JSON.stringify({ token: creds.token }));
    }
    if (req.headers.authorization !== `Bearer ${creds.token}`) {
      return send(401, { "www-authenticate": `Bearer realm="http://127.0.0.1:${state.port}/token",service="fake-registry"` }, "unauthorized");
    }
    let m = url.pathname.match(/^\/v2\/(.+)\/blobs\/uploads\/(.*)$/);
    if (m) {
      if (req.method === "POST") return send(202, { location: `/v2/${m[1]}/blobs/uploads/u${requests.length}?_state=s` });
      const digest = url.searchParams.get("digest") ?? "";
      if (req.method === "PUT" && sha(body) === digest && url.searchParams.get("_state") === "s") {
        blobs.set(digest, body);
        state.uploads++;
        return send(201, { "docker-content-digest": digest });
      }
      return send(400, {}, "digest invalid");
    }
    m = url.pathname.match(/^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]+)$/);
    if (m && req.method === "HEAD") return send(blobs.has(m[2]!) ? 200 : 404);
    m = url.pathname.match(/^\/v2\/(.+)\/manifests\/(.+)$/);
    if (m && req.method === "PUT") {
      const ref = m[2]!;
      if (ref.startsWith("sha256:") && sha(body) !== ref) return send(400, {}, "manifest digest invalid");
      const parsed = JSON.parse(body.toString("utf-8")) as { config?: { digest: string }; layers?: Array<{ digest: string }> };
      for (const d of [parsed.config, ...(parsed.layers ?? [])]) if (d && !blobs.has(d.digest)) return send(400, {}, `blob unknown ${d.digest}`);
      manifests.set(ref, { name: m[1]!, type: String(req.headers["content-type"]), bytes: body });
      return send(201, { "docker-content-digest": sha(body) });
    }
    return send(404, {}, "not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  state.port = (server.address() as AddressInfo).port;
  return {
    host: `127.0.0.1:${state.port}`,
    blobs,
    manifests,
    requests,
    get uploads() {
      return state.uploads;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Write a one-image OCI layout at `dir`, returning the manifest's and the config's digests. */
export function writeOciLayout(dir: string, content = "layer bytes"): { digest: string; configDigest: string } {
  const blobsDir = join(dir, "blobs", "sha256");
  mkdirSync(blobsDir, { recursive: true });
  const put = (bytes: string) => {
    const d = sha(bytes);
    writeFileSync(join(blobsDir, d.slice(7)), bytes);
    return { digest: d, size: Buffer.byteLength(bytes) };
  };
  const layer = put(content);
  const config = put(JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [layer.digest] } }));
  const manifest = put(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config },
      layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", ...layer }],
    }),
  );
  writeFileSync(join(dir, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  writeFileSync(join(dir, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", ...manifest }] }));
  return { digest: manifest.digest, configDigest: config.digest };
}

/**
 * Write a fake `npm` at `<binDir>/npm` that appends `{ args, tokenSet }` to
 * `log` for each call, prints the token it was given (so a test can show it
 * is masked), and exits 1 when its package path contains `$FAKE_NPM_FAIL`.
 */
export function writeFakeNpm(binDir: string, log: string): string {
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, "npm");
  writeFileSync(
    file,
    `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
const token = process.env.NODE_AUTH_TOKEN || "";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, tokenSet: token !== "" }) + "\\n");
console.log("npm notice using //registry.example/:_authToken=" + token);
console.error("npm notice token " + token);
if (process.env.FAKE_NPM_FAIL && args[1] && args[1].includes(process.env.FAKE_NPM_FAIL)) { console.error("npm error 403 Forbidden"); process.exit(1); }
console.log("+ " + args[1]);
`,
  );
  chmodSync(file, 0o755);
  return file;
}

/** Write an npm package directory. */
export function writePackage(dir: string, name: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }, null, 2));
}
