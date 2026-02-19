import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { noUnusedDeclarableImportRule } from "./no-unused-declarable-import";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("COR010: no-unused-declarable-import", () => {
  test("rule metadata", () => {
    expect(noUnusedDeclarableImportRule.id).toBe("COR010");
    expect(noUnusedDeclarableImportRule.severity).toBe("warning");
    expect(noUnusedDeclarableImportRule.category).toBe("style");
  });

  test("triggers on unused namespace import", () => {
    const ctx = createContext(`import * as td from "@intentius/chant-lexicon-testdom";\nexport const x = 1;`);
    const diags = noUnusedDeclarableImportRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR010");
    expect(diags[0].message).toContain("td");
  });

  test("does not trigger when namespace is used as property access", () => {
    const ctx = createContext(
      `import * as td from "@intentius/chant-lexicon-testdom";\nexport const b = new td.Bucket({});`,
    );
    const diags = noUnusedDeclarableImportRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not trigger on type-only imports", () => {
    const ctx = createContext(
      `import type * as core from "@intentius/chant";\nexport const x = 1;`,
    );
    const diags = noUnusedDeclarableImportRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not trigger on non-chant imports", () => {
    const ctx = createContext(`import * as ts from "typescript";\nexport const x = 1;`);
    const diags = noUnusedDeclarableImportRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not trigger on named imports (those are COR006)", () => {
    const ctx = createContext(`import { Bucket } from "@intentius/chant-lexicon-testdom";\nexport const x = 1;`);
    const diags = noUnusedDeclarableImportRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("handles multiple namespace imports", () => {
    const ctx = createContext(
      `import * as td from "@intentius/chant-lexicon-testdom";\n` +
        `import * as core from "@intentius/chant";\n` +
        `export const b = new td.Bucket({});`,
    );
    const diags = noUnusedDeclarableImportRule.check(ctx);
    // aws is used, core is not
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("core");
  });

  test("detects usage in type positions (qualified names)", () => {
    const ctx = createContext(
      `import * as core from "@intentius/chant";\n` +
        `const x: core.Value<string> = "hello";`,
    );
    const diags = noUnusedDeclarableImportRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
