import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { hardcodedRegionRule } from "./hardcoded-region";
import { s3EncryptionRule } from "./s3-encryption";
import { iamWildcardRule } from "./iam-wildcard";
import type { LintContext } from "@intentius/chant/lint/rule";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
  );
  return {
    sourceFile,
    entities: [],
    filePath: fileName,
  };
}

describe("AWS Lint Rules", () => {
  describe("WAW001: Hardcoded Region", () => {
    test("detects hardcoded us-east-1", () => {
      const context = createContext(`const region = "us-east-1";`);
      const diagnostics = hardcodedRegionRule.check(context);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].ruleId).toBe("WAW001");
      expect(diagnostics[0].message).toContain("us-east-1");
    });

    test("detects hardcoded eu-west-2", () => {
      const context = createContext(`const region = "eu-west-2";`);
      const diagnostics = hardcodedRegionRule.check(context);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].message).toContain("eu-west-2");
    });

    test("detects hardcoded ap-southeast-1", () => {
      const context = createContext(`const region = "ap-southeast-1";`);
      const diagnostics = hardcodedRegionRule.check(context);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].message).toContain("ap-southeast-1");
    });

    test("ignores non-region strings", () => {
      const context = createContext(`const name = "my-bucket-name";`);
      const diagnostics = hardcodedRegionRule.check(context);
      expect(diagnostics).toHaveLength(0);
    });

    test("ignores AWS.Region reference", () => {
      const context = createContext(`const region = AWS.Region;`);
      const diagnostics = hardcodedRegionRule.check(context);
      expect(diagnostics).toHaveLength(0);
    });

    test("has correct metadata", () => {
      expect(hardcodedRegionRule.id).toBe("WAW001");
      expect(hardcodedRegionRule.severity).toBe("warning");
      expect(hardcodedRegionRule.category).toBe("security");
    });
  });

  describe("WAW006: S3 Encryption", () => {
    test("warns on Bucket without encryption", () => {
      const context = createContext(`
        const bucket = new Bucket({ BucketName: "my-bucket" });
      `);
      const diagnostics = s3EncryptionRule.check(context);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].ruleId).toBe("WAW006");
      expect(diagnostics[0].message).toContain("encryption");
    });

    test("passes with BucketEncryption property", () => {
      const context = createContext(`
        const bucket = new Bucket({
          BucketName: "my-bucket",
          BucketEncryption: { ServerSideEncryptionConfiguration: [] },
        });
      `);
      const diagnostics = s3EncryptionRule.check(context);
      expect(diagnostics).toHaveLength(0);
    });

    test("passes with ServerSideEncryptionConfiguration property", () => {
      const context = createContext(`
        const bucket = new Bucket({
          BucketName: "my-bucket",
          ServerSideEncryptionConfiguration: [],
        });
      `);
      const diagnostics = s3EncryptionRule.check(context);
      expect(diagnostics).toHaveLength(0);
    });

    test("ignores non-Bucket constructors", () => {
      const context = createContext(`
        const fn = new Function({ FunctionName: "my-fn" });
      `);
      const diagnostics = s3EncryptionRule.check(context);
      expect(diagnostics).toHaveLength(0);
    });

    test("has correct metadata", () => {
      expect(s3EncryptionRule.id).toBe("WAW006");
      expect(s3EncryptionRule.severity).toBe("warning");
      expect(s3EncryptionRule.category).toBe("security");
    });
  });

  describe("WAW009: IAM Wildcard", () => {
    test("warns on Resource: '*'", () => {
      const context = createContext(`
        const policy = {
          Statement: [{
            Effect: "Allow",
            Action: "s3:*",
            Resource: "*",
          }],
        };
      `);
      const diagnostics = iamWildcardRule.check(context);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].ruleId).toBe("WAW009");
      expect(diagnostics[0].message).toContain("wildcard");
    });

    test("warns on Resources array with '*'", () => {
      const context = createContext(`
        const policy = {
          Statement: [{
            Effect: "Allow",
            Action: "s3:*",
            Resources: ["*"],
          }],
        };
      `);
      const diagnostics = iamWildcardRule.check(context);
      expect(diagnostics).toHaveLength(1);
    });

    test("passes with explicit ARN", () => {
      const context = createContext(`
        const policy = {
          Statement: [{
            Effect: "Allow",
            Action: "s3:GetObject",
            Resource: "arn:aws:s3:::my-bucket/*",
          }],
        };
      `);
      const diagnostics = iamWildcardRule.check(context);
      expect(diagnostics).toHaveLength(0);
    });

    test("ignores unrelated properties", () => {
      const context = createContext(`
        const config = {
          name: "*",
          pattern: "*",
        };
      `);
      const diagnostics = iamWildcardRule.check(context);
      expect(diagnostics).toHaveLength(0);
    });

    test("has correct metadata", () => {
      expect(iamWildcardRule.id).toBe("WAW009");
      expect(iamWildcardRule.severity).toBe("warning");
      expect(iamWildcardRule.category).toBe("security");
    });
  });
});
