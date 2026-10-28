// The provider network mirror served from the module registry's bucket (chant#4564). `providers mirror`
// is replaced by a fake that writes the layout the binaries write, so nothing here downloads a provider.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { registryEdge, signLocation } from "./edge";
import { handlerFetch, registryHandler, storeFiles } from "./handler";
import {
  LOCK_FILE,
  buildMirror,
  isMirrorVersionPath,
  lockFiles,
  mirrorCliConfig,
  mirrorGroups,
  mirrorHas,
  mirrorKey,
  mirrorModules,
  mirrorUrl,
  otherHostAddress,
  uploadMirror,
  type MirrorRun,
  type MirrorUploadStore,
} from "./mirror";

const lock = (providers: Record<string, string>): string =>
  Object.entries(providers)
    .map(([a, v]) => `provider "${a}" {\n  version     = "${v}"\n  constraints = "~> ${v}"\n  hashes = [\n    "h1:x=",\n  ]\n}\n`)
    .join("\n");

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "chant-mirror-repo-"));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put(`live/a/${LOCK_FILE}`, lock({ "registry.opentofu.org/hashicorp/aws": "5.0.0" }));
  put(`live/b/${LOCK_FILE}`, lock({ "registry.opentofu.org/hashicorp/aws": "5.0.0" }));
  put(`live/c/${LOCK_FILE}`, lock({ "registry.terraform.io/hashicorp/aws": "5.1.0", "example.com/acme/thing": "1.0.0" }));
  put(`live/c/.terraform/providers/${LOCK_FILE}`, lock({ "registry.terraform.io/x/y": "9.9.9" }));
  put(`live/d/${LOCK_FILE}`, "# nothing locked\n");
  return root;
}

/** Writes what `providers mirror` writes for each required provider, one zip per platform. */
const fakeMirror = (calls: string[][]): MirrorRun => (_bin, args) => {
  calls.push(args);
  const chdir = args.find((a) => a.startsWith("-chdir="))!.slice("-chdir=".length);
  const out = args[args.length - 1]!;
  const platforms = args.filter((a) => a.startsWith("-platform=")).map((a) => a.slice("-platform=".length));
  const text = readFileSync(join(chdir, "versions.tf"), "utf-8");
  for (const m of text.matchAll(/source = "([^"]+)", version = "= ([^"]+)"/g)) {
    const [address, version] = [m[1]!, m[2]!];
    const type = address.split("/").pop()!;
    const dir = join(out, ...address.split("/"));
    mkdirSync(dir, { recursive: true });
    const archives: Record<string, { url: string; hashes: string[] }> = {};
    for (const p of platforms) {
      const zip = `terraform-provider-${type}_${version}_${p}.zip`;
      writeFileSync(join(dir, zip), `zip ${address} ${version} ${p}`);
      archives[p] = { url: zip, hashes: ["h1:x="] };
    }
    writeFileSync(join(dir, `${version}.json`), JSON.stringify({ archives }));
    // What the binary writes for this run only; buildMirror rewrites it from every version file.
    writeFileSync(join(dir, "index.json"), JSON.stringify({ versions: { [version]: {} } }));
  }
  return { status: 0, output: "" };
};

function memoryStore(): MirrorUploadStore & { objects: Map<string, string | Buffer>; puts: string[] } {
  const objects = new Map<string, string | Buffer>();
  const puts: string[] = [];
  return {
    objects,
    puts,
    async put(key, body) {
      puts.push(key);
      objects.set(key, body);
      return {};
    },
    async read(key) {
      const b = objects.get(key);
      return b === undefined ? {} : { body: b.toString() };
    },
    async has(key) {
      return objects.has(key);
    },
  };
}

describe("lock files and groups (shared with the image recipe)", () => {
  it("finds lock files outside caches and groups the ones that pin the same providers", () => {
    const root = repo();
    expect(lockFiles(root)).toEqual([`live/a/${LOCK_FILE}`, `live/b/${LOCK_FILE}`, `live/c/${LOCK_FILE}`, `live/d/${LOCK_FILE}`]);
    const groups = mirrorGroups(root);
    expect(groups.map((g) => g.locks)).toEqual([[`live/a/${LOCK_FILE}`, `live/b/${LOCK_FILE}`], [`live/c/${LOCK_FILE}`]]);
  });

  it("writes a module per group at exactly the locked versions, with the other default host when asked", () => {
    const groups = mirrorGroups(repo());
    const plain = mirrorModules(groups);
    expect(plain.map((f) => f.path)).toEqual(["mirror/01/versions.tf", `mirror/01/${LOCK_FILE}`, "mirror/02/versions.tf", `mirror/02/${LOCK_FILE}`]);
    expect(plain[0]!.content).toContain('source = "registry.opentofu.org/hashicorp/aws", version = "= 5.0.0"');
    expect(plain[0]!.content).not.toContain("registry.terraform.io");
    const both = mirrorModules(groups, { bothHosts: true });
    expect(both[0]!.content).toContain('source = "registry.terraform.io/hashicorp/aws", version = "= 5.0.0"');
    expect(both[2]!.content).toContain('source = "registry.opentofu.org/hashicorp/aws", version = "= 5.1.0"');
    expect(both[2]!.content).not.toContain("registry.opentofu.org/acme/thing");
    expect(otherHostAddress("example.com/acme/thing")).toBeUndefined();
  });
});

describe("buildMirror", () => {
  it("runs providers mirror per group for each platform and lists every version in index.json", () => {
    const root = repo();
    const out = mkdtempSync(join(tmpdir(), "chant-mirror-out-"));
    const calls: string[][] = [];
    const built = buildMirror(root, out, { binary: "tofu", platforms: ["linux/amd64", "darwin_arm64"], run: fakeMirror(calls) });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.slice(1, 5)).toEqual(["providers", "mirror", "-platform=linux_amd64", "-platform=darwin_arm64"]);
    expect(built.providers).toContain("registry.terraform.io/hashicorp/aws 5.0.0");
    expect(built.providers).toContain("registry.opentofu.org/hashicorp/aws 5.1.0");
    expect(mirrorHas(out, "registry.opentofu.org/hashicorp/aws", "5.0.0", "linux_amd64")).toBe(true);
    // Both groups mirrored a version of registry.terraform.io/hashicorp/aws; the index lists both.
    const index = JSON.parse(readFileSync(join(out, "registry.terraform.io/hashicorp/aws/index.json"), "utf-8"));
    expect(Object.keys(index.versions)).toEqual(["5.0.0", "5.1.0"]);
  });

  it("says which group failed", () => {
    const fail: MirrorRun = () => ({ status: 1, output: "Error: no such provider" });
    expect(() => buildMirror(repo(), mkdtempSync(join(tmpdir(), "chant-mirror-out-")), { run: fail })).toThrow("providers mirror for mirror/01 failed (exit 1)");
    expect(() => buildMirror(repo(), mkdtempSync(join(tmpdir(), "chant-mirror-out-")), { platforms: ["linux"], run: fail })).toThrow("os_arch");
  });
});

describe("uploadMirror", () => {
  it("puts archives first and index.json last, under the registry's prefix, merging the bucket's index", async () => {
    const out = mkdtempSync(join(tmpdir(), "chant-mirror-out-"));
    buildMirror(repo(), out, { run: fakeMirror([]) });
    const store = memoryStore();
    const indexKey = mirrorKey("registry", "registry.opentofu.org/hashicorp/aws/index.json");
    store.objects.set(indexKey, JSON.stringify({ versions: { "4.9.0": {} } }));
    const first = await uploadMirror(store, out, { prefix: "registry" });
    const lastArchive = Math.max(...first.put.map((k, i) => (k.endsWith(".zip") ? i : -1)));
    const firstIndex = first.put.findIndex((k) => k.endsWith("/index.json"));
    expect(lastArchive).toBeLessThan(firstIndex);
    expect(first.put.every((k) => k.startsWith("registry/providers/"))).toBe(true);
    // The mirror covers both default hosts (#4564), so live/c's registry.terraform.io 5.1.0 is mirrored here too.
    expect(Object.keys(JSON.parse(store.objects.get(indexKey)!.toString()).versions)).toEqual(["4.9.0", "5.0.0", "5.1.0"]);
    const again = await uploadMirror(store, out, { prefix: "registry" });
    expect(again.kept.length).toBeGreaterThan(0);
    expect(again.put.some((k) => k.endsWith(".zip"))).toBe(false);
  });
});

describe("serving the mirror", () => {
  it("serves index.json, the version file and the archive through the registry handler", async () => {
    const out = mkdtempSync(join(tmpdir(), "chant-mirror-out-"));
    buildMirror(repo(), out, { platforms: ["linux_amd64"], run: fakeMirror([]) });
    const store = memoryStore();
    await uploadMirror(store, out);
    const fetch = handlerFetch(registryHandler(storeFiles({ read: async (k) => ({ body: store.objects.get(k) as string | Uint8Array | undefined }) })));
    const base = mirrorUrl("https://modules.test");
    expect(base).toBe("https://modules.test/providers/");
    const index = await (await fetch(`${base}registry.opentofu.org/hashicorp/aws/index.json`)).json();
    expect(index).toEqual({ versions: { "5.0.0": {}, "5.1.0": {} } });
    const version = (await (await fetch(`${base}registry.opentofu.org/hashicorp/aws/5.0.0.json`)).json()) as { archives: Record<string, { url: string }> };
    const zip = await fetch(new URL(version.archives.linux_amd64!.url, `${base}registry.opentofu.org/hashicorp/aws/5.0.0.json`).toString());
    expect(zip.status).toBe(200);
  });

  it("with the edge function's auth on, signs each archive URL in a version file", async () => {
    const out = mkdtempSync(join(tmpdir(), "chant-mirror-out-"));
    buildMirror(repo(), out, { platforms: ["linux_amd64"], run: fakeMirror([]) });
    const store = memoryStore();
    await uploadMirror(store, out);
    const now = 1_800_000_000_000;
    const fetch = handlerFetch(registryEdge({ files: async (k) => ({ body: store.objects.get(k) as string | Uint8Array | undefined }), auth: { tokens: ["s3cret"] }, now: () => now }));
    const versionUrl = "https://modules.test/providers/registry.opentofu.org/hashicorp/aws/5.0.0.json";
    expect(isMirrorVersionPath(new URL(versionUrl).pathname.slice(1))).toBe(true);
    expect((await fetch(versionUrl)).status).toBe(401);
    const doc = (await (await fetch(versionUrl, { headers: { authorization: "Bearer s3cret" } })).json()) as { archives: Record<string, { url: string }> };
    const signed = doc.archives.linux_amd64!.url;
    expect(signed).toContain("signature=");
    expect((await fetch(signed)).status).toBe(200);
    expect((await fetch(signed.split("?")[0]!)).status).toBe(401);
    expect(await signLocation(signed.split("?")[0]!, "s3cret", now)).toBe(signed);
  });
});

describe("mirrorCliConfig", () => {
  it("sends the mirrored providers to the mirror only and the rest direct", () => {
    const text = mirrorCliConfig("https://modules.test/providers", ["registry.terraform.io/hashicorp/aws 5.0.0", "registry.opentofu.org/hashicorp/aws"]);
    expect(text).toContain('url = "https://modules.test/providers/"');
    expect(text).not.toContain("5.0.0");
    expect(text).toMatch(/network_mirror \{[\s\S]*include = \[[\s\S]*"registry.opentofu.org\/hashicorp\/aws",[\s\S]*direct \{[\s\S]*exclude = \[/);
  });
});
