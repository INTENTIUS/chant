import { describe, test, expect } from "bun:test";
import { DiscoveryCache } from "./cache";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("DiscoveryCache", () => {
  test("hasFileChanged returns true for unknown files", () => {
    const cache = new DiscoveryCache();
    expect(cache.hasFileChanged("/nonexistent/file.ts")).toBe(true);
  });

  test("trackFileImport and hasFileChanged detect changes", async () => {
    const cache = new DiscoveryCache();
    const dir = join(tmpdir(), `chant-cache-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    const file = join(dir, "test.ts");
    writeFileSync(file, "export const a = 1;");

    const { statSync: stat } = require("fs");
    const { mtimeMs } = stat(file);
    cache.trackFileImport(file, mtimeMs, ["a"]);

    // File hasn't changed
    expect(cache.hasFileChanged(file)).toBe(false);

    // Wait briefly to ensure mtime differs, then modify
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(file, "export const a = 2;");

    // File has changed
    expect(cache.hasFileChanged(file)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  test("invalidate removes entries and returns entity names", () => {
    const cache = new DiscoveryCache();
    cache.trackFileImport("/a.ts", 100, ["bucket", "role"]);
    cache.trackFileImport("/b.ts", 200, ["table"]);

    const invalidated = cache.invalidate(["/a.ts"]);
    expect(invalidated.has("bucket")).toBe(true);
    expect(invalidated.has("role")).toBe(true);
    expect(invalidated.has("table")).toBe(false);

    // a.ts is now unknown
    expect(cache.hasFileChanged("/a.ts")).toBe(true);
  });

  test("invalidate with unknown file returns empty set", () => {
    const cache = new DiscoveryCache();
    const invalidated = cache.invalidate(["/unknown.ts"]);
    expect(invalidated.size).toBe(0);
  });

  test("trackedFiles returns all tracked file paths", () => {
    const cache = new DiscoveryCache();
    cache.trackFileImport("/a.ts", 100, ["x"]);
    cache.trackFileImport("/b.ts", 200, ["y"]);
    expect(cache.trackedFiles().sort()).toEqual(["/a.ts", "/b.ts"]);
  });

  test("getFileEntities returns entity names for tracked file", () => {
    const cache = new DiscoveryCache();
    cache.trackFileImport("/a.ts", 100, ["bucket", "role"]);
    expect(cache.getFileEntities("/a.ts")).toEqual(["bucket", "role"]);
    expect(cache.getFileEntities("/unknown.ts")).toBeUndefined();
  });

  test("clear removes all entries", () => {
    const cache = new DiscoveryCache();
    cache.trackFileImport("/a.ts", 100, ["x"]);
    cache.clear();
    expect(cache.trackedFiles()).toEqual([]);
  });
});
