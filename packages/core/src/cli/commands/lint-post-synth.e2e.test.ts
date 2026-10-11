import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { lintCommand, BUILD_FAILURE_RULE_ID } from "./lint";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Each case builds a small project against the workspace's sql lexicon and runs its post-synth
// checks; the first loads the lexicon and took 3.1s on CI, near the unit project's 5s budget, so the
// block is an e2e file (#3793). The rest of lintCommand's tests are in lint.test.ts.

/**
 * chant #3750 — `chant lint` runs each loaded lexicon's own post-synth checks
 * over an in-memory build of the lint target, the ones `chant build` runs.
 * The sql lexicon's SQLCH101 is the issue's repro: `ENGINE = MergeTre` failed
 * the build and linted clean. The project imports the workspace's sql
 * lexicon through a `node_modules` link, as an installed project would.
 */
describe("lintCommand — lexicon post-synth checks (#3750)", () => {
  const repoNodeModules = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../node_modules");
  let root: string;

  const schema = (engine: string, idType = "UInt64") =>
    'import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";\n' +
    "export const shopDb = database`CREATE DATABASE shop ENGINE = Atomic`;\n" +
    "export const events = table`\n" +
    `  CREATE TABLE \${shopDb}.events (id ${idType}, kind String)\n` +
    `  ENGINE = ${engine}\n` +
    "  ORDER BY (kind, id)`;\n";

  async function project(engine: string, rules?: Record<string, string>, idType?: string): Promise<void> {
    await writeFile(
      join(root, "chant.config.json"),
      JSON.stringify({ lexicons: ["sql"], sql: { dialect: "clickhouse" }, ...(rules ? { lint: { rules } } : {}) }),
    );
    await writeFile(join(root, "src", "schema.ts"), schema(engine, idType));
  }

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "chant-3750-")));
    await mkdir(join(root, "src"), { recursive: true });
    symlinkSync(repoNodeModules, join(root, "node_modules"), "dir");
    process.env.NO_COLOR = "1";
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    delete process.env.NO_COLOR;
  });

  test("a lexicon post-synth error fails the lint, at the project root and at src", async () => {
    await project("MergeTre");
    for (const path of [root, join(root, "src")]) {
      const result = await lintCommand({ path, format: "stylish" });
      expect(result.success).toBe(false);
      const diag = result.diagnostics.find((d) => d.ruleId === "SQLCH101");
      expect(diag, result.output).toBeDefined();
      expect(diag!.severity).toBe("error");
      expect(diag!.message).toContain('"MergeTre"');
      // No line of its own: reported at 1:1 in the file that declared the table.
      expect(diag!.file).toBe(join(root, "src", "schema.ts"));
      expect([diag!.line, diag!.column]).toEqual([1, 1]);
      expect(result.output).toContain("SQLCH101");
    }
  });

  test("a column type the pinned server does not have is reported (SQLCH121)", async () => {
    await project("MergeTree", undefined, "UInt46");
    const result = await lintCommand({ path: root, format: "stylish" });
    expect(result.success).toBe(false);
    const diag = result.diagnostics.find((d) => d.ruleId === "SQLCH121");
    expect(diag, result.output).toBeDefined();
    expect(diag!.message).toContain("UInt46");
  });

  test("postSynth: false lints source alone", async () => {
    await project("MergeTre");
    const result = await lintCommand({ path: root, format: "stylish", postSynth: false });
    expect(result.diagnostics.some((d) => d.ruleId === "SQLCH101")).toBe(false);
  });

  test("a clean project reports nothing from the post-synth pass", async () => {
    await project("MergeTree");
    const result = await lintCommand({ path: root, format: "stylish" });
    expect(result.diagnostics.filter((d) => /^SQL|^LEX/.test(d.ruleId)), result.output).toEqual([]);
  });

  test("lint.rules overrides a post-synth finding's severity, and turns it off", async () => {
    await project("MergeTre", { SQLCH101: "warning" });
    const warned = await lintCommand({ path: root, format: "stylish" });
    expect(warned.diagnostics.find((d) => d.ruleId === "SQLCH101")?.severity).toBe("warning");
    expect(warned.success).toBe(true);

    await project("MergeTre", { SQLCH101: "off" });
    const off = await lintCommand({ path: root, format: "stylish" });
    expect(off.diagnostics.some((d) => d.ruleId === "SQLCH101")).toBe(false);
  });

  test("a target that does not build reports the build error and skips the checks", async () => {
    await project("MergeTre");
    // A table interpolating a name that is not declared does not build.
    await writeFile(
      join(root, "src", "broken.ts"),
      'import { table } from "@intentius/chant-lexicon-sql/clickhouse";\n' +
        'import { events } from "./schema";\n' +
        "export const copy = table`CREATE TABLE shop.copy (id UInt64) ENGINE = MergeTree ORDER BY ${(events as any).columns.nope}`;\n",
    );
    const result = await lintCommand({ path: root, format: "stylish" });
    expect(result.success).toBe(false);
    const failures = result.diagnostics.filter((d) => d.ruleId === BUILD_FAILURE_RULE_ID);
    expect(failures.length, result.output).toBeGreaterThan(0);
    expect(failures.every((d) => d.severity === "error")).toBe(true);
    expect(failures.map((d) => d.message).join("\n")).toContain("is undefined");
    expect(result.diagnostics.some((d) => d.ruleId === "SQLCH101")).toBe(false);
  });
});
