// The module registry protocol moved from terragucci (chant#4565), with the download answer Terraform
// installs from (terragucci#1287): the JSON body stays, X-Terraform-Get carries the same location.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_HEADER,
  RegistryError,
  RegistryNameError,
  dirFiles,
  downloadAnswer,
  downloadDoc,
  fetchTarball,
  handlerFetch,
  isDownloadPath,
  keyFor,
  newest,
  parseRegistrySource,
  parseSemver,
  readVersions,
  registryAddress,
  registryHandler,
  registryLocation,
  registryVersions,
  serveRegistry,
  storeFiles,
  tarballName,
  versionsDoc,
  writeVersion,
  type RegistryFetch,
  type RegistryWriteStore,
} from "./index";

const REG = { url: "https://modules.test", namespace: "acme" };

function memoryStore(): RegistryWriteStore & { objects: Map<string, { body: string | Buffer; etag: string }>; puts: string[] } {
  const objects = new Map<string, { body: string | Buffer; etag: string }>();
  const puts: string[] = [];
  let n = 0;
  return {
    objects,
    puts,
    async put(key, body) {
      puts.push(key);
      objects.set(key, { body, etag: `"${++n}"` });
      return {};
    },
    async read(key) {
      const o = objects.get(key);
      return o ? { body: typeof o.body === "string" ? o.body : o.body.toString("utf-8"), etag: o.etag } : {};
    },
  };
}

/** Serves a store's files as a bucket would: no headers per object. */
const staticFetch = (objects: Map<string, { body: string | Buffer }>): RegistryFetch => async (url) => {
  const key = new URL(url).pathname.replace(/^\//, "");
  const o = objects.get(key);
  return o ? new Response(typeof o.body === "string" ? o.body : new Uint8Array(o.body), { status: 200 }) : new Response(null, { status: 404 });
};

async function publishOne(store: RegistryWriteStore, version = "0.1.0", prefix?: string) {
  const addr = registryAddress(REG, "modules/net");
  const v = parseSemver(version)!;
  const location = `${REG.url}/${addr.path}/${version}/${tarballName(addr, version)}`;
  await writeVersion(
    store,
    addr,
    v,
    {
      tarball: { key: keyFor(prefix, `${addr.path}/${version}/${tarballName(addr, version)}`), body: gzipSync(Buffer.from("module bytes")) },
      download: { key: keyFor(prefix, `${addr.path}/${version}/download`), body: downloadDoc(location) },
      meta: { key: keyFor(prefix, `${addr.path}/${version}/release.json`), body: JSON.stringify({ module: "modules/net", version, revision: "abc", content: "sha256:x", location }) },
    },
    { prefix },
  );
  return { addr, location };
}

describe("addresses", () => {
  it("places a module by its path, the longest namespace prefix winning", () => {
    const reg = { ...REG, namespaces: { "platform/": "plat", "platform/net": "netw" } };
    expect(registryAddress(reg, "modules/net")).toEqual({ namespace: "acme", name: "net", system: "generic", source: "modules.test/acme/net/generic", path: "v1/modules/acme/net/generic" });
    expect(registryAddress(reg, "platform/db").namespace).toBe("plat");
    expect(registryAddress(reg, "platform/net").namespace).toBe("netw");
    expect(() => registryAddress(REG, "modules/net.v2")).toThrow(RegistryNameError);
  });

  it("parses registry sources and leaves other sources alone", () => {
    expect(parseRegistrySource("127.0.0.1:8443/acme/network/generic")).toEqual({ host: "127.0.0.1:8443", namespace: "acme", name: "network", system: "generic" });
    expect(parseRegistrySource("Modules.Test/acme/net/aws//sub?ref=x")?.host).toBe("modules.test");
    expect(parseRegistrySource("hashicorp/consul/aws")).toBeUndefined();
    expect(parseRegistrySource("git::https://example.com/x.git")).toBeUndefined();
  });

  it("keys files under a prefix", () => {
    expect(keyFor("/registry/", "v1/x")).toBe("registry/v1/x");
    expect(keyFor(undefined, "v1/x")).toBe("v1/x");
  });
});

describe("writer", () => {
  it("writes discovery, the tarball, download, release.json, then the version list", async () => {
    const mem = memoryStore();
    await publishOne(mem);
    expect(mem.puts).toEqual([
      ".well-known/terraform.json",
      "v1/modules/acme/net/generic/0.1.0/net-0.1.0.tar.gz",
      "v1/modules/acme/net/generic/0.1.0/download",
      "v1/modules/acme/net/generic/0.1.0/release.json",
      "v1/modules/acme/net/generic/versions",
    ]);
    await publishOne(mem, "0.2.0");
    expect(readVersions((await mem.read("v1/modules/acme/net/generic/versions")).body)).toEqual(["0.1.0", "0.2.0"]);
    expect(mem.puts.filter((k) => k === ".well-known/terraform.json")).toHaveLength(1);
  });

  it("retries the version list on a conflict from a store with its own conflict class", async () => {
    class StoreConflict extends Error {}
    const mem = memoryStore();
    let fail = 1;
    const store: RegistryWriteStore = {
      read: mem.read,
      async put(key, body, type, when) {
        if (key.endsWith("/versions") && fail-- > 0) throw new StoreConflict("412");
        return mem.put(key, body, type, when);
      },
    };
    await publishOne(store);
    expect(readVersions((await mem.read("v1/modules/acme/net/generic/versions")).body)).toEqual(["0.1.0"]);
  });

  it("sorts and dedupes versions, and picks the newest", () => {
    expect(readVersions(versionsDoc(["1.0.0", "0.2.0", "v1.0.0", "nope"]))).toEqual(["0.2.0", "1.0.0"]);
    expect(readVersions("not json")).toEqual([]);
    expect(newest(["0.9.0", "0.10.0", "x"])).toEqual({ major: 0, minor: 10, patch: 0 });
  });

  it("answers a download with the JSON body and X-Terraform-Get, status 200", () => {
    const a = downloadAnswer("https://modules.test/x.tar.gz");
    expect(a.status).toBe(200);
    expect(a.headers[DOWNLOAD_HEADER]).toBe("https://modules.test/x.tar.gz");
    expect(JSON.parse(a.body)).toEqual({ location: "https://modules.test/x.tar.gz" });
    expect(isDownloadPath("v1/modules/acme/net/generic/0.1.0/download")).toBe(true);
    expect(isDownloadPath("registry/v1/modules/acme/net/generic/0.1.0/download")).toBe(true);
    expect(isDownloadPath("v1/modules/acme/net/generic/versions")).toBe(false);
  });
});

describe("reader", () => {
  it("reads static files the way OpenTofu does, and refuses them the way Terraform does", async () => {
    const mem = memoryStore();
    const { location } = await publishOne(mem);
    const fetch = staticFetch(mem.objects);
    expect(await registryVersions("modules.test/acme/net/generic", fetch)).toEqual(["0.1.0"]);
    expect(await registryLocation("modules.test/acme/net/generic", "0.1.0", { fetch, reads: "tofu" })).toBe(location);
    await expect(registryLocation("modules.test/acme/net/generic", "0.1.0", { fetch, reads: "terraform" })).rejects.toThrow("sends no X-Terraform-Get header");
    await expect(registryLocation("modules.test/acme/net/generic", "9.0.0", fetch)).rejects.toThrow("has no version 9.0.0");
    await expect(registryVersions("hashicorp/consul/aws", fetch)).rejects.toThrow(RegistryError);
  });

  it("reads the handler's answers under both CLIs, and fetches the tarball", async () => {
    const mem = memoryStore();
    const { location } = await publishOne(mem);
    const log: string[] = [];
    const fetch = handlerFetch(registryHandler(storeFiles({ read: async (k) => ({ body: mem.objects.get(k)?.body }) }), { log: (l) => log.push(l) }));
    expect(await registryLocation("modules.test/acme/net/generic", "0.1.0", { fetch, reads: "terraform" })).toBe(location);
    expect(await registryLocation("modules.test/acme/net/generic", "0.1.0", { fetch, reads: "tofu" })).toBe(location);
    expect((await fetchTarball(location, fetch)).toString()).toBe("module bytes");
    expect(log).toContain("GET /v1/modules/acme/net/generic/0.1.0/download -> 200");
  });

  it("reads a registry written under a prefix through the handler's prefix", async () => {
    const mem = memoryStore();
    await publishOne(mem, "0.1.0", "registry");
    const fetch = handlerFetch(registryHandler(storeFiles({ read: async (k) => ({ body: mem.objects.get(k)?.body }) }), { prefix: "registry" }));
    expect(await registryVersions("modules.test/acme/net/generic", fetch)).toEqual(["0.1.0"]);
  });
});

describe("loopback server", () => {
  it("serves a directory on 127.0.0.1 with the download header", async () => {
    const root = mkdtempSync(join(tmpdir(), "chant-registry-"));
    const mem = memoryStore();
    await publishOne(mem);
    for (const [key, o] of mem.objects) {
      mkdirSync(dirname(join(root, key)), { recursive: true });
      writeFileSync(join(root, key), o.body);
    }
    const served = await serveRegistry(registryHandler(dirFiles(root)));
    try {
      const res = await fetch(`${served.url}/v1/modules/acme/net/generic/0.1.0/download`);
      expect(res.status).toBe(200);
      expect(res.headers.get(DOWNLOAD_HEADER)).toBe("https://modules.test/v1/modules/acme/net/generic/0.1.0/net-0.1.0.tar.gz");
      expect(await res.json()).toEqual({ location: "https://modules.test/v1/modules/acme/net/generic/0.1.0/net-0.1.0.tar.gz" });
      expect((await fetch(`${served.url}/../etc/passwd`)).status).toBe(404);
      expect(await registryVersions(`${served.host}/acme/net/generic`, { scheme: "http" })).toEqual(["0.1.0"]);
    } finally {
      await served.close();
    }
  });
});

describe("credentials (chant#4563)", () => {
  /** A registry that refuses any request without the bearer token, as a private registry or the edge function with auth on does. */
  const guarded = (mem: ReturnType<typeof memoryStore>, token: string, seen: (string | null)[]): RegistryFetch => {
    const inner = handlerFetch(registryHandler(storeFiles({ read: async (k) => ({ body: mem.objects.get(k)?.body }) })));
    return async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      seen.push(auth);
      return auth === `Bearer ${token}` ? inner(url, init) : new Response(null, { status: 401 });
    };
  };

  it("sends TF_TOKEN_<host> on discovery, versions and download", async () => {
    const mem = memoryStore();
    const { location } = await publishOne(mem);
    const seen: (string | null)[] = [];
    const fetch = guarded(mem, "s3cret", seen);
    const credentials = { env: { TF_TOKEN_modules_test: "s3cret" }, readFile: () => undefined };
    expect(await registryVersions("modules.test/acme/net/generic", { fetch, credentials })).toEqual(["0.1.0"]);
    expect(await registryLocation("modules.test/acme/net/generic", "0.1.0", { fetch, credentials, reads: "terraform" })).toBe(location);
    expect(seen).toHaveLength(4);
    expect(seen.every((a) => a === "Bearer s3cret")).toBe(true);
  });

  it("reads the token from credentials.tfrc.json when no variable is set", async () => {
    const mem = memoryStore();
    await publishOne(mem);
    const tfrc = join("/home/u", ".terraform.d", "credentials.tfrc.json");
    const credentials = { env: { HOME: "/home/u" }, platform: "linux", readFile: (p: string) => (p === tfrc ? JSON.stringify({ credentials: { "modules.test": { token: "f1" } } }) : undefined) };
    expect(await registryVersions("modules.test/acme/net/generic", { fetch: guarded(mem, "f1", []), credentials })).toEqual(["0.1.0"]);
  });

  it("names the variable to set when the registry wants a token, and never prints one", async () => {
    const mem = memoryStore();
    await publishOne(mem);
    const none = { env: {}, readFile: () => undefined };
    await expect(registryVersions("modules.test/acme/net/generic", { fetch: guarded(mem, "s3cret", []), credentials: none })).rejects.toThrow("set TF_TOKEN_modules_test");
    const wrong = registryVersions("modules.test/acme/net/generic", { fetch: guarded(mem, "s3cret", []), token: "nope" });
    await expect(wrong).rejects.toThrow("refused the token");
    await expect(wrong).rejects.not.toThrow("nope");
  });

  it("sends no token when told not to, and none with a signed tarball URL", async () => {
    const mem = memoryStore();
    await publishOne(mem);
    const seen: (string | null)[] = [];
    await expect(registryVersions("modules.test/acme/net/generic", { fetch: guarded(mem, "s3cret", seen), token: false })).rejects.toThrow(RegistryError);
    expect(seen).toEqual([null]);
    const tarballSeen: (string | null)[] = [];
    const probe: RegistryFetch = async (_url, init) => {
      tarballSeen.push(new Headers(init?.headers).get("authorization"));
      return new Response(new Uint8Array(gzipSync(Buffer.from("x"))), { status: 200 });
    };
    await fetchTarball("https://modules.test/x.tar.gz?expires=1&sig=abc", { fetch: probe, token: "s3cret" });
    await fetchTarball("https://modules.test/x.tar.gz", { fetch: probe, token: "s3cret" });
    expect(tarballSeen).toEqual([null, "Bearer s3cret"]);
  });
});
