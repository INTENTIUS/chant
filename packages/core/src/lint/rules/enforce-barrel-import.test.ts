import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import * as ts from "typescript";
import { enforceBarrelImportRule } from "./enforce-barrel-import";
import type { LintContext } from "../rule";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, "__test_barrel_import__");

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

describe("COR014: enforce-barrel-import", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("rule metadata", () => {
    expect(enforceBarrelImportRule.id).toBe("COR014");
    expect(enforceBarrelImportRule.severity).toBe("warning");
    expect(enforceBarrelImportRule.category).toBe("style");
  });

  test("flags lexicon import in non-barrel file", () => {
    const code = `import * as td from "@intentius/chant-lexicon-testdom";`;
    const context = createContext(code, join(TEST_DIR, "my-stack.ts"));
    const diagnostics = enforceBarrelImportRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe("COR014");
    expect(diagnostics[0].severity).toBe("warning");
  });

  test("skips barrel file named _.ts", () => {
    const code = `import * as td from "@intentius/chant-lexicon-testdom";`;
    const context = createContext(code, join(TEST_DIR, "_.ts"));
    const diagnostics = enforceBarrelImportRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("skips barrel file with path prefix", () => {
    const code = `import * as td from "@intentius/chant-lexicon-testdom";`;
    const context = createContext(code, join(TEST_DIR, "infra", "_.ts"));
    const diagnostics = enforceBarrelImportRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("allows barrel import", () => {
    const code = `import * as _ from "./_";`;
    const context = createContext(code, join(TEST_DIR, "my-stack.ts"));
    const diagnostics = enforceBarrelImportRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("allows non-chant imports", () => {
    const code = `import * as ts from "typescript";`;
    const context = createContext(code, join(TEST_DIR, "my-stack.ts"));
    const diagnostics = enforceBarrelImportRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("message includes barrel content when barrel missing", () => {
    const code = `import * as td from "@intentius/chant-lexicon-testdom";`;
    const filePath = join(TEST_DIR, "my-stack.ts");
    const context = createContext(code, filePath);
    const diagnostics = enforceBarrelImportRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("Create _.ts");
    expect(diagnostics[0].message).toContain(`export * from "@intentius/chant-lexicon-testdom"`);
    expect(diagnostics[0].message).toContain("barrel");
  });

  test("message is shorter when barrel exists", () => {
    // Create a barrel file in TEST_DIR
    writeFileSync(join(TEST_DIR, "_.ts"), `export * from "@intentius/chant-lexicon-testdom";`);

    const code = `import * as td from "@intentius/chant-lexicon-testdom";`;
    const filePath = join(TEST_DIR, "my-stack.ts");
    const context = createContext(code, filePath);
    const diagnostics = enforceBarrelImportRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).not.toContain("Create _.ts");
    expect(diagnostics[0].message).toContain("use the barrel");
  });

  test("provides auto-fix when barrel exists", () => {
    writeFileSync(join(TEST_DIR, "_.ts"), `export * from "@intentius/chant-lexicon-testdom";`);

    const code = `import * as td from "@intentius/chant-lexicon-testdom";`;
    const context = createContext(code, join(TEST_DIR, "my-stack.ts"));
    const diagnostics = enforceBarrelImportRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].fix).toBeDefined();
    expect(diagnostics[0].fix!.replacement).toBe(`import * as _ from "./_"`);
  });

  test("does not provide auto-fix when barrel is missing", () => {
    const code = `import * as td from "@intentius/chant-lexicon-testdom";`;
    const context = createContext(code, join(TEST_DIR, "my-stack.ts"));
    const diagnostics = enforceBarrelImportRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].fix).toBeUndefined();
  });

  test("flags type-only lexicon import", () => {
    const code = `import type { Code } from "@intentius/chant-lexicon-testdom";`;
    const context = createContext(code, join(TEST_DIR, "my-stack.ts"));
    const diagnostics = enforceBarrelImportRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe("COR014");
  });

  test("skips subpath imports from core", () => {
    const code = `import type { LintRule } from "@intentius/chant/lint/rule";`;
    const context = createContext(code, join(TEST_DIR, "my-rule.ts"));
    const diagnostics = enforceBarrelImportRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("skips deep subpath imports from lexicon", () => {
    const code = `import { helper } from "@intentius/chant-lexicon-aws/internal/util";`;
    const context = createContext(code, join(TEST_DIR, "my-stack.ts"));
    const diagnostics = enforceBarrelImportRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("flags multiple lexicon imports", () => {
    const code = `import * as td from "@intentius/chant-lexicon-testdom";
import * as core from "@intentius/chant";`;
    const context = createContext(code, join(TEST_DIR, "my-stack.ts"));
    const diagnostics = enforceBarrelImportRule.check(context);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].message).toContain("@intentius/chant-lexicon-testdom");
    expect(diagnostics[1].message).toContain("@intentius/chant");
  });

  test("reports correct line and column numbers", () => {
    const code = `import * as td from "@intentius/chant-lexicon-testdom";`;
    const context = createContext(code, join(TEST_DIR, "my-stack.ts"));
    const diagnostics = enforceBarrelImportRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].line).toBe(1);
    expect(diagnostics[0].column).toBe(1);
  });
});
