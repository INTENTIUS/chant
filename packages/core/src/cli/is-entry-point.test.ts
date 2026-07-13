import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { isEntryPoint } from "./is-entry-point";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

describe("isEntryPoint", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chant-entry-"));
    writeFileSync(join(dir, "cli.ts"), "");
    writeFileSync(join(dir, "marker"), "");
    symlinkSync(join(dir, "cli.ts"), join(dir, "cli-link.ts"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("true when argv1 and import.meta.url are the same real file", () => {
    const file = join(dir, "cli.ts");
    expect(isEntryPoint(file, pathToFileURL(file).href)).toBe(true);
  });

  test("true when argv1 is a symlink to the file import.meta.url resolves to", () => {
    // The regression: import.meta.url is the realpath (real cli.ts); argv1 is the
    // symlink (cli-link.ts). A raw string compare would be false; this must be true.
    const symlinkArg = join(dir, "cli-link.ts");
    const realUrl = pathToFileURL(join(dir, "cli.ts")).href;
    expect(symlinkArg).not.toBe(join(dir, "cli.ts"));
    expect(isEntryPoint(symlinkArg, realUrl)).toBe(true);
  });

  test("false for a different file (imported, not the entry point)", () => {
    const other = join(dir, "cli.ts");
    const importedUrl = pathToFileURL(join(dir, "marker")).href;
    expect(isEntryPoint(other, importedUrl)).toBe(false);
  });

  test("false when there is no argv1", () => {
    expect(isEntryPoint(undefined, pathToFileURL(join(dir, "cli.ts")).href)).toBe(false);
  });

  test("false (not a throw) when a path does not exist", () => {
    expect(isEntryPoint(join(dir, "gone.ts"), pathToFileURL(join(dir, "cli.ts")).href)).toBe(false);
  });
});
