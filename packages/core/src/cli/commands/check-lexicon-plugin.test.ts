import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadLexiconFromDir, pluginEntryFor, registers, safeList } from "./check-lexicon-plugin";
import type { LexiconPlugin } from "../../lexicon";

const roots: string[] = [];

function lexiconDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-lexicon-load-"));
  roots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

/** A module source exporting a minimally valid LexiconPlugin. */
const pluginSource = (name: string, extra = "") => `
export const plugin = {
  name: ${JSON.stringify(name)},
  serializer: { name: ${JSON.stringify(name)}, rulePrefix: "XYZ", serialize: () => "" },
  generate: async () => {},
  validate: async () => {},
  coverage: async () => {},
  package: async () => {},
  ${extra}
};
`;

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("pluginEntryFor", () => {
  test("prefers the entry the package declares", () => {
    const dir = lexiconDir({
      "package.json": JSON.stringify({ exports: { ".": { default: "./src/index.ts" } } }),
      "src/index.ts": "",
      "src/plugin.ts": "",
    });
    expect(pluginEntryFor(dir)).toBe(join(dir, "src/index.ts"));
  });

  test("falls back to src/index.ts when no entry is declared", () => {
    const dir = lexiconDir({ "src/index.ts": "" });
    expect(pluginEntryFor(dir)).toBe(join(dir, "src/index.ts"));
  });

  test("falls back to src/plugin.ts when there is no index", () => {
    const dir = lexiconDir({ "src/plugin.ts": "" });
    expect(pluginEntryFor(dir)).toBe(join(dir, "src/plugin.ts"));
  });

  test("skips a declared entry that does not exist", () => {
    const dir = lexiconDir({
      "package.json": JSON.stringify({ exports: { ".": { default: "./dist/index.js" } } }),
      "src/index.ts": "",
    });
    expect(pluginEntryFor(dir)).toBe(join(dir, "src/index.ts"));
  });

  test("returns undefined when nothing is importable", () => {
    expect(pluginEntryFor(lexiconDir({ "README.md": "" }))).toBeUndefined();
  });
});

describe("loadLexiconFromDir", () => {
  test("finds the plugin among the module's exports", async () => {
    const dir = lexiconDir({ "src/index.ts": pluginSource("mock") });
    const loaded = await loadLexiconFromDir(dir);
    expect(loaded.error).toBeUndefined();
    expect(loaded.plugin?.name).toBe("mock");
  });

  test("reports a directory with no importable entry rather than throwing", async () => {
    const loaded = await loadLexiconFromDir(lexiconDir({ "README.md": "" }));
    expect(loaded.plugin).toBeUndefined();
    expect(loaded.error).toContain("no importable entry point");
  });

  test("reports a module that exports no plugin", async () => {
    const dir = lexiconDir({ "src/index.ts": "export const notAPlugin = { name: 'x' };" });
    const loaded = await loadLexiconFromDir(dir);
    expect(loaded.plugin).toBeUndefined();
    expect(loaded.error).toBe("the module exports no LexiconPlugin");
  });

  test("reports an import failure as a finding, not a crash", async () => {
    const dir = lexiconDir({ "src/index.ts": "this is not valid typescript ((((" });
    const loaded = await loadLexiconFromDir(dir);
    expect(loaded.plugin).toBeUndefined();
    expect(loaded.error).toContain("import failed");
  });

  test("a plugin missing a required lifecycle method is not a LexiconPlugin", async () => {
    const dir = lexiconDir({
      "src/index.ts": `
        export const plugin = {
          name: "half",
          serializer: { name: "half", serialize: () => "" },
          generate: async () => {},
        };
      `,
    });
    expect((await loadLexiconFromDir(dir)).error).toBe("the module exports no LexiconPlugin");
  });
});

describe("registers", () => {
  const plugin = { name: "x", hoverProvider: () => undefined } as unknown as LexiconPlugin;

  test("true for a function member", () => {
    expect(registers(plugin, "hoverProvider")).toBe(true);
  });

  test("false for an absent member — the helm case", () => {
    expect(registers(plugin, "completionProvider")).toBe(false);
  });

  test("false when there is no plugin at all", () => {
    expect(registers(undefined, "hoverProvider")).toBe(false);
  });
});

describe("safeList", () => {
  test("returns the list", () => {
    expect(safeList(() => [1, 2])).toEqual({ items: [1, 2] });
  });

  test("an absent member is an empty list, not an error", () => {
    expect(safeList<number>(undefined)).toEqual({ items: [] });
  });

  test("a member that throws is reported rather than aborting the run", () => {
    const result = safeList<number>(() => {
      throw new Error("no rules directory");
    });
    expect(result.items).toEqual([]);
    expect(result.error).toBe("no rules directory");
  });

  test("a member returning undefined is an empty list", () => {
    expect(safeList(() => undefined as unknown as number[])).toEqual({ items: [] });
  });
});
