import { describe, test, expect } from "vitest";
import { findInfraFiles, compileDiscoveryFilter, hasSkipMarker, SKIP_MARKER } from "./files";
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

  test("skips chant-generated files (marker header)", async () => {
    await withTestDir(async (testDir) => {
      await writeFile(join(testDir, "app.ts"), "export const app = {};");
      // A generated worker bootstrap: self-executes on import and uses runtime
      // patterns the EVL* rules forbid — discovery must not pick it up.
      await writeFile(
        join(testDir, "worker.ts"),
        "// Generated by chant — do not edit directly.\nrun();",
      );

      const files = await findInfraFiles(testDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/app\.ts$/);
      expect(files.some((f) => f.endsWith("worker.ts"))).toBe(false);
    });
  });
});

describe("findInfraFiles — project exclude/include globs (#2519)", () => {
  /** Lay out a project: `files` maps a relative path to its contents. */
  async function project(testDir: string, config: Record<string, unknown> | undefined, files: Record<string, string>) {
    if (config) await writeFile(join(testDir, "chant.config.json"), JSON.stringify(config));
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(join(testDir, rel, ".."), { recursive: true });
      await writeFile(join(testDir, rel), body);
    }
  }
  const rel = (testDir: string, files: string[]) => files.map((f) => f.slice(testDir.length + 1)).sort();

  const LAYOUT = {
    "src/app.ts": "export const app = {};",
    "src/lib/util.ts": "export const util = {};",
    "ops/run.ts": "process.exit(2);",
    "ops/keep.ts": "export const keep = {};",
    ".stage/copy.ts": "export const copy = {};",
  };

  test("with neither key configured, discovery returns exactly what it did before", async () => {
    await withTestDir(async (testDir) => {
      await project(testDir, { lexicons: ["aws"] }, LAYOUT);
      expect(rel(testDir, await findInfraFiles(testDir))).toEqual([
        ".stage/copy.ts", "ops/keep.ts", "ops/run.ts", "src/app.ts", "src/lib/util.ts",
      ]);
    });
  });

  test.each([["ops"], ["ops/**"], ["ops/*.ts"]])("exclude %s skips everything under ops/", async (pattern) => {
    await withTestDir(async (testDir) => {
      await project(testDir, { exclude: [pattern] }, LAYOUT);
      expect(rel(testDir, await findInfraFiles(testDir))).toEqual([".stage/copy.ts", "src/app.ts", "src/lib/util.ts"]);
    });
  });

  test("patterns match dot directories", async () => {
    await withTestDir(async (testDir) => {
      await project(testDir, { exclude: [".stage"] }, LAYOUT);
      expect(rel(testDir, await findInfraFiles(testDir))).not.toContain(".stage/copy.ts");
    });
  });

  test("include wins over exclude", async () => {
    await withTestDir(async (testDir) => {
      await project(testDir, { exclude: ["ops"], include: ["ops/keep.ts"] }, LAYOUT);
      expect(rel(testDir, await findInfraFiles(testDir))).toEqual([
        ".stage/copy.ts", "ops/keep.ts", "src/app.ts", "src/lib/util.ts",
      ]);
    });
  });

  test("exclude everything and include a directory narrows discovery to it", async () => {
    await withTestDir(async (testDir) => {
      await project(testDir, { exclude: ["**"], include: ["src"] }, LAYOUT);
      expect(rel(testDir, await findInfraFiles(testDir))).toEqual(["src/app.ts", "src/lib/util.ts"]);
    });
  });

  test("include alone changes nothing", async () => {
    await withTestDir(async (testDir) => {
      await project(testDir, { include: ["src"] }, LAYOUT);
      expect(await findInfraFiles(testDir)).toHaveLength(5);
    });
  });

  test("patterns stay relative to the project root when discovery starts in a subdirectory", async () => {
    await withTestDir(async (testDir) => {
      await project(testDir, { exclude: ["src/lib"] }, LAYOUT);
      expect(rel(testDir, await findInfraFiles(join(testDir, "src")))).toEqual(["src/app.ts"]);
    });
  });

  test("include does not re-admit test files", async () => {
    await withTestDir(async (testDir) => {
      await project(testDir, { exclude: ["ops"], include: ["**"] }, { ...LAYOUT, "src/app.test.ts": "test();" });
      expect(rel(testDir, await findInfraFiles(testDir))).not.toContain("src/app.test.ts");
    });
  });

  test("explicit globs override the config; null applies none", async () => {
    await withTestDir(async (testDir) => {
      await project(testDir, { exclude: ["ops"] }, LAYOUT);
      expect(await findInfraFiles(testDir, { globs: null })).toHaveLength(5);
      const only = await findInfraFiles(testDir, { globs: { root: testDir, exclude: ["src"], include: [] } });
      expect(rel(testDir, only)).toEqual([".stage/copy.ts", "ops/keep.ts", "ops/run.ts"]);
    });
  });
});

describe("compileDiscoveryFilter (#2519)", () => {
  test("is undefined with no exclude patterns", () => {
    expect(compileDiscoveryFilter(undefined)).toBeUndefined();
    expect(compileDiscoveryFilter({ root: "/p", exclude: [], include: ["**"] })).toBeUndefined();
  });

  test("never skips a file outside the root", () => {
    const skip = compileDiscoveryFilter({ root: "/p/app", exclude: ["**"], include: [] })!;
    expect(skip("/p/app/x.ts")).toBe(true);
    expect(skip("/p/other/x.ts")).toBe(false);
  });
});

describe("findInfraFiles — skip marker (#2519)", () => {
  test.each([
    ["a line comment", `// ${SKIP_MARKER}\nprocess.exit(2);`],
    ["a line comment after a shebang", `#!/usr/bin/env -S node --import tsx\n// ${SKIP_MARKER}: a runner, not a declaration\nprocess.exit(2);`],
    ["a block comment", `/**\n * Runs an Op.\n * ${SKIP_MARKER}\n */\nprocess.exit(2);`],
  ])("skips a file carrying the marker in %s", async (_label, body) => {
    await withTestDir(async (testDir) => {
      await writeFile(join(testDir, "app.ts"), "export const app = {};");
      await writeFile(join(testDir, "run.ts"), body);
      const files = await findInfraFiles(testDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/app\.ts$/);
    });
  });

  test.each([
    ["in a string", `export const s = "${SKIP_MARKER}";`],
    ["as a longer word", `// ${SKIP_MARKER}-not\nexport const a = {};`],
    ["past the head", `${"// padding\n".repeat(100)}// ${SKIP_MARKER}\nexport const a = {};`],
  ])("does not treat the marker %s as a skip", (_label, body) => {
    expect(hasSkipMarker(body)).toBe(false);
  });
});
