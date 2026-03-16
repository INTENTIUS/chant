import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw017, checkMissingTags } from "./waw017";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

/** Synthetic taggable set — no disk dependency. */
const taggable = new Set(["AWS::S3::Bucket", "AWS::Lambda::Function"]);

describe("WAW017: Missing Tags on Taggable Resource", () => {
  test("check metadata", () => {
    expect(waw017.id).toBe("WAW017");
    expect(waw017.description).toContain("tags");
  });

  test("emits warning for taggable resource without Tags", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: { BucketName: "my-bucket" },
        },
      },
    });
    const diags = checkMissingTags(ctx, taggable);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW017");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("tagging");
    expect(diags[0].message).toContain("MyBucket");
    expect(diags[0].entity).toBe("MyBucket");
    expect(diags[0].lexicon).toBe("aws");
  });

  test("no diagnostic when Tags are present", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            BucketName: "my-bucket",
            Tags: [{ Key: "Env", Value: "prod" }],
          },
        },
      },
    });
    const diags = checkMissingTags(ctx, taggable);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic for non-taggable resource type", () => {
    const ctx = makeCtx({
      Resources: {
        MyCustom: {
          Type: "Custom::MyResource",
          Properties: { Foo: "bar" },
        },
      },
    });
    const diags = checkMissingTags(ctx, taggable);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic on empty template", () => {
    const ctx = makeCtx({ Resources: {} });
    const diags = checkMissingTags(ctx, taggable);
    expect(diags).toHaveLength(0);
  });

  test("handles resource with no Properties (still flags missing Tags)", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: { Type: "AWS::S3::Bucket" },
      },
    });
    const diags = checkMissingTags(ctx, taggable);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("MyBucket");
  });

  test("returns empty when taggable set is empty", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: { BucketName: "test" },
        },
      },
    });
    const diags = checkMissingTags(ctx, new Set());
    expect(diags).toHaveLength(0);
  });

  test("flags multiple taggable resources missing Tags", () => {
    const ctx = makeCtx({
      Resources: {
        Bucket: {
          Type: "AWS::S3::Bucket",
          Properties: { BucketName: "b" },
        },
        Func: {
          Type: "AWS::Lambda::Function",
          Properties: { FunctionName: "f" },
        },
      },
    });
    const diags = checkMissingTags(ctx, taggable);
    expect(diags).toHaveLength(2);
  });

  test("only flags resources without Tags, not those with", () => {
    const ctx = makeCtx({
      Resources: {
        Tagged: {
          Type: "AWS::S3::Bucket",
          Properties: { Tags: [{ Key: "k", Value: "v" }] },
        },
        Untagged: {
          Type: "AWS::S3::Bucket",
          Properties: { BucketName: "b" },
        },
      },
    });
    const diags = checkMissingTags(ctx, taggable);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("Untagged");
  });
});
