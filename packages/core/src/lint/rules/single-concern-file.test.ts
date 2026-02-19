import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { singleConcernFileRule } from "./single-concern-file";
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

describe("COR013: single-concern-file", () => {
  test("rule metadata", () => {
    expect(singleConcernFileRule.id).toBe("COR013");
    expect(singleConcernFileRule.severity).toBe("info");
    expect(singleConcernFileRule.category).toBe("style");
  });

  test("does not trigger on resource-only file", () => {
    const code = `
      export const bucket = new Bucket({ bucketName: "data" });
      export const table = new Table({ tableName: "users" });
    `;
    const context = createContext(code);
    const diagnostics = singleConcernFileRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("does not trigger on config-only file", () => {
    const code = `
      export const encryption = new BucketEncryption({ type: "AES256" });
      export const versioning = new VersioningConfiguration({ status: "Enabled" });
    `;
    const context = createContext(code);
    const diagnostics = singleConcernFileRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("triggers on file mixing resource and config declarables", () => {
    const code = `
      export const bucket = new Bucket({ bucketName: "data" });
      export const encryption = new BucketEncryption({ type: "AES256" });
    `;
    const context = createContext(code);
    const diagnostics = singleConcernFileRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe("COR013");
    expect(diagnostics[0].severity).toBe("info");
    expect(diagnostics[0].message).toContain("mixes resource Declarables with configuration Declarables");
  });

  test("triggers with qualified class names (e.g. aws.Bucket)", () => {
    const code = `
      export const bucket = new aws.Bucket({ bucketName: "data" });
      export const encryption = new aws.BucketEncryption({ type: "AES256" });
    `;
    const context = createContext(code);
    const diagnostics = singleConcernFileRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe("COR013");
  });

  test("does not trigger on file with no new expressions", () => {
    const code = `
      export const name = "hello";
      export function greet() { return name; }
    `;
    const context = createContext(code);
    const diagnostics = singleConcernFileRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("does not trigger on file with only lowercase constructors", () => {
    const code = `
      const x = new something();
    `;
    const context = createContext(code);
    const diagnostics = singleConcernFileRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("triggers with multiple property-kind patterns", () => {
    const code = `
      export const role = new Role({ roleName: "admin" });
      export const policy = new AccessPolicy({ effect: "Allow" });
    `;
    const context = createContext(code);
    const diagnostics = singleConcernFileRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].ruleId).toBe("COR013");
  });

  test("does not trigger with single new expression", () => {
    const code = `
      export const bucket = new Bucket({ bucketName: "data" });
    `;
    const context = createContext(code);
    const diagnostics = singleConcernFileRule.check(context);
    expect(diagnostics).toHaveLength(0);
  });

  test("reports correct file path", () => {
    const code = `
      export const bucket = new Bucket({});
      export const enc = new BucketEncryption({});
    `;
    const context = createContext(code, "src/my-file.ts");
    const diagnostics = singleConcernFileRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].file).toBe("src/my-file.ts");
  });

  test("handles Configuration suffix", () => {
    const code = `
      export const bucket = new Bucket({});
      export const config = new VersioningConfiguration({});
    `;
    const context = createContext(code);
    const diagnostics = singleConcernFileRule.check(context);
    expect(diagnostics).toHaveLength(1);
  });

  test("handles Block suffix", () => {
    const code = `
      export const bucket = new Bucket({});
      export const block = new PublicAccessBlock({});
    `;
    const context = createContext(code);
    const diagnostics = singleConcernFileRule.check(context);
    expect(diagnostics).toHaveLength(1);
  });

  test("handles Specification suffix", () => {
    const code = `
      export const bucket = new Bucket({});
      export const spec = new ServerSideEncryptionSpecification({});
    `;
    const context = createContext(code);
    const diagnostics = singleConcernFileRule.check(context);
    expect(diagnostics).toHaveLength(1);
  });
});
