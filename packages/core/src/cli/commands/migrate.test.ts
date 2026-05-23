import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateCommand } from "./migrate";
import type { LexiconPlugin, MigrationResult } from "../../lexicon";

function stubPlugin(behavior: Partial<{ supports: string[]; detect: boolean; result: MigrationResult }>): LexiconPlugin {
  return {
    name: "stub",
    serializer: { name: "stub", rulePrefix: "STB", serialize: () => "" },
    async generate() {},
    async validate() {},
    async coverage() {},
    async package() {},
    migrationSource(from: string) {
      if (!(behavior.supports ?? ["github"]).includes(from)) return undefined;
      return {
        detect: () => behavior.detect ?? true,
        async transform() {
          return behavior.result ?? { output: "stub-output", provenance: [], diagnostics: [] };
        },
      };
    },
  };
}

describe("migrateCommand", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "chant-migrate-test-"));
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("fails when target lexicon is not installed", async () => {
    const file = join(testDir, "ci.yml");
    writeFileSync(file, "jobs:\n  x:\n    runs-on: ubuntu-latest\n");
    const r = await migrateCommand({
      sourceFile: file, from: "github", to: "missing",
      emit: "yaml", strict: false, validate: false, useComposites: false,
      plugins: [],
    });
    expect(r.exitCode).toBe(1);
    expect(r.error).toContain("not installed");
  });

  test("fails when target lexicon does not support migration", async () => {
    const file = join(testDir, "ci.yml");
    writeFileSync(file, "jobs:\n  x:\n    runs-on: ubuntu-latest\n");
    const plugin: LexiconPlugin = {
      name: "no-migrate",
      serializer: { name: "no-migrate", rulePrefix: "NM", serialize: () => "" },
      async generate() {},
      async validate() {},
      async coverage() {},
      async package() {},
    };
    const r = await migrateCommand({
      sourceFile: file, from: "github", to: "no-migrate",
      emit: "yaml", strict: false, validate: false, useComposites: false,
      plugins: [plugin],
    });
    expect(r.exitCode).toBe(1);
    expect(r.error).toContain("does not support migration");
  });

  test("fails when source content is not recognised", async () => {
    const file = join(testDir, "ci.yml");
    writeFileSync(file, "not a workflow");
    const r = await migrateCommand({
      sourceFile: file, from: "github", to: "stub",
      emit: "yaml", strict: false, validate: false, useComposites: false,
      plugins: [stubPlugin({ detect: false })],
    });
    expect(r.exitCode).toBe(1);
    expect(r.error).toContain("does not look like github");
  });

  test("writes output to --output file", async () => {
    const file = join(testDir, "ci.yml");
    const out = join(testDir, "out.yml");
    writeFileSync(file, "jobs:\n  x:\n    runs-on: ubuntu-latest\n");
    const r = await migrateCommand({
      sourceFile: file, from: "github", to: "stub", output: out,
      emit: "yaml", strict: false, validate: false, useComposites: false,
      plugins: [stubPlugin({ result: { output: "hello-yaml\n", provenance: [], diagnostics: [] } })],
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf-8")).toBe("hello-yaml\n");
  });

  test("--strict escalates error diagnostics to non-zero exit", async () => {
    const file = join(testDir, "ci.yml");
    writeFileSync(file, "jobs:\n  x:\n    runs-on: ubuntu-latest\n");
    const r = await migrateCommand({
      sourceFile: file, from: "github", to: "stub", output: join(testDir, "out.yml"),
      emit: "yaml", strict: true, validate: false, useComposites: false,
      plugins: [stubPlugin({
        result: {
          output: "out",
          provenance: [],
          diagnostics: [{ severity: "error", ruleId: "TEST-001", message: "bad", file: "<input>", line: 1, column: 1 }],
        },
      })],
    });
    expect(r.exitCode).toBe(1);
  });

  test("--strict off keeps exit 0 even with error diagnostics", async () => {
    const file = join(testDir, "ci.yml");
    writeFileSync(file, "jobs:\n  x:\n    runs-on: ubuntu-latest\n");
    const r = await migrateCommand({
      sourceFile: file, from: "github", to: "stub", output: join(testDir, "out.yml"),
      emit: "yaml", strict: false, validate: false, useComposites: false,
      plugins: [stubPlugin({
        result: {
          output: "out",
          provenance: [],
          diagnostics: [{ severity: "error", ruleId: "TEST-001", message: "bad", file: "<input>", line: 1, column: 1 }],
        },
      })],
    });
    expect(r.exitCode).toBe(0);
  });
});
