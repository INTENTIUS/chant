import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { flatDeclarationsRule } from "./flat-declarations";
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

describe("COR001: flat-declarations", () => {
  test("rule metadata", () => {
    expect(flatDeclarationsRule.id).toBe("COR001");
    expect(flatDeclarationsRule.severity).toBe("warning");
    expect(flatDeclarationsRule.category).toBe("style");
  });

  test("triggers on inline object literal in constructor", () => {
    const code = `new Bucket({ bucketEncryption: { serverSideEncryptionConfiguration: [] } });`;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe("COR001");
    expect(diagnostics[0].severity).toBe("warning");
    expect(diagnostics[0].message).toBe("Inline object in Declarable constructor — extract to a named 'const' with 'export'. Each config value should be its own Declarable.");
  });

  test("triggers on inline array literal in constructor", () => {
    const code = `new Bucket({ tags: [{ key: "env", value: "prod" }] });`;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe("COR001");
    expect(diagnostics[0].message).toBe("Inline object in Declarable constructor — extract to a named 'const' with 'export'. Each config value should be its own Declarable.");
  });

  test("does not trigger on primitive values in constructor", () => {
    const code = `new Bucket({ bucketName: "my-bucket", accessControl: "Private" });`;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("does not trigger on identifier references in constructor", () => {
    const code = `new Bucket({ encryption: dataEncryption, publicAccessBlock: dataAccessBlock });`;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("does not trigger on intrinsic calls in constructor", () => {
    const code = `new Bucket({ bucketName: Sub\`\${AWS.StackName}-data\` });`;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("does not trigger on function/method calls in constructor", () => {
    const code = `new Bucket({ encryption: getEncryption() });`;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("triggers on multiple inline objects in same constructor", () => {
    const code = `new Bucket({
      encryption: { type: "AES256" },
      tags: [{ key: "env" }]
    });`;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].ruleId).toBe("COR001");
    expect(diagnostics[1].ruleId).toBe("COR001");
  });

  test("triggers on multiple constructor calls with violations", () => {
    const code = `
      new Bucket({ encryption: { type: "AES256" } });
      new Table({ schema: { fields: [] } });
    `;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].ruleId).toBe("COR001");
    expect(diagnostics[1].ruleId).toBe("COR001");
  });

  test("does not trigger on empty object in constructor", () => {
    const code = `new Bucket({});`;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("does not trigger on constructor with no arguments", () => {
    const code = `new Bucket();`;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("does not trigger on constructor with non-object argument", () => {
    const code = `new SomeClass("string-arg");`;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("reports correct line and column numbers", () => {
    const code = `new Bucket({ encryption: { type: "AES256" } });`;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].line).toBe(1);
    expect(diagnostics[0].column).toBeGreaterThan(0);
    expect(diagnostics[0].file).toBe("test.ts");
  });

  test("handles mixed primitive and object properties in constructor", () => {
    const code = `new Bucket({
      bucketName: "my-bucket",
      encryption: { type: "AES256" },
      accessControl: "Private"
    });`;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toBe("Inline object in Declarable constructor — extract to a named 'const' with 'export'. Each config value should be its own Declarable.");
  });

  test("does not trigger on non-constructor object literals", () => {
    const code = `export const x = { a: { b: 1 } };`;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("handles nested constructors", () => {
    const code = `new Outer({ inner: new Inner({ config: { value: 1 } }) });`;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);

    // Should flag the inline object in the Inner constructor
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe("COR001");
  });

  test("does not trigger inside Composite() factory callback", () => {
    const code = `
      const MyComposite = Composite((props) => {
        const role = new Role({
          assumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow" }],
          },
        });
        return { role };
      });
    `;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("does not trigger inside _.Composite() factory callback", () => {
    const code = `
      const MyComposite = _.Composite((props) => {
        const role = new _.Role({
          policies: [{ policyName: "CustomPolicy" }],
        });
        return { role };
      });
    `;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("still triggers outside Composite() in same file", () => {
    const code = `
      const MyComposite = Composite((props) => {
        const role = new Role({ config: { value: 1 } });
        return { role };
      });
      const bucket = new Bucket({ encryption: { type: "AES256" } });
    `;
    const context = createContext(code);
    const diagnostics = flatDeclarationsRule.check(context);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("Inline object");
  });
});
