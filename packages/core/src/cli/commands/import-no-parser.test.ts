import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LexiconPlugin } from "../../lexicon";
import { importCommand, importFromContent } from "./import";

// A lexicon that recognizes a template but has no templateParser, as grafana
// did until #2945 (#2940). Import must say it cannot import, not throw
// "plugin.templateParser is not a function".
const { detectOnly } = vi.hoisted(() => ({
  detectOnly: {
    name: "detect-only",
    detectTemplate: (data: unknown) =>
      typeof data === "object" && data !== null && "detectOnlyMarker" in data,
  } as unknown as LexiconPlugin,
}));

vi.mock("../plugins", () => ({
  resolveProjectLexicons: async () => ["detect-only"],
  loadPlugins: async (names: string[]) => names.map(() => detectOnly),
}));

const EXPECTED = 'lexicon "detect-only" does not support template import';

describe("import through a lexicon with detectTemplate and no templateParser (#2940)", () => {
  let testDir: string;
  let templatePath: string;
  let outputDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-import-no-parser-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
    templatePath = join(testDir, "dashboard.json");
    outputDir = join(testDir, "out");
    await writeFile(templatePath, JSON.stringify({ detectOnlyMarker: true, panels: [] }));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("file import with detection fails cleanly", async () => {
    const result = await importCommand({ templatePath, output: outputDir });
    expect(result.success).toBe(false);
    expect(result.error).toBe(EXPECTED);
    expect(result.error).not.toContain("is not a function");
    expect(result.lexicon).toBe("detect-only");
    expect(existsSync(outputDir)).toBe(false);
  });

  test("file import with --lexicon fails cleanly", async () => {
    const result = await importCommand({ templatePath, output: outputDir, lexicon: "detect-only" });
    expect(result.success).toBe(false);
    expect(result.error).toBe(EXPECTED);
    expect(existsSync(outputDir)).toBe(false);
  });

  test("content import fails cleanly", async () => {
    const result = await importFromContent({
      content: JSON.stringify({ detectOnlyMarker: true }),
      lexicon: "detect-only",
      output: outputDir,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe(EXPECTED);
    expect(existsSync(outputDir)).toBe(false);
  });
});
