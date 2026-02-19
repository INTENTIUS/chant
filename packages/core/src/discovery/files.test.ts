import { describe, test, expect } from "bun:test";
import { findInfraFiles } from "./files";
import { withTestDir } from "@intentius/chant-test-utils";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("findInfraFiles", () => {
  test("returns empty array for empty directory", async () => {
    await withTestDir(async (testDir) => {
      const files = await findInfraFiles(testDir);
      expect(files).toEqual([]);
    });
  });

  test("finds .ts files in root directory", async () => {
    await withTestDir(async (testDir) => {
      await writeFile(join(testDir, "app.ts"), "export const app = {};");
      await writeFile(join(testDir, "config.ts"), "export const config = {};");

      const files = await findInfraFiles(testDir);
      expect(files).toHaveLength(2);
      expect(files.some((f) => f.endsWith("app.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("config.ts"))).toBe(true);
    });
  });

  test.each([
    { extension: ".test.ts", pattern: /app\.test\.ts$/ },
    { extension: ".spec.ts", pattern: /app\.spec\.ts$/ },
  ])("excludes $extension files", async ({ extension, pattern }) => {
    await withTestDir(async (testDir) => {
      await writeFile(join(testDir, "app.ts"), "export const app = {};");
      await writeFile(join(testDir, `app${extension}`), "test();");

      const files = await findInfraFiles(testDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/app\.ts$/);
      expect(files[0]).not.toMatch(pattern);
    });
  });

  test("finds .ts files recursively", async () => {
    await withTestDir(async (testDir) => {
      const subDir = join(testDir, "src", "lib");
      await mkdir(subDir, { recursive: true });
      await writeFile(join(testDir, "root.ts"), "export const root = {};");
      await writeFile(join(testDir, "src", "app.ts"), "export const app = {};");
      await writeFile(
        join(subDir, "utils.ts"),
        "export const utils = {};"
      );

      const files = await findInfraFiles(testDir);
      expect(files).toHaveLength(3);
      expect(files.some((f) => f.endsWith("root.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("app.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("utils.ts"))).toBe(true);
    });
  });

  test("excludes node_modules directory", async () => {
    await withTestDir(async (testDir) => {
      const nodeModulesDir = join(testDir, "node_modules", "some-package");
      await mkdir(nodeModulesDir, { recursive: true });
      await writeFile(join(testDir, "app.ts"), "export const app = {};");
      await writeFile(
        join(nodeModulesDir, "index.ts"),
        "export const lib = {};"
      );

      const files = await findInfraFiles(testDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/app\.ts$/);
      expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    });
  });

  test("excludes nested node_modules directories", async () => {
    await withTestDir(async (testDir) => {
      const srcDir = join(testDir, "src");
      const nodeModulesDir = join(srcDir, "node_modules");
      await mkdir(nodeModulesDir, { recursive: true });
      await writeFile(join(testDir, "app.ts"), "export const app = {};");
      await writeFile(join(srcDir, "lib.ts"), "export const lib = {};");
      await writeFile(
        join(nodeModulesDir, "package.ts"),
        "export const pkg = {};"
      );

      const files = await findInfraFiles(testDir);
      expect(files).toHaveLength(2);
      expect(files.some((f) => f.endsWith("app.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("lib.ts"))).toBe(true);
      expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    });
  });

  test("ignores non-.ts files", async () => {
    await withTestDir(async (testDir) => {
      await writeFile(join(testDir, "app.ts"), "export const app = {};");
      await writeFile(join(testDir, "readme.md"), "# README");
      await writeFile(join(testDir, "config.json"), "{}");
      await writeFile(join(testDir, "script.js"), "console.log();");

      const files = await findInfraFiles(testDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/app\.ts$/);
    });
  });

  test("handles mixed file types and test files", async () => {
    await withTestDir(async (testDir) => {
      await writeFile(join(testDir, "app.ts"), "export const app = {};");
      await writeFile(join(testDir, "app.test.ts"), "test();");
      await writeFile(join(testDir, "app.spec.ts"), "test();");
      await writeFile(join(testDir, "config.ts"), "export const config = {};");
      await writeFile(join(testDir, "readme.md"), "# README");

      const files = await findInfraFiles(testDir);
      expect(files).toHaveLength(2);
      expect(files.some((f) => f.endsWith("app.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith("config.ts"))).toBe(true);
    });
  });

  test("returns full paths to files", async () => {
    await withTestDir(async (testDir) => {
      await writeFile(join(testDir, "app.ts"), "export const app = {};");

      const files = await findInfraFiles(testDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toBe(join(testDir, "app.ts"));
    });
  });

  test("handles directories with no .ts files", async () => {
    await withTestDir(async (testDir) => {
      await mkdir(join(testDir, "docs"), { recursive: true });
      await writeFile(join(testDir, "docs", "readme.md"), "# README");
      await writeFile(join(testDir, "package.json"), "{}");

      const files = await findInfraFiles(testDir);
      expect(files).toEqual([]);
    });
  });

  test("handles non-existent directory gracefully", async () => {
    await withTestDir(async (testDir) => {
      const nonExistentPath = join(testDir, "does-not-exist");
      const files = await findInfraFiles(nonExistentPath);
      expect(files).toEqual([]);
    });
  });
});
