import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw038, checkRdsPubliclyAccessible } from "./waw038";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW038: RDS Publicly Accessible", () => {
  test("check metadata", () => {
    expect(waw038.id).toBe("WAW038");
    expect(waw038.description).toContain("publicly accessible");
  });

  test("flags DBInstance with PubliclyAccessible: true", () => {
    const ctx = makeCtx({
      Resources: {
        MyDB: {
          Type: "AWS::RDS::DBInstance",
          Properties: { DBInstanceClass: "db.t3.micro", PubliclyAccessible: true },
        },
      },
    });
    const diags = checkRdsPubliclyAccessible(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW038");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("MyDB");
  });

  test("no diagnostic when PubliclyAccessible: false", () => {
    const ctx = makeCtx({
      Resources: {
        MyDB: {
          Type: "AWS::RDS::DBInstance",
          Properties: { DBInstanceClass: "db.t3.micro", PubliclyAccessible: false },
        },
      },
    });
    expect(checkRdsPubliclyAccessible(ctx)).toHaveLength(0);
  });

  test("no diagnostic when PubliclyAccessible is unset", () => {
    const ctx = makeCtx({
      Resources: {
        MyDB: {
          Type: "AWS::RDS::DBInstance",
          Properties: { DBInstanceClass: "db.t3.micro" },
        },
      },
    });
    expect(checkRdsPubliclyAccessible(ctx)).toHaveLength(0);
  });

  test("does not apply to DBCluster (no PubliclyAccessible property)", () => {
    const ctx = makeCtx({
      Resources: {
        MyCluster: {
          Type: "AWS::RDS::DBCluster",
          Properties: { Engine: "aurora-mysql" },
        },
      },
    });
    expect(checkRdsPubliclyAccessible(ctx)).toHaveLength(0);
  });

  test("skips intrinsic value for PubliclyAccessible", () => {
    const ctx = makeCtx({
      Resources: {
        MyDB: {
          Type: "AWS::RDS::DBInstance",
          Properties: { PubliclyAccessible: { Ref: "PublicParam" } },
        },
      },
    });
    expect(checkRdsPubliclyAccessible(ctx)).toHaveLength(0);
  });
});
