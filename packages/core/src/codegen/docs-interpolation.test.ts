import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { expandFileMarkers } from "./docs";

describe("expandFileMarkers", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "docs-interp-"));
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(
      join(dir, "example.ts"),
      'import * as _ from "./_";\n\nexport const bucket = new _.Bucket({\n  bucketName: "test",\n});\n',
    );
    writeFileSync(
      join(dir, "sub", "nested.ts"),
      "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n",
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("expands full file marker", () => {
    const result = expandFileMarkers("Before\n\n{{file:example.ts}}\n\nAfter", dir);
    expect(result).toContain('```typescript title="example.ts"');
    expect(result).toContain('import * as _ from "./_";');
    expect(result).toContain("```");
    expect(result).toStartWith("Before\n\n");
    expect(result).toEndWith("\n\nAfter");
  });

  test("expands line range", () => {
    const result = expandFileMarkers("{{file:sub/nested.ts:3-5}}", dir);
    expect(result).toContain('```typescript title="nested.ts"');
    expect(result).toContain("line3\nline4\nline5");
    expect(result).not.toContain("line2");
    expect(result).not.toContain("line6");
  });

  test("supports title override", () => {
    const result = expandFileMarkers("{{file:example.ts|title=my-file.ts}}", dir);
    expect(result).toContain('```typescript title="my-file.ts"');
  });

  test("supports line range with title override", () => {
    const result = expandFileMarkers(
      "{{file:sub/nested.ts:2-4|title=snippet.ts}}",
      dir,
    );
    expect(result).toContain('```typescript title="snippet.ts"');
    expect(result).toContain("line2\nline3\nline4");
  });

  test("throws on missing file", () => {
    expect(() => expandFileMarkers("{{file:nope.ts}}", dir)).toThrow(
      /file not found/,
    );
  });

  test("leaves content without markers unchanged", () => {
    const input = "No markers here\n\n```typescript\ncode\n```\n";
    expect(expandFileMarkers(input, dir)).toBe(input);
  });

  test("expands multiple markers", () => {
    const result = expandFileMarkers(
      "{{file:example.ts}}\n\n{{file:sub/nested.ts:1-2}}",
      dir,
    );
    expect(result).toContain('title="example.ts"');
    expect(result).toContain('title="nested.ts"');
  });
});
