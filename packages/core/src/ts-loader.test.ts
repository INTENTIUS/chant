import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { chantPackageSourceTarget, chantSourceDir, lexiconCompiledTwin, ensureTypeScriptLoader, ensureTypeScriptLoaderFor, typeScriptLoaderPending } from "./ts-loader";

describe("ts-loader (#3878)", () => {
  const pkg = join(sep, "x", "node_modules", "@intentius", "chant");

  test("chantSourceDir maps a compiled module's directory to its source directory", () => {
    const url = pathToFileURL(join(pkg, "dist", "discovery", "sandbox", "driver.js")).href;
    expect(chantSourceDir(url)).toBe(join(pkg, "src", "discovery", "sandbox"));
    expect(chantSourceDir(pathToFileURL(join(pkg, "dist", "params.js")).href)).toBe(join(pkg, "src"));
  });

  test("chantSourceDir leaves a source module's directory alone", () => {
    const url = pathToFileURL(join(pkg, "src", "discovery", "sandbox", "driver.ts")).href;
    expect(chantSourceDir(url)).toBe(join(pkg, "src", "discovery", "sandbox"));
  });

  test("from source, the TypeScript loader is already there and nothing is registered", () => {
    expect(ensureTypeScriptLoader()).toBe(false);
  });

  test("from source, no module asks for the loader (#3981)", () => {
    expect(typeScriptLoaderPending()).toBe(false);
    expect(ensureTypeScriptLoaderFor("/p/src/index.ts")).toBe(false);
    expect(ensureTypeScriptLoaderFor("/p/dist/index.js")).toBe(false);
  });

  test("compiled, a JavaScript module leaves tsx unregistered (#3981)", () => {
    const STATE = Symbol.for("chant.compiledCli");
    const global = globalThis as { [STATE]?: { tsx: boolean } };
    global[STATE] = { tsx: false };
    try {
      expect(typeScriptLoaderPending()).toBe(true);
      expect(ensureTypeScriptLoaderFor("file:///p/dist/index.js")).toBe(false);
      expect(ensureTypeScriptLoaderFor("/p/dist/meta.json")).toBe(false);
      expect(global[STATE]).toEqual({ tsx: false });
      global[STATE] = { tsx: true };
      expect(typeScriptLoaderPending()).toBe(false);
      expect(ensureTypeScriptLoaderFor("/p/src/index.ts")).toBe(true);
    } finally {
      delete global[STATE];
    }
  });
});

describe("chantPackageSourceTarget (#3981)", () => {
  test("resolves a symlinked lexicon's root and pattern exports to their development source, by real path", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-source-target-")));
    try {
      const lexicon = join(root, "lexicons", "demo");
      mkdirSync(join(lexicon, "src", "generated"), { recursive: true });
      writeFileSync(join(lexicon, "src", "index.ts"), "");
      writeFileSync(join(lexicon, "src", "generated", "index.ts"), "");
      writeFileSync(
        join(lexicon, "package.json"),
        JSON.stringify({
          name: "@intentius/chant-lexicon-demo",
          exports: {
            ".": { development: "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" },
            "./*": { development: "./src/*.ts", types: "./dist/*.d.ts", default: "./dist/*.js" },
            "./meta": "./dist/meta.json",
          },
        }),
      );
      mkdirSync(join(root, "project", "node_modules", "@intentius"), { recursive: true });
      symlinkSync(lexicon, join(root, "project", "node_modules", "@intentius", "chant-lexicon-demo"), "dir");
      mkdirSync(join(root, "project", "src"));
      const parent = join(root, "project", "src", "infra.ts");

      expect(chantPackageSourceTarget("@intentius/chant-lexicon-demo", parent)).toBe(join(lexicon, "src", "index.ts"));
      expect(chantPackageSourceTarget("@intentius/chant-lexicon-demo/generated/index", parent)).toBe(join(lexicon, "src", "generated", "index.ts"));
      // No development condition, a missing file, another scope or an absent package: left to Node.
      expect(chantPackageSourceTarget("@intentius/chant-lexicon-demo/meta", parent)).toBeUndefined();
      expect(chantPackageSourceTarget("@intentius/chant-lexicon-demo/missing", parent)).toBeUndefined();
      expect(chantPackageSourceTarget("@other/chant-lexicon-demo", parent)).toBeUndefined();
      expect(chantPackageSourceTarget("@intentius/chant-lexicon-absent", parent)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("lexiconCompiledTwin (#3981)", () => {
  test("points a lexicon's src/*.ts at its dist/*.js when that exists, and nothing else", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-compiled-twin-")));
    try {
      const lexicon = join(root, "node_modules", "@intentius", "chant-lexicon-demo");
      const other = join(root, "node_modules", "other");
      for (const dir of [join(lexicon, "src", "generated"), join(lexicon, "dist", "generated"), join(other, "src"), join(other, "dist")]) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(join(lexicon, "package.json"), JSON.stringify({ name: "@intentius/chant-lexicon-demo" }));
      writeFileSync(join(other, "package.json"), JSON.stringify({ name: "other" }));
      for (const file of ["src/generated/index.ts", "dist/generated/index.js", "src/only-source.ts"]) writeFileSync(join(lexicon, file), "");
      for (const file of ["src/index.ts", "dist/index.js"]) writeFileSync(join(other, file), "");
      const url = (path: string) => pathToFileURL(path).href;

      expect(lexiconCompiledTwin(url(join(lexicon, "src", "generated", "index.ts")))).toBe(url(join(lexicon, "dist", "generated", "index.js")));
      expect(lexiconCompiledTwin(url(join(lexicon, "src", "only-source.ts")))).toBeUndefined();
      expect(lexiconCompiledTwin(url(join(lexicon, "dist", "generated", "index.js")))).toBeUndefined();
      expect(lexiconCompiledTwin(url(join(other, "src", "index.ts")))).toBeUndefined();
      expect(lexiconCompiledTwin("node:fs")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
