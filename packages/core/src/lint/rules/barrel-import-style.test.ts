import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { barrelImportStyleRule } from "./barrel-import-style";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    true
  );

  return {
    sourceFile,
    entities: [],
    filePath,
    lexicon: undefined,
  };
}

describe("COR002: barrel-import-style", () => {
  test("rule metadata", () => {
    expect(barrelImportStyleRule.id).toBe("COR002");
    expect(barrelImportStyleRule.severity).toBe("error");
    expect(barrelImportStyleRule.category).toBe("style");
  });

  test("flags named import from ./_", () => {
    const code = `import { bucketEncryption } from "./_";`;
    const context = createContext(code);
    const diagnostics = barrelImportStyleRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe("COR002");
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].message).toBe(
      `Use namespace import for local barrel — replace with: import * as _ from "./_"`
    );
  });

  test("allows namespace import from ./_", () => {
    const code = `import * as _ from "./_";`;
    const context = createContext(code);
    const diagnostics = barrelImportStyleRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("allows type-only import from ./_", () => {
    const code = `import type { Config } from "./_";`;
    const context = createContext(code);
    const diagnostics = barrelImportStyleRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("does not flag imports from other relative paths", () => {
    const code = `import { helper } from "./utils";`;
    const context = createContext(code);
    const diagnostics = barrelImportStyleRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("does not flag imports from packages", () => {
    const code = `import { useState } from "react";`;
    const context = createContext(code);
    const diagnostics = barrelImportStyleRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("reports correct line and column numbers", () => {
    const code = `import { foo } from "./_";`;
    const context = createContext(code);
    const diagnostics = barrelImportStyleRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].line).toBe(1);
    expect(diagnostics[0].column).toBe(1);
    expect(diagnostics[0].file).toBe("test.ts");
  });
});
