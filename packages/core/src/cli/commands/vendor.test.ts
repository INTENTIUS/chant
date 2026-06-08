import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  vendorPull,
  vendorCheck,
  contentHash,
  scopeArchiveFiles,
  loadManifest,
  MANIFEST_FILE,
} from "./vendor";

let root: string;

function write(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chant-vendor-"));
  // A local "shared pattern" source.
  write("shared/web-app/index.ts", "export const WebApp = () => ({});\n");
  write("shared/web-app/README.md", "# pattern\n");
  // A project that vendors it.
  writeFileSync(
    join(root, MANIFEST_FILE),
    JSON.stringify({
      vendored: [
        { name: "web-app", source: { type: "local", path: "shared/web-app" }, target: "vendor/web-app", ref: "v1" },
      ],
    }, null, 2),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("vendor pull", () => {
  test("copies the source into target and records a checksum", async () => {
    const result = await vendorPull(root);
    expect(result.success).toBe(true);
    expect(result.pulled[0].fileCount).toBe(2);

    expect(existsSync(join(root, "vendor/web-app/index.ts"))).toBe(true);
    expect(readFileSync(join(root, "vendor/web-app/README.md"), "utf-8")).toContain("# pattern");

    // Checksum written back into the manifest.
    const { manifest } = loadManifest(root);
    expect(manifest.vendored[0].checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("pull <name> filters to one entry; unknown name fails", async () => {
    expect((await vendorPull(root, "web-app")).pulled).toHaveLength(1);
    const miss = await vendorPull(root, "nope");
    expect(miss.success).toBe(false);
    expect(miss.output).toContain("nope");
  });

  test("fails clearly when the local source is missing", async () => {
    writeFileSync(
      join(root, MANIFEST_FILE),
      JSON.stringify({ vendored: [{ name: "x", source: { type: "local", path: "missing" }, target: "vendor/x" }] }),
    );
    await expect(vendorPull(root)).rejects.toThrow(/local source not found/);
  });
});

describe("vendor check", () => {
  test("reports ok right after a pull", async () => {
    await vendorPull(root);
    const result = vendorCheck(root);
    expect(result.drift).toBe(false);
    expect(result.entries[0].status).toBe("ok");
  });

  test("detects drift when a vendored file is edited", async () => {
    await vendorPull(root);
    writeFileSync(join(root, "vendor/web-app/index.ts"), "// locally edited\n");
    const result = vendorCheck(root);
    expect(result.drift).toBe(true);
    expect(result.entries[0].status).toBe("drifted");
  });

  test("flags a target deleted after pinning as missing", async () => {
    await vendorPull(root);
    rmSync(join(root, "vendor/web-app"), { recursive: true });
    const result = vendorCheck(root);
    expect(result.entries[0].status).toBe("missing");
    expect(result.drift).toBe(true);
  });

  test("an entry with no checksum is unpinned, not drift", async () => {
    // Manifest never pulled → no checksum recorded.
    const result = vendorCheck(root);
    expect(result.entries[0].status).toBe("unpinned");
    expect(result.drift).toBe(false);
  });
});

describe("manifest validation", () => {
  test("rejects an invalid manifest", () => {
    writeFileSync(join(root, MANIFEST_FILE), JSON.stringify({ vendored: [{ name: "x" }] }));
    expect(() => loadManifest(root)).toThrow(/invalid vendor.json/);
  });

  test("rejects a floating updatePolicy (pins only)", () => {
    writeFileSync(
      join(root, MANIFEST_FILE),
      JSON.stringify({ vendored: [{ name: "x", source: { type: "local", path: "shared/web-app" }, target: "v/x", updatePolicy: "latest" }] }),
    );
    expect(() => loadManifest(root)).toThrow(/invalid vendor.json/);
  });
});

describe("contentHash", () => {
  test("is order-independent and content-sensitive", () => {
    const a = new Map([["a", Buffer.from("1")], ["b", Buffer.from("2")]]);
    const b = new Map([["b", Buffer.from("2")], ["a", Buffer.from("1")]]);
    expect(contentHash(a)).toBe(contentHash(b)); // order doesn't matter
    const c = new Map([["a", Buffer.from("1")], ["b", Buffer.from("CHANGED")]]);
    expect(contentHash(a)).not.toBe(contentHash(c));
  });
});

describe("scopeArchiveFiles", () => {
  test("strips the top-level wrapper dir and scopes to a subpath", () => {
    const raw = new Map([
      ["repo-main/composites/web-app/index.ts", Buffer.from("a")],
      ["repo-main/composites/web-app/util.ts", Buffer.from("b")],
      ["repo-main/ops/deploy.op.ts", Buffer.from("c")],
      ["repo-main/README.md", Buffer.from("d")],
    ]);
    const scoped = scopeArchiveFiles(raw, "composites/web-app");
    expect([...scoped.keys()].sort()).toEqual(["index.ts", "util.ts"]);
  });

  test("no subpath keeps everything below the wrapper dir", () => {
    const raw = new Map([
      ["repo-main/a.ts", Buffer.from("a")],
      ["repo-main/sub/b.ts", Buffer.from("b")],
    ]);
    expect([...scopeArchiveFiles(raw).keys()].sort()).toEqual(["a.ts", "sub/b.ts"]);
  });
});
