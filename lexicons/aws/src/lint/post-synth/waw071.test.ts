import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw071, checkTagShapes } from "./waw071";
import type { TagPlacement } from "../../taggable";

const placements = new Map<string, TagPlacement | null>([
  ["AWS::S3::Bucket", { property: "Tags", shape: "list" }],
  ["AWS::SSM::Parameter", { property: "Tags", shape: "map" }],
  ["AWS::Cognito::UserPool", { property: "UserPoolTags", shape: "map" }],
  ["AWS::EC2::CapacityReservation", null],
]);

function check(resources: Record<string, unknown>) {
  return checkTagShapes(createPostSynthContext({ aws: { Resources: resources } }), placements);
}

describe("WAW071: tags in the wrong property or shape", () => {
  test("check metadata", () => {
    expect(waw071.id).toBe("WAW071");
  });

  test("flags Tags on a user pool", () => {
    const d = check({ Pool: { Type: "AWS::Cognito::UserPool", Properties: { Tags: [{ Key: "a", Value: "b" }] } } });
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain("UserPoolTags");
    expect(d[0].severity).toBe("error");
  });

  test("flags a list on a map type", () => {
    const d = check({ P: { Type: "AWS::SSM::Parameter", Properties: { Tags: [{ Key: "a", Value: "b" }] } } });
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain("map");
  });

  test("flags a map on a list type", () => {
    const d = check({ B: { Type: "AWS::S3::Bucket", Properties: { Tags: { a: "b" } } } });
    expect(d).toHaveLength(1);
  });

  test("passes the right shapes, intrinsics and unplaceable types", () => {
    const d = check({
      B: { Type: "AWS::S3::Bucket", Properties: { Tags: [{ Key: "a", Value: { Ref: "X" } }, { "Fn::If": ["C", { Key: "k", Value: "v" }, { Ref: "AWS::NoValue" }] }] } },
      P: { Type: "AWS::SSM::Parameter", Properties: { Tags: { a: "b" } } },
      Pool: { Type: "AWS::Cognito::UserPool", Properties: { UserPoolTags: { a: "b" } } },
      Q: { Type: "AWS::SSM::Parameter", Properties: { Tags: { "Fn::If": ["C", { a: "b" }, {}] } } },
      CR: { Type: "AWS::EC2::CapacityReservation", Properties: { Tags: [] } },
    });
    expect(d).toEqual([]);
  });
});
