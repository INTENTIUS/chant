import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { lintCommand, isLintRule, loadPluginRules, LEXICON_RESOLUTION_RULE_ID, type LintOptions } from "./lint";
import { loadPlugins, resolveProjectLexicons } from "../plugins";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

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

  // #2122 (epic #2114 sub-issue 6) — OPS013 is a core-owned Op-model
  // post-synth check, run over every `*.op.ts` file `chant lint` finds under
  // the target path with no lexicon or build needed. This is the acceptance
  // criterion: it fires on a fixture with a dangling `stepOutput` reference,
  // on a project with no lexicons configured (no `plugins` in `options`
  // below, the same as every other test in this file).
  test("OPS013 fires on a dangling stepOutput reference with no lexicons configured", async () => {
    await writeFile(
      join(testDir, "reconcile.op.ts"),
      `
export default {
  [Symbol.for("chant.declarable")]: true,
  entityType: "Chant::Op",
  lexicon: "chant",
  kind: "resource",
  props: {
    name: "reconcile",
    overview: "test",
    phases: [
      { name: "Phase", steps: [
        {
          kind: "activity",
          fn: "httpCheck",
          args: {
            url: "http://x",
            contains: { [Symbol.for("chant.op.stepOutputRef")]: true, kind: "step-output-ref", step: "nope", path: "x" },
          },
        },
      ] },
    ],
  },
};
      `,
    );

    const options: LintOptions = {
      path: testDir,
      format: "stylish",
    };

    const result = await lintCommand(options);

    expect(result.success).toBe(false);
    expect(
      result.diagnostics.some((d) => d.ruleId === "OPS013" && d.message.includes('unknown step id "nope"')),
    ).toBe(true);
  });

  // #2251 — `chant lint` imports every `*.op.ts` file to read the Op it
  // declares, and an Op that takes a step argument from `params.<name>`
  // (`@intentius/chant/params`) evaluates that read at module load. Before
  // this, nothing populated the shared parameters object first, so every such
  // argument was `undefined` and OPS012 reported the activity contract
  // violated on source that builds and runs. The fixture imports the real
  // params module by absolute path — `@intentius/chant/params` maps to the
  // same file (packages/core/package.json's `exports`), so it is the one
  // module record `lintCommand` mutates.
  describe("build parameters reach an Op's step arguments (#2251)", () => {
    const paramsModule = resolve(import.meta.dirname, "../../params.ts");

    async function writeParamReadingOp(): Promise<void> {
      await writeFile(
        join(testDir, "mini.op.ts"),
        `
import { params } from ${JSON.stringify(paramsModule)};

export default {
  [Symbol.for("chant.declarable")]: true,
  entityType: "Chant::Op",
  lexicon: "chant",
  kind: "resource",
  props: {
    name: "mini",
    overview: "test",
    phases: [
      { name: "Greet", steps: [
        { kind: "activity", fn: "shellCmd", args: { cmd: params.greeting } },
      ] },
    ],
  },
};
        `,
      );
    }

    test("OPS012 does not fire when the invocation's parameters are supplied", async () => {
      await writeParamReadingOp();

      const result = await lintCommand({
        path: testDir,
        format: "stylish",
        buildParams: [{ name: "greeting", value: "echo hi", source: "default" }],
      });

      expect(result.diagnostics.filter((d) => d.ruleId === "OPS012")).toEqual([]);
      expect(result.success).toBe(true);
    });

    test("OPS012 fires on the same source when no parameters are supplied", async () => {
      await writeParamReadingOp();

      const result = await lintCommand({ path: testDir, format: "stylish" });

      expect(
        result.diagnostics.some(
          (d) => d.ruleId === "OPS012" && d.message.includes("args.cmd"),
        ),
      ).toBe(true);
    });
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
    const fixtureDir = resolve(import.meta.dirname, "__fixtures__");
    const rules = await loadPluginRules(["./sample-rule.ts"], fixtureDir);

    expect(rules.size).toBe(1);
    expect(rules.has("TEST001")).toBe(true);

    const rule = rules.get("TEST001")!;
    expect(rule.severity).toBe("warning");
    expect(rule.category).toBe("style");
  });

  test("silently skips non-LintRule exports", async () => {
    const fixtureDir = resolve(import.meta.dirname, "__fixtures__");
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

/**
 * chant #1106 — `runLint`'s EVL rules now receive the active lexicons'
 * registered intrinsics (threaded from `loadAllPluginRules`'s
 * `plugin.intrinsics?.()`, mirroring how `../commands/build.ts` gathers the
 * same set for the fold path). Before this, `chant lint` flagged
 * `Ref(...)` — a registered, opted-in call-form intrinsic (aws's
 * `lexicons/aws/src/plugin.ts`) that `chant build --fold` folds cleanly —
 * as EVL001, purely because EVL001's shared `../../fold/subset.ts`
 * predicate never saw the registry. These use the real aws lexicon plugin
 * (already a workspace dependency) rather than a mock, so the registration
 * this asserts against is the one that actually ships.
 */
describe("lintCommand — EVL/intrinsic registry convergence (#1106)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-lint-intrinsics-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
    process.env.NO_COLOR = "1";
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    delete process.env.NO_COLOR;
  });

  test("a registered, opted-in intrinsic call (aws's Ref) is not flagged as EVL001", async () => {
    await writeFile(join(testDir, "chant.config.json"), JSON.stringify({ lexicons: ["aws"] }));
    await writeFile(
      join(testDir, "index.ts"),
      `
import { Ref } from "@intentius/chant-lexicon-aws";

class Queue {
  constructor(_props: Record<string, unknown>) {}
}

export const environment = "prod";
export const queue = new Queue({ name: Ref(environment) });
      `,
    );

    const result = await lintCommand({ path: testDir, format: "stylish" });

    expect(result.diagnostics.filter((d) => d.ruleId === "EVL001")).toHaveLength(0);
  });

  test("an unregistered call is still flagged as EVL001 in the same project", async () => {
    await writeFile(join(testDir, "chant.config.json"), JSON.stringify({ lexicons: ["aws"] }));
    await writeFile(
      join(testDir, "index.ts"),
      `
import { Ref } from "@intentius/chant-lexicon-aws";

class Queue {
  constructor(_props: Record<string, unknown>) {}
}

function makeName(): string {
  return "generated";
}

export const queue = new Queue({ name: makeName() });
      `,
    );

    const result = await lintCommand({ path: testDir, format: "stylish" });

    const evl001 = result.diagnostics.filter((d) => d.ruleId === "EVL001");
    expect(evl001).toHaveLength(1);
    expect(evl001[0].message).toContain("statically evaluable");
  });
});

describe("lintCommand — project-root config resolution (scoped lint)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-lint-scope-${Date.now()}-${Math.random()}`);
    await mkdir(join(testDir, "src", "lib"), { recursive: true });
    process.env.NO_COLOR = "1";
    // Root config disables EVL003 for src/lib/** — a project-root-relative glob.
    await writeFile(
      join(testDir, "chant.config.json"),
      JSON.stringify({ overrides: [{ files: ["src/lib/**"], rules: { EVL003: "off" } }] }),
    );
    // A runtime helper with dynamic property access — EVL003 fires unless overridden.
    await writeFile(
      join(testDir, "src", "lib", "naming.ts"),
      `const table = { a: 1 };\nexport function pick(k: string) { return table[k]; }\n`,
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    delete process.env.NO_COLOR;
  });

  test("linting the project root applies the src/lib/** override", async () => {
    const result = await lintCommand({ path: testDir, format: "stylish" });
    expect(result.diagnostics.filter((d) => d.ruleId === "EVL003")).toHaveLength(0);
  });

  test("linting a subpath still finds the root config and applies the override", async () => {
    // Regression: overrides are project-root-relative, so a scoped lint must
    // anchor config discovery + glob matching on the root, not the path arg.
    const result = await lintCommand({ path: join(testDir, "src"), format: "stylish" });
    expect(result.diagnostics.filter((d) => d.ruleId === "EVL003")).toHaveLength(0);
  });

  test("a file outside the override glob still reports EVL003 under a scoped lint", async () => {
    await mkdir(join(testDir, "src", "runtime"), { recursive: true });
    await writeFile(
      join(testDir, "src", "runtime", "other.ts"),
      `const t = { a: 1 };\nexport function g(k: string) { return t[k]; }\n`,
    );
    const result = await lintCommand({ path: join(testDir, "src"), format: "stylish" });
    const evl003 = result.diagnostics.filter((d) => d.ruleId === "EVL003");
    expect(evl003).toHaveLength(1);
    expect(evl003[0].file).toContain(join("src", "runtime", "other.ts"));
  });
});

describe("lintCommand — git-ignored files are not linted", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-lint-gitignore-${Date.now()}-${Math.random()}`);
    await mkdir(join(testDir, "vendor"), { recursive: true });
    process.env.NO_COLOR = "1";
    execFileSync("git", ["init", "-q"], { cwd: testDir });
    await writeFile(join(testDir, ".gitignore"), "vendor/\n");
    // Vendored code full of a pattern EVL003 forbids — but it's not our source.
    await writeFile(
      join(testDir, "vendor", "app.ts"),
      `const t = { a: 1 };\nexport function g(k: string) { return t[k]; }\n`,
    );
    // A clean authored file at the root.
    await writeFile(join(testDir, "index.ts"), `export const x = 1;\n`);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    delete process.env.NO_COLOR;
  });

  test("skips gitignored vendor/ so its EVL violations don't gate the project", async () => {
    const result = await lintCommand({ path: testDir, format: "stylish" });
    expect(result.diagnostics.filter((d) => d.file.includes("vendor"))).toHaveLength(0);
    expect(result.success).toBe(true);
  });

  test("still lints a non-ignored file with the same violation", async () => {
    await writeFile(
      join(testDir, "authored.ts"),
      `const t = { a: 1 };\nexport function g(k: string) { return t[k]; }\n`,
    );
    const result = await lintCommand({ path: testDir, format: "stylish" });
    expect(result.diagnostics.some((d) => d.file.includes("authored.ts") && d.ruleId === "EVL003")).toBe(true);
  });
});

/**
 * chant #2222 (epic #2215 sub-issue 7) — `chant lint` used to print "No
 * problems found" and exit 0 on a project whose declared lexicon could not be
 * resolved, the state `chant build` refuses outright. These pin both halves:
 * the failure is now reported, and the one case the old `catch` legitimately
 * covered (a project that declares no lexicon at all) still lints quietly.
 */
describe("lintCommand — a declared lexicon that cannot be resolved (#2222)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-lint-lexicon-${Date.now()}-${Math.random()}`);
    await mkdir(join(testDir, "src"), { recursive: true });
    await writeFile(join(testDir, "src", "clean.ts"), `export const x = 1;\n`);
    process.env.NO_COLOR = "1";
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    delete process.env.NO_COLOR;
  });

  /** The message `chant build` prints after `error: ` for the same project. */
  async function buildsMessageFor(dir: string): Promise<string> {
    try {
      await loadPlugins(await resolveProjectLexicons(dir));
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error(`expected ${dir} to fail lexicon resolution`);
  }

  test("a declared lexicon whose package is not installed fails the lint", async () => {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `export default { lexicons: ["not-a-real-lexicon"] };\n`,
    );

    const result = await lintCommand({ path: testDir, format: "stylish" });

    expect(result.success).toBe(false);
    expect(result.errorCount).toBe(1);
    const diag = result.diagnostics.find((d) => d.ruleId === LEXICON_RESOLUTION_RULE_ID);
    expect(diag).toBeDefined();
    expect(diag!.severity).toBe("error");
    expect(diag!.file).toBe(join(testDir, "chant.config.ts"));
    // Byte-for-byte what `chant build` reports, not a second wording.
    expect(diag!.message).toBe(await buildsMessageFor(testDir));
    expect(result.output).not.toContain("No problems found");
  });

  test("a chant.config that cannot be loaded at all fails the lint with its own error", async () => {
    // The shape found in the wild: the config imports the lexicon package, so
    // it throws before `lexicons` is ever read.
    await writeFile(
      join(testDir, "chant.config.ts"),
      `import { thing } from "@intentius/chant-lexicon-not-a-real-lexicon";\n` +
        `export default { lexicons: ["aws"], thing };\n`,
    );

    const result = await lintCommand({ path: testDir, format: "stylish" });

    expect(result.success).toBe(false);
    const diag = result.diagnostics.find((d) => d.ruleId === LEXICON_RESOLUTION_RULE_ID);
    expect(diag).toBeDefined();
    expect(diag!.message).toBe(await buildsMessageFor(testDir));
    expect(diag!.message).toContain("@intentius/chant-lexicon-not-a-real-lexicon");
  });

  test("the failure reaches --format json", async () => {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `export default { lexicons: ["not-a-real-lexicon"] };\n`,
    );

    const result = await lintCommand({ path: testDir, format: "json" });

    const parsed = JSON.parse(result.output) as Array<Record<string, unknown>>;
    const entry = parsed.find((d) => d.ruleId === LEXICON_RESOLUTION_RULE_ID);
    expect(entry).toBeDefined();
    expect(entry!.severity).toBe("error");
    expect(entry!.message).toBe(await buildsMessageFor(testDir));
  });

  test("the failure reaches --format sarif as an error-level result", async () => {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `export default { lexicons: ["not-a-real-lexicon"] };\n`,
    );

    const result = await lintCommand({ path: testDir, format: "sarif" });

    const sarif = JSON.parse(result.output) as {
      runs: Array<{ results: Array<{ ruleId: string; level: string; message: { text: string } }> }>;
    };
    const found = sarif.runs[0].results.find((r) => r.ruleId === LEXICON_RESOLUTION_RULE_ID);
    expect(found).toBeDefined();
    expect(found!.level).toBe("error");
    expect(found!.message.text).toBe(await buildsMessageFor(testDir));
  });

  test("--fix does not drop the diagnostic", async () => {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `export default { lexicons: ["not-a-real-lexicon"] };\n`,
    );

    const result = await lintCommand({ path: testDir, format: "stylish", fix: true });

    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.ruleId === LEXICON_RESOLUTION_RULE_ID)).toBe(true);
  });

  // The case the swallowed `catch` was written for, and the one that must not
  // change: no `chant.config.*`, no lexicon import in any source file. The
  // detection fallback throws "No lexicon detected in infrastructure files",
  // which is a project that lints under the core rules alone.
  test("a project with no chant.config at all still lints clean", async () => {
    const result = await lintCommand({ path: testDir, format: "stylish" });

    expect(result.success).toBe(true);
    expect(result.diagnostics.some((d) => d.ruleId === LEXICON_RESOLUTION_RULE_ID)).toBe(false);
    expect(result.output).toContain("No problems found");
  });

  test("a chant.config that declares no lexicons still lints clean", async () => {
    await writeFile(join(testDir, "chant.config.ts"), `export default {};\n`);

    const result = await lintCommand({ path: testDir, format: "stylish" });

    expect(result.success).toBe(true);
    expect(result.diagnostics.some((d) => d.ruleId === LEXICON_RESOLUTION_RULE_ID)).toBe(false);
  });

  test("a declared lexicon that does resolve lints clean", async () => {
    await writeFile(join(testDir, "chant.config.ts"), `export default { lexicons: ["aws"] };\n`);

    const result = await lintCommand({ path: testDir, format: "stylish" });

    expect(result.success).toBe(true);
    expect(result.diagnostics.some((d) => d.ruleId === LEXICON_RESOLUTION_RULE_ID)).toBe(false);
  });
});
