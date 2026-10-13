import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MANIFEST_FILE, loadManifest, vendorPull } from "../cli/commands/vendor";
import { LOCK_FILE, readLock, resolveManualStep, writeLock } from "./lineage-lock";
import { checkLockedScopes, migrateVendorManifest, pullLockedScopes } from "./lineage-vendor";

let root: string;

function put(rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}
const read = (rel: string) => readFileSync(join(root, rel), "utf-8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chant-lineage-vendor-"));
  put("shared/web/index.ts", "export const v = 1;\n");
  put("shared/web/README.md", "# web\n");
  put(
    MANIFEST_FILE,
    JSON.stringify({
      vendored: [
        { name: "web", source: { type: "local", path: "shared/web" }, target: "vendor/web", ref: "v1" },
        { name: "later", source: { type: "local", path: "shared/web" }, target: "vendor/later" },
      ],
    }),
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("chant vendor migrate", () => {
  test("moves every entry into the lock as a vendor scope and removes vendor.json", async () => {
    await vendorPull(root, "web");
    const checksum = loadManifest(root).manifest.vendored[0].checksum;
    const result = await migrateVendorManifest(root);
    expect(result).toEqual({
      migrated: [
        { name: "web", target: "vendor/web", files: 2, pinned: true },
        { name: "later", target: "vendor/later", files: 0, pinned: false },
      ],
      lockCreated: true,
    });
    expect(existsSync(join(root, MANIFEST_FILE))).toBe(false);
    const lock = readLock(root)!;
    expect(lock.scopes["vendor/web"]).toMatchObject({
      kind: "vendor",
      name: "web",
      template: "local:shared/web",
      source: { type: "local", path: "shared/web" },
      ref: "v1",
      address: { digest: checksum },
      parameters: {},
      migrations: [],
    });
    expect(Object.keys(lock.scopes["vendor/web"].files)).toEqual(["README.md", "index.ts"]);
    expect(lock.scopes["vendor/later"].address).toBeNull();
  });

  test("an edited target takes its merge bases from the source when the source still matches", async () => {
    await vendorPull(root, "web");
    put("vendor/web/index.ts", "mine\n");
    await migrateVendorManifest(root);
    expect(checkLockedScopes(root).find((c) => c.name === "web")).toMatchObject({ status: "customised", customised: ["index.ts"] });
  });

  test("refuses, writing nothing, when the pinned content cannot be recovered", async () => {
    await vendorPull(root, "web");
    put("vendor/web/index.ts", "mine\n");
    put("shared/web/index.ts", "moved on\n");
    await expect(migrateVendorManifest(root)).rejects.toThrow(/cannot be recovered/);
    expect(existsSync(join(root, MANIFEST_FILE))).toBe(true);
    expect(existsSync(join(root, LOCK_FILE))).toBe(false);
  });

  test("keeps scopes already in the lock and refuses a clash", async () => {
    await migrateVendorManifest(root);
    put(MANIFEST_FILE, JSON.stringify({ vendored: [{ name: "web", source: { type: "local", path: "shared/web" }, target: "vendor/other" }] }));
    await expect(migrateVendorManifest(root)).rejects.toThrow(/already has a vendor scope with that name/);
    put(MANIFEST_FILE, JSON.stringify({ vendored: [{ name: "x", source: { type: "local", path: "shared/web" }, target: "vendor/web/" }] }));
    await expect(migrateVendorManifest(root)).rejects.toThrow(/already has a scope at vendor\/web/);
  });
});

describe("chant vendor pull through the lock", () => {
  test("keeps local edits, applies clean updates and records conflicts as manual steps", async () => {
    await vendorPull(root);
    await migrateVendorManifest(root);
    put("vendor/web/index.ts", "mine\n");
    put("vendor/web/local-only.ts", "mine\n");
    put("shared/web/index.ts", "export const v = 2;\n");
    put("shared/web/README.md", "# web v2\n");

    const [web] = await pullLockedScopes(root, "web");
    expect(web).toMatchObject({ name: "web", target: "vendor/web", written: 1, kept: 1 });
    expect(web.manualSteps.map((s) => [s.path, s.reason])).toEqual([["index.ts", "changed-locally"]]);
    expect(read("vendor/web/index.ts")).toBe("mine\n");
    expect(read("vendor/web/README.md")).toBe("# web v2\n");
    expect(read("vendor/web/local-only.ts")).toBe("mine\n");

    expect(checkLockedScopes(root).find((c) => c.name === "web")?.status).toBe("manual");

    const lock = readLock(root)!;
    resolveManualStep(lock, "vendor/web/index.ts");
    writeLock(root, lock);
    expect(checkLockedScopes(root).find((c) => c.name === "web")).toMatchObject({ status: "customised", customised: ["index.ts"] });
  });

  test("an unpinned scope is populated by its first pull", async () => {
    await migrateVendorManifest(root);
    expect(checkLockedScopes(root).find((c) => c.name === "later")?.status).toBe("unpinned");
    await pullLockedScopes(root, "later");
    expect(read("vendor/later/index.ts")).toBe("export const v = 1;\n");
    expect(checkLockedScopes(root).find((c) => c.name === "later")?.status).toBe("ok");
  });

  test("a deleted target is missing", async () => {
    await vendorPull(root, "web");
    await migrateVendorManifest(root);
    rmSync(join(root, "vendor/web"), { recursive: true });
    expect(checkLockedScopes(root).find((c) => c.name === "web")?.status).toBe("missing");
  });
});
