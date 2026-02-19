import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { enforceBarrelRefRule } from "./enforce-barrel-ref";
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

describe("COR007: enforce-barrel-ref", () => {
  test("rule metadata", () => {
    expect(enforceBarrelRefRule.id).toBe("COR007");
    expect(enforceBarrelRefRule.severity).toBe("warning");
    expect(enforceBarrelRefRule.category).toBe("style");
  });

  test("flags named import from sibling", () => {
    const code = `import { dataBucket } from "./data-bucket";`;
    const context = createContext(code);
    const diagnostics = enforceBarrelRefRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe("COR007");
    expect(diagnostics[0].severity).toBe("warning");
  });

  test("flags namespace import from sibling", () => {
    const code = `import * as db from "./data-bucket";`;
    const context = createContext(code);
    const diagnostics = enforceBarrelRefRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe("COR007");
  });

  test("skips barrel import", () => {
    const code = `import * as _ from "./_";`;
    const context = createContext(code);
    const diagnostics = enforceBarrelRefRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("skips lexicon imports", () => {
    const code = `import * as td from "@intentius/chant-lexicon-testdom";`;
    const context = createContext(code);
    const diagnostics = enforceBarrelRefRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("skips barrel file", () => {
    const code = `import { dataBucket } from "./data-bucket";`;
    const context = createContext(code, "_.ts");
    const diagnostics = enforceBarrelRefRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("message includes suggestion with _.$ prefix", () => {
    const code = `import { dataBucket } from "./data-bucket";`;
    const context = createContext(code);
    const diagnostics = enforceBarrelRefRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("_.$.dataBucket");
  });

  test("flags multiple sibling imports", () => {
    const code = `import { dataBucket } from "./data-bucket";
import { logGroup } from "./log-group";`;
    const context = createContext(code);
    const diagnostics = enforceBarrelRefRule.check(context);

    expect(diagnostics).toHaveLength(2);
  });

  test("flags parent relative imports", () => {
    const code = `import { x } from "../other";`;
    const context = createContext(code);
    const diagnostics = enforceBarrelRefRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe("COR007");
  });

  test("does not provide auto-fix", () => {
    const code = `import { dataBucket } from "./data-bucket";`;
    const context = createContext(code);
    const diagnostics = enforceBarrelRefRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].fix).toBeUndefined();
  });

  test("reports correct line and column numbers", () => {
    const code = `import { dataBucket } from "./data-bucket";`;
    const context = createContext(code);
    const diagnostics = enforceBarrelRefRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].line).toBe(1);
    expect(diagnostics[0].column).toBe(1);
  });
});
