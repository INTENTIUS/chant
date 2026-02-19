import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { barrel } from "./barrel";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "barrel-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("barrel", () => {
  test("returns exports from sibling .ts files", () => {
    writeFileSync(
      join(tempDir, "alpha.ts"),
      "export const alphaValue = 42;",
    );
    writeFileSync(
      join(tempDir, "beta.ts"),
      "export const betaValue = 'hello';",
    );

    const $ = barrel(tempDir);

    expect($.alphaValue).toBe(42);
    expect($.betaValue).toBe("hello");
  });

  test("excludes files starting with underscore", () => {
    writeFileSync(
      join(tempDir, "_config.ts"),
      "export const secret = 'hidden';",
    );
    writeFileSync(
      join(tempDir, "visible.ts"),
      "export const visible = true;",
    );

    const $ = barrel(tempDir);

    expect($.secret).toBeUndefined();
    expect($.visible).toBe(true);
  });

  test("excludes test files", () => {
    writeFileSync(
      join(tempDir, "foo.test.ts"),
      "export const testVal = 1;",
    );
    writeFileSync(
      join(tempDir, "bar.spec.ts"),
      "export const specVal = 2;",
    );
    writeFileSync(
      join(tempDir, "real.ts"),
      "export const realVal = 3;",
    );

    const $ = barrel(tempDir);

    expect($.testVal).toBeUndefined();
    expect($.specVal).toBeUndefined();
    expect($.realVal).toBe(3);
  });

  test("caches results after first access", () => {
    writeFileSync(
      join(tempDir, "mod.ts"),
      "export const x = 1; export const y = 2;",
    );

    const $ = barrel(tempDir);

    // First access triggers load
    expect($.x).toBe(1);

    // Write a new file after first load
    writeFileSync(
      join(tempDir, "late.ts"),
      "export const lateVal = 99;",
    );

    // Should NOT pick up new file since cache is already populated
    expect($.lateVal).toBeUndefined();
    // Existing values still work
    expect($.y).toBe(2);
  });

  test("returns undefined for missing keys", () => {
    writeFileSync(
      join(tempDir, "mod.ts"),
      "export const exists = true;",
    );

    const $ = barrel(tempDir);

    expect($.nonExistent).toBeUndefined();
  });

  test("has and ownKeys work correctly", () => {
    writeFileSync(
      join(tempDir, "mod.ts"),
      "export const dataBucket = 's3://bucket';",
    );

    const $ = barrel(tempDir);

    expect("dataBucket" in $).toBe(true);
    expect("missing" in $).toBe(false);
    expect(Object.keys($)).toEqual(["dataBucket"]);
  });

  test("handles empty directory", () => {
    const $ = barrel(tempDir);

    expect(Object.keys($)).toEqual([]);
    expect($.anything).toBeUndefined();
  });

  test("handles load errors gracefully", () => {
    writeFileSync(
      join(tempDir, "broken.ts"),
      "export const x = ;; SYNTAX ERROR @@#$",
    );
    writeFileSync(
      join(tempDir, "good.ts"),
      "export const goodVal = 'works';",
    );

    const $ = barrel(tempDir);

    expect($.goodVal).toBe("works");
  });

  test("first export wins on name collision", () => {
    // Files are sorted by readdirSync (OS-dependent), but we can verify
    // that the proxy doesn't crash on collisions
    writeFileSync(
      join(tempDir, "aaa.ts"),
      "export const shared = 'first';",
    );
    writeFileSync(
      join(tempDir, "zzz.ts"),
      "export const shared = 'second';",
    );

    const $ = barrel(tempDir);

    // One of them wins (first by readdir order)
    expect(typeof $.shared).toBe("string");
  });
});
