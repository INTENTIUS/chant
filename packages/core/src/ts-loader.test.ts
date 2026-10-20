import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { chantSourceDir, ensureTypeScriptLoader, ensureTypeScriptLoaderFor, typeScriptLoaderPending } from "./ts-loader";

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
