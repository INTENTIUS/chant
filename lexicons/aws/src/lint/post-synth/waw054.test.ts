import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw054, checkEcrTagImmutability } from "./waw054";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW054: ECR Tag Mutability Not Immutable", () => {
  test("check metadata", () => {
    expect(waw054.id).toBe("WAW054");
    expect(waw054.description).toContain("immutable");
  });

  test("flags a repository with no ImageTagMutability set (defaults to MUTABLE)", () => {
    const ctx = makeCtx({
      Resources: { MyRepo: { Type: "AWS::ECR::Repository", Properties: { RepositoryName: "app" } } },
    });
    const diags = checkEcrTagImmutability(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW054");
  });

  test("flags ImageTagMutability: MUTABLE", () => {
    const ctx = makeCtx({
      Resources: { MyRepo: { Type: "AWS::ECR::Repository", Properties: { ImageTagMutability: "MUTABLE" } } },
    });
    expect(checkEcrTagImmutability(ctx)).toHaveLength(1);
  });

  test("no diagnostic when ImageTagMutability: IMMUTABLE", () => {
    const ctx = makeCtx({
      Resources: { MyRepo: { Type: "AWS::ECR::Repository", Properties: { ImageTagMutability: "IMMUTABLE" } } },
    });
    expect(checkEcrTagImmutability(ctx)).toHaveLength(0);
  });

  test("skips intrinsic ImageTagMutability values", () => {
    const ctx = makeCtx({
      Resources: { MyRepo: { Type: "AWS::ECR::Repository", Properties: { ImageTagMutability: { Ref: "MutabilityParam" } } } },
    });
    expect(checkEcrTagImmutability(ctx)).toHaveLength(0);
  });

  test("no diagnostic for non-ECR resources", () => {
    const ctx = makeCtx({ Resources: { MyBucket: { Type: "AWS::S3::Bucket", Properties: {} } } });
    expect(checkEcrTagImmutability(ctx)).toHaveLength(0);
  });
});
