import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import { IMPORTED_SOURCE_HEADER, isImportedSource, markImportedSource } from "./imported-source";

const parse = (code: string) => ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true);

describe("imported source marker", () => {
  test("marks a TypeScript file once", () => {
    const once = markImportedSource("main.ts", "export const a = 1;\n");
    expect(once.startsWith(IMPORTED_SOURCE_HEADER)).toBe(true);
    expect(markImportedSource("main.ts", once)).toBe(once);
    expect(isImportedSource(parse(once))).toBe(true);
  });

  test("leaves other file types alone", () => {
    expect(markImportedSource("package.json", "{}")).toBe("{}");
  });

  test("an unmarked file is not imported", () => {
    expect(isImportedSource(parse("export const a = 1;\n"))).toBe(false);
  });
});
