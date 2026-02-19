import { describe, expect, test } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw010 } from "./waw010";
import { waw011 } from "./waw011";
import { cor020 } from "./cor020";
import { findResourceRefs, parseCFTemplate } from "./cf-refs";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

// --- cf-refs utility tests ---

describe("findResourceRefs", () => {
  test("extracts Ref targets", () => {
    const refs = findResourceRefs({ Ref: "MyBucket" });
    expect(refs.has("MyBucket")).toBe(true);
  });

  test("extracts Fn::GetAtt array form", () => {
    const refs = findResourceRefs({ "Fn::GetAtt": ["MyRole", "Arn"] });
    expect(refs.has("MyRole")).toBe(true);
  });

  test("extracts Fn::GetAtt dot form", () => {
    const refs = findResourceRefs({ "Fn::GetAtt": "MyRole.Arn" });
    expect(refs.has("MyRole")).toBe(true);
  });

  test("skips pseudo-parameters", () => {
    const refs = findResourceRefs({ Ref: "AWS::StackName" });
    expect(refs.size).toBe(0);
  });

  test("recurses into nested structures", () => {
    const refs = findResourceRefs({
      "Fn::Join": ["-", [{ Ref: "A" }, { "Fn::GetAtt": ["B", "Arn"] }]],
    });
    expect(refs.has("A")).toBe(true);
    expect(refs.has("B")).toBe(true);
  });
});

describe("parseCFTemplate", () => {
  test("parses valid JSON", () => {
    const t = parseCFTemplate('{"Resources":{}}');
    expect(t).toBeTruthy();
    expect(t!.Resources).toEqual({});
  });

  test("returns null for invalid JSON", () => {
    expect(parseCFTemplate("not json")).toBeNull();
  });
});

// --- WAW010: Redundant DependsOn ---

describe("WAW010: Redundant DependsOn", () => {
  test("detects redundant DependsOn from Ref", () => {
    const ctx = makeCtx({
      Resources: {
        MyFunction: {
          Type: "AWS::Lambda::Function",
          DependsOn: ["MyRole"],
          Properties: {
            Role: { "Fn::GetAtt": ["MyRole", "Arn"] },
          },
        },
        MyRole: {
          Type: "AWS::IAM::Role",
          Properties: {},
        },
      },
    });

    const diags = waw010.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW010");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("redundant DependsOn");
    expect(diags[0].message).toContain("MyRole");
  });

  test("no diagnostic when DependsOn is not redundant", () => {
    const ctx = makeCtx({
      Resources: {
        MyFunction: {
          Type: "AWS::Lambda::Function",
          DependsOn: ["MyTable"],
          Properties: {
            Role: { "Fn::GetAtt": ["MyRole", "Arn"] },
          },
        },
        MyRole: { Type: "AWS::IAM::Role", Properties: {} },
        MyTable: { Type: "AWS::DynamoDB::Table", Properties: {} },
      },
    });

    const diags = waw010.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("handles string DependsOn (not array)", () => {
    const ctx = makeCtx({
      Resources: {
        A: {
          Type: "AWS::Lambda::Function",
          DependsOn: "B",
          Properties: { X: { Ref: "B" } },
        },
        B: { Type: "AWS::S3::Bucket", Properties: {} },
      },
    });

    const diags = waw010.check(ctx);
    expect(diags).toHaveLength(1);
  });
});

// --- WAW011: Deprecated Lambda Runtime ---

describe("WAW011: Deprecated Lambda Runtime", () => {
  test("emits error for deprecated runtime", () => {
    const ctx = makeCtx({
      Resources: {
        MyFunc: {
          Type: "AWS::Lambda::Function",
          Properties: { Runtime: "nodejs14.x" },
        },
      },
    });

    const diags = waw011.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW011");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("deprecated");
    expect(diags[0].message).toContain("nodejs14.x");
  });

  test("emits warning for approaching-EOL runtime", () => {
    const ctx = makeCtx({
      Resources: {
        MyFunc: {
          Type: "AWS::Lambda::Function",
          Properties: { Runtime: "nodejs18.x" },
        },
      },
    });

    const diags = waw011.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("approaching end-of-life");
  });

  test("no diagnostic for current runtime", () => {
    const ctx = makeCtx({
      Resources: {
        MyFunc: {
          Type: "AWS::Lambda::Function",
          Properties: { Runtime: "nodejs22.x" },
        },
      },
    });

    const diags = waw011.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("skips non-Lambda resources", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: { Runtime: "nodejs14.x" },
        },
      },
    });

    const diags = waw011.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// --- COR020: Circular Resource Dependencies ---

describe("COR020: Circular Resource Dependencies", () => {
  test("detects simple two-node cycle", () => {
    const ctx = makeCtx({
      Resources: {
        A: {
          Type: "AWS::Lambda::Function",
          Properties: { X: { Ref: "B" } },
        },
        B: {
          Type: "AWS::IAM::Role",
          Properties: { Y: { Ref: "A" } },
        },
      },
    });

    const diags = cor020.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("COR020");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("Circular resource dependency");
    // Should contain both nodes in the cycle
    expect(diags[0].message).toContain("A");
    expect(diags[0].message).toContain("B");
  });

  test("detects three-node cycle", () => {
    const ctx = makeCtx({
      Resources: {
        A: {
          Type: "AWS::Lambda::Function",
          Properties: { X: { Ref: "B" } },
        },
        B: {
          Type: "AWS::IAM::Role",
          Properties: { Y: { Ref: "C" } },
        },
        C: {
          Type: "AWS::S3::Bucket",
          DependsOn: ["A"],
          Properties: {},
        },
      },
    });

    const diags = cor020.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("A");
    expect(diags[0].message).toContain("B");
    expect(diags[0].message).toContain("C");
  });

  test("no diagnostic for acyclic graph", () => {
    const ctx = makeCtx({
      Resources: {
        A: {
          Type: "AWS::Lambda::Function",
          Properties: { X: { Ref: "B" } },
        },
        B: {
          Type: "AWS::IAM::Role",
          Properties: { Y: { Ref: "C" } },
        },
        C: {
          Type: "AWS::S3::Bucket",
          Properties: {},
        },
      },
    });

    const diags = cor020.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("handles DependsOn-based cycles", () => {
    const ctx = makeCtx({
      Resources: {
        A: {
          Type: "AWS::Lambda::Function",
          DependsOn: ["B"],
          Properties: {},
        },
        B: {
          Type: "AWS::IAM::Role",
          DependsOn: ["A"],
          Properties: {},
        },
      },
    });

    const diags = cor020.check(ctx);
    expect(diags).toHaveLength(1);
  });
});
