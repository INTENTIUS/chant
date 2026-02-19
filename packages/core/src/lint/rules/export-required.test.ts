import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { exportRequiredRule } from "./export-required";
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

describe("COR008: export-required", () => {
  test("rule metadata", () => {
    expect(exportRequiredRule.id).toBe("COR008");
    expect(exportRequiredRule.severity).toBe("warning");
    expect(exportRequiredRule.category).toBe("correctness");
  });

  test("does not trigger when declarable is assigned to exported variable", () => {
    const code = `
      class Bucket implements Declarable {
        readonly [Symbol.for("chant.declarable")] = true;
        readonly entityType = "Bucket";
      }
      export const bucket = new Bucket();
    `;
    const context = createContext(code);
    const diagnostics = exportRequiredRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("triggers when declarable is created without export", () => {
    const code = `
      class Bucket implements Declarable {
        readonly [Symbol.for("chant.declarable")] = true;
        readonly entityType = "Bucket";
      }
      new Bucket();
    `;
    const context = createContext(code);
    const diagnostics = exportRequiredRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe("COR008");
    expect(diagnostics[0].severity).toBe("warning");
    expect(diagnostics[0].message).toContain("Bucket");
    expect(diagnostics[0].message).toContain("is not exported");
    expect(diagnostics[0].message).toContain("chant can discover it during synthesis");
  });

  test("triggers when declarable is assigned to non-exported variable", () => {
    const code = `
      class Bucket implements Declarable {
        readonly [Symbol.for("chant.declarable")] = true;
        readonly entityType = "Bucket";
      }
      const bucket = new Bucket();
    `;
    const context = createContext(code);
    const diagnostics = exportRequiredRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("'bucket' (Bucket)");
  });

  test("does not trigger on non-declarable class instantiations", () => {
    const code = `
      class RegularClass {
        value: number;
        constructor(val: number) {
          this.value = val;
        }
      }
      new RegularClass(42);
    `;
    const context = createContext(code);
    const diagnostics = exportRequiredRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("does not trigger on exported non-declarable class", () => {
    const code = `
      class RegularClass {}
      export const obj = new RegularClass();
    `;
    const context = createContext(code);
    const diagnostics = exportRequiredRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("handles multiple declarable instances", () => {
    const code = `
      class Bucket implements Declarable {
        readonly [Symbol.for("chant.declarable")] = true;
        readonly entityType = "Bucket";
      }
      new Bucket();
      new Bucket();
    `;
    const context = createContext(code);
    const diagnostics = exportRequiredRule.check(context);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].ruleId).toBe("COR008");
    expect(diagnostics[1].ruleId).toBe("COR008");
  });

  test("handles mixed exported and non-exported declarables", () => {
    const code = `
      class Bucket implements Declarable {
        readonly [Symbol.for("chant.declarable")] = true;
        readonly entityType = "Bucket";
      }
      export const bucket1 = new Bucket();
      new Bucket();
      export const bucket2 = new Bucket();
    `;
    const context = createContext(code);
    const diagnostics = exportRequiredRule.check(context);

    expect(diagnostics).toHaveLength(1);
  });

  test("reports correct line and column numbers", () => {
    const code = `
      class Bucket implements Declarable {
        readonly [Symbol.for("chant.declarable")] = true;
        readonly entityType = "Bucket";
      }
      new Bucket();
    `;
    const context = createContext(code);
    const diagnostics = exportRequiredRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].line).toBe(6);
    expect(diagnostics[0].column).toBeGreaterThan(0);
    expect(diagnostics[0].file).toBe("test.ts");
  });

  test("handles declarable with constructor arguments", () => {
    const code = `
      class Parameter implements Declarable {
        readonly [Symbol.for("chant.declarable")] = true;
        readonly entityType = "Parameter";
        constructor(name: string, value: string) {}
      }
      new Parameter("key", "value");
    `;
    const context = createContext(code);
    const diagnostics = exportRequiredRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("'Parameter'");
    expect(diagnostics[0].message).toContain("is not exported");
  });

  test("allows exported variable with declarable", () => {
    const code = `
      class Bucket implements Declarable {
        readonly [Symbol.for("chant.declarable")] = true;
        readonly entityType = "Bucket";
      }
      export const myBucket = new Bucket();
    `;
    const context = createContext(code);
    const diagnostics = exportRequiredRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("handles nested new expressions", () => {
    const code = `
      class Bucket implements Declarable {
        readonly [Symbol.for("chant.declarable")] = true;
        readonly entityType = "Bucket";
      }
      class Wrapper {
        constructor(bucket: Bucket) {}
      }
      new Wrapper(new Bucket());
    `;
    const context = createContext(code);
    const diagnostics = exportRequiredRule.check(context);

    // Inner new Bucket() should trigger
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    const bucketDiagnostic = diagnostics.find(d => d.message.includes("Bucket"));
    expect(bucketDiagnostic).toBeDefined();
  });

  test("handles export statement with multiple declarations", () => {
    const code = `
      class Bucket implements Declarable {
        readonly [Symbol.for("chant.declarable")] = true;
        readonly entityType = "Bucket";
      }
      export const bucket1 = new Bucket(), bucket2 = new Bucket();
    `;
    const context = createContext(code);
    const diagnostics = exportRequiredRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });
});
