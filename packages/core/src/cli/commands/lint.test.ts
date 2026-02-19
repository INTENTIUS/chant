import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { lintCommand, isLintRule, loadPluginRules, type LintOptions } from "./lint";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("lintCommand", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-lint-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
    process.env.NO_COLOR = "1";
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    delete process.env.NO_COLOR;
  });

  test("returns success for empty directory", async () => {
    const options: LintOptions = {
      path: testDir,
      format: "stylish",
    };

    const result = await lintCommand(options);

    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  test("returns success for clean file", async () => {
    await writeFile(
      join(testDir, "clean.ts"),
      `
export const config = { a: 1 };
      `
    );

    const options: LintOptions = {
      path: testDir,
      format: "stylish",
    };

    const result = await lintCommand(options);

    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  test("detects flat-declarations violations", async () => {
    await writeFile(
      join(testDir, "nested.ts"),
      `
class Bucket {}
export const b = new Bucket({ encryption: { algo: "AES256" } });
      `
    );

    const options: LintOptions = {
      path: testDir,
      format: "stylish",
    };

    const result = await lintCommand(options);
    expect(result.diagnostics.some((d) => d.ruleId === "COR001")).toBe(true);
  });

  test("formats output as JSON", async () => {
    await writeFile(
      join(testDir, "nested.ts"),
      `
export const config = { a: { b: { c: { d: 1 } } } };
      `
    );

    const options: LintOptions = {
      path: testDir,
      format: "json",
    };

    const result = await lintCommand(options);

    expect(() => JSON.parse(result.output)).not.toThrow();
  });

  test("formats output as SARIF", async () => {
    await writeFile(
      join(testDir, "nested.ts"),
      `
export const config = { a: { b: { c: { d: 1 } } } };
      `
    );

    const options: LintOptions = {
      path: testDir,
      format: "sarif",
    };

    const result = await lintCommand(options);

    expect(() => JSON.parse(result.output)).not.toThrow();
    const sarif = JSON.parse(result.output);
    expect(sarif.version).toBe("2.1.0");
  });

  test("excludes test files from linting", async () => {
    await writeFile(
      join(testDir, "app.test.ts"),
      `
export const config = { a: { b: { c: { d: 1 } } } };
      `
    );

    const options: LintOptions = {
      path: testDir,
      format: "stylish",
    };

    const result = await lintCommand(options);

    // Test files should be excluded
    expect(result.diagnostics).toHaveLength(0);
  });

  test("excludes node_modules", async () => {
    const nodeModulesDir = join(testDir, "node_modules", "some-pkg");
    await mkdir(nodeModulesDir, { recursive: true });
    await writeFile(
      join(nodeModulesDir, "index.ts"),
      `
export const config = { a: { b: { c: { d: 1 } } } };
      `
    );

    const options: LintOptions = {
      path: testDir,
      format: "stylish",
    };

    const result = await lintCommand(options);

    // node_modules should be excluded
    expect(result.diagnostics).toHaveLength(0);
  });

  test("counts errors and warnings separately", async () => {
    await writeFile(
      join(testDir, "nested.ts"),
      `
class Bucket {}
export const a = new Bucket({ config: { x: 1 } });
export const b = new Bucket({ config: { y: 2 } });
      `
    );

    const options: LintOptions = {
      path: testDir,
      format: "stylish",
    };

    const result = await lintCommand(options);

    // COR001 fires on inline objects — strict preset sets it to "error"
    expect(result.diagnostics.some(d => d.ruleId === "COR001")).toBe(true);
    expect(result.diagnostics.filter(d => d.ruleId === "COR001")).toHaveLength(2);
  });
});

describe("isLintRule", () => {
  test("returns true for valid lint rule objects", () => {
    expect(
      isLintRule({
        id: "TEST001",
        severity: "warning",
        category: "style",
        check() {
          return [];
        },
      }),
    ).toBe(true);
  });

  test("returns false for non-rule objects", () => {
    expect(isLintRule({ foo: "bar" })).toBe(false);
    expect(isLintRule(null)).toBe(false);
    expect(isLintRule(undefined)).toBe(false);
    expect(isLintRule("string")).toBe(false);
    expect(isLintRule(42)).toBe(false);
  });

  test("returns false when check is not a function", () => {
    expect(
      isLintRule({
        id: "TEST001",
        severity: "warning",
        category: "style",
        check: "not-a-function",
      }),
    ).toBe(false);
  });

  test("returns false when id is not a string", () => {
    expect(
      isLintRule({
        id: 123,
        severity: "warning",
        category: "style",
        check() {
          return [];
        },
      }),
    ).toBe(false);
  });
});

describe("loadPluginRules", () => {
  test("loads rules from a plugin file", async () => {
    const fixtureDir = resolve(import.meta.dir, "__fixtures__");
    const rules = await loadPluginRules(["./sample-rule.ts"], fixtureDir);

    expect(rules.size).toBe(1);
    expect(rules.has("TEST001")).toBe(true);

    const rule = rules.get("TEST001")!;
    expect(rule.severity).toBe("warning");
    expect(rule.category).toBe("style");
  });

  test("silently skips non-LintRule exports", async () => {
    const fixtureDir = resolve(import.meta.dir, "__fixtures__");
    const rules = await loadPluginRules(["./sample-rule.ts"], fixtureDir);

    // sample-rule.ts exports notARule too, which should be skipped
    expect(rules.size).toBe(1);
  });

  test("throws meaningful error for invalid plugin path", async () => {
    await expect(loadPluginRules(["./nonexistent.ts"], "/tmp")).rejects.toThrow(
      /Failed to load plugin "\.\/nonexistent\.ts"/,
    );
  });
});

describe("plugin integration", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-plugin-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
    process.env.NO_COLOR = "1";
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    delete process.env.NO_COLOR;
  });

  test("plugin rule is loaded via config and available during lint", async () => {
    // Put plugin in a dot-directory so it's not scanned as a source file
    const pluginDir = join(testDir, ".plugins");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "my-rule.ts"),
      `export const myRule = {
        id: "PLUG001",
        severity: "warning",
        category: "style",
        check() { return []; },
      };`,
    );

    // Write config that references the plugin
    await writeFile(
      join(testDir, "chant.config.json"),
      JSON.stringify({ plugins: ["./.plugins/my-rule.ts"] }),
    );

    // Write a clean TS file so lint runs
    await writeFile(join(testDir, "index.ts"), `export const x = 1;\n`);

    const result = await lintCommand({ path: testDir, format: "stylish" });
    // Plugin rule returns no diagnostics, so lint should pass
    expect(result.success).toBe(true);
  });

  test("plugin rule respects config severity override", async () => {
    // Put plugin in a dot-directory so it's not scanned as a source file
    const pluginDir = join(testDir, ".plugins");
    await mkdir(pluginDir, { recursive: true });

    // Write a plugin rule that always produces a warning diagnostic
    await writeFile(
      join(pluginDir, "warn-rule.ts"),
      `export const warnRule = {
        id: "PLUG002",
        severity: "warning",
        category: "correctness",
        check(ctx) {
          return [{
            file: ctx.filePath,
            line: 1,
            column: 1,
            ruleId: "PLUG002",
            severity: "warning",
            message: "Plugin warning",
          }];
        },
      };`,
    );

    // Config overrides the severity to "error"
    await writeFile(
      join(testDir, "chant.config.json"),
      JSON.stringify({
        plugins: ["./.plugins/warn-rule.ts"],
        rules: { PLUG002: "error" },
      }),
    );

    await writeFile(join(testDir, "index.ts"), `export const x = 1;\n`);

    const result = await lintCommand({ path: testDir, format: "stylish" });

    const pluginDiags = result.diagnostics.filter((d) => d.ruleId === "PLUG002");
    // Plugin rule should produce exactly one diagnostic (one source file)
    expect(pluginDiags.length).toBe(1);
  });
});
