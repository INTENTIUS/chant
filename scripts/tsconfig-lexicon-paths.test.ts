import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffPaths, generatePaths, lexiconEntries, lexiconNames } from "./tsconfig-lexicon-paths";

const ROOT = join(import.meta.dirname, "..");

describe("root tsconfig.json lexicon paths (#2376)", () => {
  test("has an entry pair for every lexicon directory and none for a removed one", () => {
    const paths = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf-8")).compilerOptions.paths;
    expect(diffPaths(paths, lexiconNames(ROOT)), "run `npm run generate:tsconfig-paths`").toEqual({ missing: [], stale: [] });
  });
});

describe("diffPaths", () => {
  const core = { "@intentius/chant": ["./packages/core/src/index.ts"] };

  test("reports a lexicon directory with no entry", () => {
    const paths = { ...core, ...lexiconEntries("aws") };
    expect(diffPaths(paths, ["aws", "e2b"])).toEqual({
      missing: ["@intentius/chant-lexicon-e2b", "@intentius/chant-lexicon-e2b/*"],
      stale: [],
    });
  });

  test("reports an entry whose lexicon directory is gone", () => {
    const paths = { ...core, ...lexiconEntries("aws"), ...lexiconEntries("augur") };
    expect(diffPaths(paths, ["aws"])).toEqual({
      missing: [],
      stale: ["@intentius/chant-lexicon-augur", "@intentius/chant-lexicon-augur/*"],
    });
  });

  test("reports an entry that points at the wrong place", () => {
    const paths = { ...core, ...lexiconEntries("aws"), "@intentius/chant-lexicon-aws/*": ["./lexicons/aws/*"] };
    expect(diffPaths(paths, ["aws"])).toEqual({
      missing: ["@intentius/chant-lexicon-aws/*"],
      stale: ["@intentius/chant-lexicon-aws/*"],
    });
  });

  test("generatePaths keeps non-lexicon entries and sorts lexicons by name", () => {
    const out = generatePaths({ ...core, ...lexiconEntries("zeta"), "@x/y": ["./y"] }, ["beta", "alpha"]);
    expect(Object.keys(out)).toEqual([
      "@intentius/chant",
      "@x/y",
      "@intentius/chant-lexicon-alpha",
      "@intentius/chant-lexicon-alpha/*",
      "@intentius/chant-lexicon-beta",
      "@intentius/chant-lexicon-beta/*",
    ]);
  });
});
