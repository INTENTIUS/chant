import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { isJavaScriptModule, isTypeScriptModule, moduleSourceDir, moduleSourceUrl } from "./module-source";

describe("module-source (#3981)", () => {
  const pkg = join(sep, "x", "node_modules", "@intentius", "chant-lexicon-aws");

  test("moduleSourceDir maps a compiled module's directory to the source directory", () => {
    expect(moduleSourceDir(pathToFileURL(join(pkg, "dist", "lint", "post-synth", "ext001.js")).href)).toBe(join(pkg, "src", "lint", "post-synth"));
    expect(moduleSourceDir(pathToFileURL(join(pkg, "dist", "taggable.js")).href)).toBe(join(pkg, "src"));
  });

  test("moduleSourceDir leaves a source module's directory alone, even under a dist/ directory", () => {
    expect(moduleSourceDir(pathToFileURL(join(pkg, "src", "taggable.ts")).href)).toBe(join(pkg, "src"));
    const checkout = join(sep, "home", "dist", "chant", "lexicons", "aws", "src", "taggable.ts");
    expect(moduleSourceDir(pathToFileURL(checkout).href)).toBe(join(sep, "home", "dist", "chant", "lexicons", "aws", "src"));
  });

  test("moduleSourceUrl is a URL in the source directory, for createRequire", () => {
    const url = moduleSourceUrl(pathToFileURL(join(pkg, "dist", "lsp", "hover.js")).href);
    expect(url).toBe(pathToFileURL(join(pkg, "src", "lsp", "hover.js")).href);
    expect(new URL("../generated/lexicon-aws.json", url).href).toBe(pathToFileURL(join(pkg, "src", "generated", "lexicon-aws.json")).href);
  });

  test("isTypeScriptModule and isJavaScriptModule", () => {
    expect(isTypeScriptModule("/p/src/index.ts")).toBe(true);
    expect(isTypeScriptModule("file:///p/src/index.mts?x=1")).toBe(true);
    expect(isTypeScriptModule("/p/dist/index.d.ts")).toBe(false);
    expect(isTypeScriptModule("/p/dist/index.js")).toBe(false);
    expect(isJavaScriptModule("file:///p/dist/index.js")).toBe(true);
    expect(isJavaScriptModule("/p/dist/index.mjs")).toBe(true);
    expect(isJavaScriptModule("/p/src/index.ts")).toBe(false);
    // No extension: only tsx's resolver completes it, so it is not plain JavaScript.
    expect(isJavaScriptModule("/p/lexicon/index")).toBe(false);
  });
});

describe("package sources run under plain node ESM (#3981)", () => {
  const repo = resolve(import.meta.dirname, "..", "..", "..");
  const SKIP_DIRS = new Set(["node_modules", "generated", "testdata", "fixtures", "__fixtures__", "test-fixtures"]);

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) sources(join(dir, entry.name), out);
      } else if (/\.ts$/.test(entry.name) && !/\.(test|d)\.ts$/.test(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
    return out;
  }

  test("no lexicon or package source uses the CommonJS __dirname or __filename", () => {
    // Both are undefined in an ES module under plain node, and under tsx too: a
    // read built on one throws, and the catch around it hides the data.
    // moduleSourceDir(import.meta.url) names the source directory from src/ and dist/ alike.
    const roots = ["lexicons", "packages"].flatMap((top) =>
      readdirSync(join(repo, top), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(repo, top, e.name, "src")),
    );
    const offenders: string[] = [];
    for (const root of roots) {
      let files: string[];
      try {
        files = sources(root);
      } catch {
        continue;
      }
      for (const file of files) {
        const code = readFileSync(file, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        code.split("\n").forEach((line, i) => {
          if (/\b__(?:dirname|filename)\b/.test(line)) offenders.push(`${relative(repo, file)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
