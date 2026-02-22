import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw021, checkRdsEncryption } from "./waw021";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW021: RDS Storage Not Encrypted", () => {
  test("check metadata", () => {
    expect(waw021.id).toBe("WAW021");
    expect(waw021.description).toContain("encrypted");
  });

  test("flags DBInstance without StorageEncrypted", () => {
    const ctx = makeCtx({
      Resources: {
        MyDB: {
          Type: "AWS::RDS::DBInstance",
          Properties: { DBInstanceClass: "db.t3.micro", Engine: "mysql" },
        },
      },
    });
    const diags = checkRdsEncryption(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW021");
    expect(diags[0].severity).toBe("error");
  });

  test("flags DBCluster without StorageEncrypted", () => {
    const ctx = makeCtx({
      Resources: {
        MyCluster: {
          Type: "AWS::RDS::DBCluster",
          Properties: { Engine: "aurora-mysql" },
        },
      },
    });
    const diags = checkRdsEncryption(ctx);
    expect(diags).toHaveLength(1);
  });

  test("no diagnostic when StorageEncrypted: true", () => {
    const ctx = makeCtx({
      Resources: {
        MyDB: {
          Type: "AWS::RDS::DBInstance",
          Properties: { StorageEncrypted: true, DBInstanceClass: "db.t3.micro" },
        },
      },
    });
    const diags = checkRdsEncryption(ctx);
    expect(diags).toHaveLength(0);
  });

  test("flags StorageEncrypted: false", () => {
    const ctx = makeCtx({
      Resources: {
        MyDB: {
          Type: "AWS::RDS::DBInstance",
          Properties: { StorageEncrypted: false, DBInstanceClass: "db.t3.micro" },
        },
      },
    });
    const diags = checkRdsEncryption(ctx);
    expect(diags).toHaveLength(1);
  });

  test("skips intrinsic value for StorageEncrypted", () => {
    const ctx = makeCtx({
      Resources: {
        MyDB: {
          Type: "AWS::RDS::DBInstance",
          Properties: { StorageEncrypted: { Ref: "EncryptParam" } },
        },
      },
    });
    const diags = checkRdsEncryption(ctx);
    expect(diags).toHaveLength(0);
  });
});
