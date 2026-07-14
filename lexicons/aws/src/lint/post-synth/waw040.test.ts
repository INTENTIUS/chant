import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw040, checkRdsDeletionProtection } from "./waw040";

function makeCtx(template: object, env?: string) {
  return { ...createPostSynthContext({ aws: template }), env };
}

describe("WAW040: RDS Deletion Protection Disabled (full tier)", () => {
  test("check metadata", () => {
    expect(waw040.id).toBe("WAW040");
    expect(waw040.description).toContain("DeletionProtection");
  });

  const template = {
    Resources: {
      MyDB: {
        Type: "AWS::RDS::DBInstance",
        Properties: { DBInstanceClass: "db.t3.micro" },
      },
    },
  };

  test("warns (not errors) on the light tier — no env set", () => {
    const diags = checkRdsDeletionProtection(makeCtx(template));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW040");
    expect(diags[0].severity).toBe("warning");
  });

  test("warns on a non-production env", () => {
    const diags = checkRdsDeletionProtection(makeCtx(template, "dev"));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
  });

  test("errors on the full/production tier", () => {
    const diags = checkRdsDeletionProtection(makeCtx(template, "prod"));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("error");
  });

  test("errors on env: full", () => {
    const diags = checkRdsDeletionProtection(makeCtx(template, "full"));
    expect(diags[0].severity).toBe("error");
  });

  test("no diagnostic when DeletionProtection: true, even in prod", () => {
    const protectedTemplate = {
      Resources: {
        MyDB: {
          Type: "AWS::RDS::DBInstance",
          Properties: { DeletionProtection: true },
        },
      },
    };
    expect(checkRdsDeletionProtection(makeCtx(protectedTemplate, "prod"))).toHaveLength(0);
  });

  test("skips intrinsic value for DeletionProtection", () => {
    const paramTemplate = {
      Resources: {
        MyDB: {
          Type: "AWS::RDS::DBInstance",
          Properties: { DeletionProtection: { Ref: "ProtectParam" } },
        },
      },
    };
    expect(checkRdsDeletionProtection(makeCtx(paramTemplate, "prod"))).toHaveLength(0);
  });
});
