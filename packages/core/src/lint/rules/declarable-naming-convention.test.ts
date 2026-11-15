import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import { declarableNamingConventionRule, toCamelCase } from "./declarable-naming-convention";
import { IMPORTED_SOURCE_HEADER, IMPORTED_SOURCE_MARKER } from "./imported-source";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    true,
  );

  return {
    sourceFile,
    entities: [],
    filePath,
    lexicon: undefined,
  };
}

describe("COR005: declarable-naming-convention", () => {
  test("rule metadata", () => {
    expect(declarableNamingConventionRule.id).toBe("COR005");
    expect(declarableNamingConventionRule.severity).toBe("warning");
    expect(declarableNamingConventionRule.category).toBe("style");
  });

  test("triggers on PascalCase declarable name", () => {
    const ctx = createContext(`export const DataBucket = new Bucket({ bucketName: "x" });`);
    const diags = declarableNamingConventionRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR005");
    expect(diags[0].message).toContain("dataBucket");
  });

  test("triggers on UPPER_SNAKE_CASE declarable name", () => {
    const ctx = createContext(`export const DATA_BUCKET = new Bucket({ bucketName: "x" });`);
    const diags = declarableNamingConventionRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR005");
  });

  test("does not trigger on camelCase declarable name", () => {
    const ctx = createContext(`export const dataBucket = new Bucket({ bucketName: "x" });`);
    const diags = declarableNamingConventionRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not trigger on function calls (not new expressions)", () => {
    const ctx = createContext(`export const DataBucket = createBucket({ bucketName: "x" });`);
    const diags = declarableNamingConventionRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not trigger on non-exported declarations", () => {
    const ctx = createContext(`const DataBucket = new Bucket({ bucketName: "x" });`);
    const diags = declarableNamingConventionRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("reports correct line and column", () => {
    const ctx = createContext(`export const DataBucket = new Bucket({});`);
    const diags = declarableNamingConventionRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(1);
    expect(diags[0].column).toBeGreaterThan(0);
  });

  test.each([
    ["TFStateBucket", "tfStateBucket"],
    ["OBSAdminUser", "obsAdminUser"],
    ["HTTPServer", "httpServer"],
    ["S3Bucket", "s3Bucket"],
    ["TF2State", "tf2State"],
    ["URL", "url"],
    ["DataBucket", "dataBucket"],
    ["DATA_BUCKET", "dataBucket"],
    ["MAX_RETRY_COUNT", "maxRetryCount"],
    ["Data_Bucket", "dataBucket"],
  ])("suggests %s as %s", (name, expected) => {
    expect(toCamelCase(name)).toBe(expected);
    const diags = declarableNamingConventionRule.check(createContext(`export const ${name} = new Bucket({});`));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain(`rename to '${expected}'`);
  });

  test("skips a file that opens with the import marker", () => {
    const code = `${IMPORTED_SOURCE_HEADER}import { Bucket } from "@intentius/chant-lexicon-aws";\nexport const TFStateBucket = new Bucket({});`;
    expect(declarableNamingConventionRule.check(createContext(code))).toHaveLength(0);
  });

  test("still flags when the marker sits below code, not in the opening comments", () => {
    const code = `export const TFStateBucket = new Bucket({});\n${IMPORTED_SOURCE_MARKER}\n`;
    expect(declarableNamingConventionRule.check(createContext(code))).toHaveLength(1);
  });

  test("still flags a file whose opening comment is not the marker", () => {
    const code = `// hand written\nexport const TFStateBucket = new Bucket({});`;
    expect(declarableNamingConventionRule.check(createContext(code))).toHaveLength(1);
  });
});
