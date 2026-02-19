import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { preferNamespaceImportRule } from "./prefer-namespace-import";
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

describe("COR006: prefer-namespace-import", () => {
  test("rule metadata", () => {
    expect(preferNamespaceImportRule.id).toBe("COR006");
    expect(preferNamespaceImportRule.severity).toBe("error");
    expect(preferNamespaceImportRule.category).toBe("style");
  });

  test("flags named import from @intentius/chant* package", () => {
    const code = `import { Bucket } from "@intentius/chant-lexicon-testdom";`;
    const context = createContext(code);
    const diagnostics = preferNamespaceImportRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe("COR006");
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].message).toBe(
      `Use namespace import for @intentius/chant-lexicon-testdom — replace with: import * as testdom from "@intentius/chant-lexicon-testdom"`
    );
  });

  test("allows namespace import from @intentius/chant* package", () => {
    const code = `import * as testdom from "@intentius/chant-lexicon-testdom";`;
    const context = createContext(code);
    const diagnostics = preferNamespaceImportRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("allows type-only import from @intentius/chant* package", () => {
    const code = `import type { Declarable } from "@intentius/chant";`;
    const context = createContext(code);
    const diagnostics = preferNamespaceImportRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("does not flag imports from non-@intentius/chant packages", () => {
    const code = `import { useState } from "react";`;
    const context = createContext(code);
    const diagnostics = preferNamespaceImportRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("does not flag imports from relative paths", () => {
    const code = `import { helper } from "./utils";`;
    const context = createContext(code);
    const diagnostics = preferNamespaceImportRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("derives alias from package name", () => {
    const code = `import { Config } from "@intentius/chant";`;
    const context = createContext(code);
    const diagnostics = preferNamespaceImportRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("import * as core");
  });

  test("flags multiple named imports from different @intentius/chant packages", () => {
    const code = `
import { Bucket } from "@intentius/chant-lexicon-testdom";
import { Config } from "@intentius/chant";
`;
    const context = createContext(code);
    const diagnostics = preferNamespaceImportRule.check(context);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].message).toContain("@intentius/chant-lexicon-testdom");
    expect(diagnostics[1].message).toContain("@intentius/chant");
  });

  test("reports correct line and column numbers", () => {
    const code = `import { Bucket } from "@intentius/chant-lexicon-testdom";`;
    const context = createContext(code);
    const diagnostics = preferNamespaceImportRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].line).toBe(1);
    expect(diagnostics[0].column).toBe(1);
    expect(diagnostics[0].file).toBe("test.ts");
  });
});
