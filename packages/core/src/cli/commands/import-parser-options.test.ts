import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LexiconPlugin } from "../../lexicon";
import type { ParserOptions } from "../../import/parser";
import { resolveParserOptions } from "../../import/parser-options";
import { parseArgs } from "../main";
import { importCommand, importFromContent } from "./import";

const { seen, withOptions, withoutOptions } = vi.hoisted(() => {
  const seen: unknown[] = [];
  const parser = {
    parse: () => ({ resources: [], parameters: [], warnings: ["parsed"] }),
  };
  const generator = { generate: () => [{ path: "x.ts", content: "export {};\n" }] };
  const withOptions = {
    name: "with-options",
    detectTemplate: (d: unknown) => typeof d === "object" && d !== null && "marker" in d,
    parserOptions: () => [
      { name: "flag", type: "boolean", description: "a switch" },
      { name: "level", type: "number", description: "a number" },
      { name: "label", type: "string", description: "a string" },
    ],
    templateParser: (options?: ParserOptions) => {
      seen.push(options);
      return parser;
    },
    templateGenerator: () => generator,
  } as unknown as LexiconPlugin;
  const withoutOptions = {
    name: "without-options",
    templateParser: () => parser,
    templateGenerator: () => generator,
  } as unknown as LexiconPlugin;
  return { seen, withOptions, withoutOptions };
});

vi.mock("../plugins", () => ({
  resolveProjectLexicons: async () => ["with-options"],
  loadPlugins: async (names: string[]) => names.map((n) => (n === "without-options" ? withoutOptions : withOptions)),
}));

describe("resolveParserOptions (#2994)", () => {
  const specs = withOptions as Pick<LexiconPlugin, "name" | "parserOptions">;

  test("no entries is an empty record", () => {
    expect(resolveParserOptions(specs, undefined)).toEqual({ options: {} });
  });

  test("converts to the declared types; a bare boolean is true", () => {
    expect(resolveParserOptions(specs, ["flag", "level=3", "label=a=b"])).toEqual({
      options: { flag: true, level: 3, label: "a=b" },
    });
    expect(resolveParserOptions(specs, ["flag=false"])).toEqual({ options: { flag: false } });
  });

  test("refuses an unknown name and lists what the lexicon accepts", () => {
    const r = resolveParserOptions(specs, ["nope"]);
    expect(r).toMatchObject({ error: expect.stringContaining('Unknown parser option "nope" for lexicon "with-options"') });
    expect((r as { error: string }).error).toContain("flag (boolean): a switch");
  });

  test("a lexicon with no options says so", () => {
    const r = resolveParserOptions({ name: "plain" }, ["x"]);
    expect((r as { error: string }).error).toBe('Unknown parser option "x" for lexicon "plain"; lexicon "plain" declares no parser options.');
  });

  test("refuses a bad value", () => {
    expect(resolveParserOptions(specs, ["flag=maybe"])).toHaveProperty("error");
    expect(resolveParserOptions(specs, ["level=abc"])).toHaveProperty("error");
    expect(resolveParserOptions(specs, ["level"])).toHaveProperty("error");
    expect(resolveParserOptions(specs, ["label"])).toHaveProperty("error");
  });
});

describe("chant import --parser-option (#2994)", () => {
  let dir: string;
  let templatePath: string;

  beforeEach(async () => {
    seen.length = 0;
    dir = join(tmpdir(), `chant-import-parser-options-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
    templatePath = join(dir, "t.json");
    await writeFile(templatePath, JSON.stringify({ marker: true }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the flag is parsed, repeatable", () => {
    const args = parseArgs(["import", "t.json", "--lexicon", "x", "--parser-option", "a", "--parser-option", "b=1"]);
    expect(args.parserOption).toEqual(["a", "b=1"]);
  });

  test("--lexicon: the parser receives the typed options", async () => {
    const result = await importCommand({
      templatePath, output: join(dir, "out"), lexicon: "with-options", parserOptions: ["flag", "level=2"],
    });
    expect(result.success).toBe(true);
    expect(seen).toEqual([{ flag: true, level: 2 }]);
  });

  test("detection: the options go to the detected lexicon", async () => {
    const result = await importCommand({ templatePath, output: join(dir, "out"), parserOptions: ["label=x"] });
    expect(result.success).toBe(true);
    expect(seen).toEqual([{ label: "x" }]);
  });

  test("no options: the parser gets an empty record", async () => {
    await importCommand({ templatePath, output: join(dir, "out"), lexicon: "with-options" });
    expect(seen).toEqual([{}]);
  });

  test("an unknown option is refused before parsing", async () => {
    const result = await importCommand({
      templatePath, output: join(dir, "out"), lexicon: "with-options", parserOptions: ["bogus"],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown parser option "bogus"');
    expect(seen).toEqual([]);
  });

  test("content import refuses an option on a lexicon that declares none", async () => {
    const result = await importFromContent({
      content: "{}", lexicon: "without-options", output: join(dir, "out"), parserOptions: ["x"],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('lexicon "without-options" declares no parser options');
  });
});
