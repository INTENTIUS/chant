import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw029, checkInvalidDependsOn } from "./waw029";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW029: Invalid DependsOn Target", () => {
  test("check metadata", () => {
    expect(waw029.id).toBe("WAW029");
    expect(waw029.description).toContain("DependsOn");
  });

  test("dangling DependsOn target → error", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          DependsOn: "MyBukcet",
          Properties: {},
        },
      },
    });
    const diags = checkInvalidDependsOn(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW029");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("MyBukcet");
    expect(diags[0].message).toContain("does not exist");
    expect(diags[0].entity).toBe("MyBucket");
    expect(diags[0].lexicon).toBe("aws");
  });

  test("self-referencing DependsOn → error", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          DependsOn: "MyBucket",
          Properties: {},
        },
      },
    });
    const diags = checkInvalidDependsOn(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW029");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("itself");
    expect(diags[0].entity).toBe("MyBucket");
  });

  test("valid DependsOn → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {},
        },
        MyFunction: {
          Type: "AWS::Lambda::Function",
          DependsOn: "MyBucket",
          Properties: {},
        },
      },
    });
    const diags = checkInvalidDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("string DependsOn (not array) → works", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          DependsOn: "NonExistent",
          Properties: {},
        },
      },
    });
    const diags = checkInvalidDependsOn(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("NonExistent");
  });

  test("multiple invalid targets → multiple diagnostics", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          DependsOn: ["Typo1", "Typo2"],
          Properties: {},
        },
      },
    });
    const diags = checkInvalidDependsOn(ctx);
    expect(diags).toHaveLength(2);
    expect(diags[0].message).toContain("Typo1");
    expect(diags[1].message).toContain("Typo2");
  });

  test("no DependsOn → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {},
        },
      },
    });
    const diags = checkInvalidDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("empty Resources → no diagnostic", () => {
    const ctx = makeCtx({ Resources: {} });
    const diags = checkInvalidDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("empty DependsOn array → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          DependsOn: [],
          Properties: {},
        },
      },
    });
    const diags = checkInvalidDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("mixed valid and invalid in same array", () => {
    const ctx = makeCtx({
      Resources: {
        A: { Type: "AWS::S3::Bucket", Properties: {} },
        B: {
          Type: "AWS::Lambda::Function",
          DependsOn: ["A", "NonExistent", "B"],
          Properties: {},
        },
      },
    });
    const diags = checkInvalidDependsOn(ctx);
    expect(diags).toHaveLength(2);
    expect(diags[0].message).toContain("NonExistent");
    expect(diags[0].message).toContain("does not exist");
    expect(diags[1].message).toContain("itself");
  });

  test("no Resources key → no diagnostic", () => {
    const ctx = makeCtx({ AWSTemplateFormatVersion: "2010-09-09" });
    const diags = checkInvalidDependsOn(ctx);
    expect(diags).toHaveLength(0);
  });

  test("multiple resources each with invalid DependsOn", () => {
    const ctx = makeCtx({
      Resources: {
        A: {
          Type: "AWS::S3::Bucket",
          DependsOn: "Ghost1",
          Properties: {},
        },
        B: {
          Type: "AWS::Lambda::Function",
          DependsOn: "Ghost2",
          Properties: {},
        },
      },
    });
    const diags = checkInvalidDependsOn(ctx);
    expect(diags).toHaveLength(2);
    expect(diags[0].entity).toBe("A");
    expect(diags[1].entity).toBe("B");
  });
});
