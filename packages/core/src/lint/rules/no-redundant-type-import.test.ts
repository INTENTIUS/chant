import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { noRedundantTypeImportRule } from "./no-redundant-type-import";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("COR012: no-redundant-type-import", () => {
  test("rule metadata", () => {
    expect(noRedundantTypeImportRule.id).toBe("COR012");
    expect(noRedundantTypeImportRule.severity).toBe("warning");
    expect(noRedundantTypeImportRule.category).toBe("style");
  });

  test("flags redundant type import alongside namespace import", () => {
    const ctx = createContext(
      `import * as td from "@intentius/chant-lexicon-testdom";\nimport type { PolicyDocument } from "@intentius/chant-lexicon-testdom";`
    );
    const diags = noRedundantTypeImportRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR012");
    expect(diags[0].message).toContain("td.PolicyDocument");
    expect(diags[0].message).toContain("Redundant type import");
  });

  test("flags multiple type names in one import", () => {
    const ctx = createContext(
      `import * as td from "@intentius/chant-lexicon-testdom";\nimport type { PolicyDocument, Code, Environment } from "@intentius/chant-lexicon-testdom";`
    );
    const diags = noRedundantTypeImportRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("td.PolicyDocument");
    expect(diags[0].message).toContain("td.Code");
    expect(diags[0].message).toContain("td.Environment");
  });

  test("OK: type import alone without namespace import", () => {
    const ctx = createContext(
      `import type { PolicyDocument } from "@intentius/chant-lexicon-testdom";`
    );
    const diags = noRedundantTypeImportRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("OK: namespace import alone without type import", () => {
    const ctx = createContext(`import * as td from "@intentius/chant-lexicon-testdom";`);
    const diags = noRedundantTypeImportRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("OK: type import from non-@intentius/chant package", () => {
    const ctx = createContext(
      `import * as td from "@intentius/chant-lexicon-testdom";\nimport type { Foo } from "some-other-package";`
    );
    const diags = noRedundantTypeImportRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("OK: type import from different @intentius/chant package than namespace", () => {
    const ctx = createContext(
      `import * as td from "@intentius/chant-lexicon-testdom";\nimport type { Foo } from "@intentius/chant";`
    );
    const diags = noRedundantTypeImportRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("flags both when two packages each have namespace + type imports", () => {
    const ctx = createContext(
      [
        `import * as td from "@intentius/chant-lexicon-testdom";`,
        `import * as core from "@intentius/chant";`,
        `import type { PolicyDocument } from "@intentius/chant-lexicon-testdom";`,
        `import type { Entity } from "@intentius/chant";`,
      ].join("\n")
    );
    const diags = noRedundantTypeImportRule.check(ctx);
    expect(diags).toHaveLength(2);
    expect(diags[0].message).toContain("td.PolicyDocument");
    expect(diags[1].message).toContain("core.Entity");

  });

  test("message includes namespace alias and type names", () => {
    const ctx = createContext(
      `import * as myAlias from "@intentius/chant-lexicon-testdom";\nimport type { SomeType } from "@intentius/chant-lexicon-testdom";`
    );
    const diags = noRedundantTypeImportRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("myAlias.SomeType");
  });

  test("fix range covers the import line", () => {
    const code = `import * as td from "@intentius/chant-lexicon-testdom";\nimport type { PolicyDocument } from "@intentius/chant-lexicon-testdom";\n`;
    const ctx = createContext(code);
    const diags = noRedundantTypeImportRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].fix).toBeDefined();
    const fix = diags[0].fix!;
    expect(fix.replacement).toBe("");
    // Fix should cover the type import line
    const removed = code.slice(fix.range[0], fix.range[1]);
    expect(removed).toContain("import type");
    expect(removed).toContain("PolicyDocument");
    // Should not remove the namespace import
    expect(removed).not.toContain("import * as aws");
  });

  test("does not flag non-type-only named imports", () => {
    const ctx = createContext(
      `import * as td from "@intentius/chant-lexicon-testdom";\nimport { PolicyDocument } from "@intentius/chant-lexicon-testdom";`
    );
    const diags = noRedundantTypeImportRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("diagnostic has correct line and column", () => {
    const ctx = createContext(
      `import * as td from "@intentius/chant-lexicon-testdom";\nimport type { PolicyDocument } from "@intentius/chant-lexicon-testdom";`
    );
    const diags = noRedundantTypeImportRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(2);
    expect(diags[0].column).toBeGreaterThan(0);
    expect(diags[0].file).toBe("test.ts");
  });
});
