import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { chantSourceDir, ensureTypeScriptLoader } from "./ts-loader";

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
});
