import { describe, test, expect } from "vitest";
import { awsSerializer, mergeTags } from "./serializer";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { loadTagPlacements } from "./taggable";

class MockResource implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "aws";
  constructor(readonly entityType: string, readonly props: Record<string, unknown> = {}) {}
}

const OWNERSHIP = { stack: "loom", env: "dev" };
const MARKER = { "chant:managed-by": "chant", "chant:stack": "loom", "chant:env": "dev" };

function build(type: string, props: Record<string, unknown> = {}) {
  const entities = new Map<string, Declarable>([["R", new MockResource(type, props)]]);
  const template = JSON.parse(awsSerializer.serialize(entities, [], { ownership: OWNERSHIP }) as string);
  return template.Resources.R as { Properties?: Record<string, unknown>; Metadata?: Record<string, unknown> };
}

describe("tag placements from the generated lexicon (#4350)", () => {
  test("reads property and shape per type", () => {
    const p = loadTagPlacements();
    expect(p.get("AWS::S3::Bucket")).toEqual({ property: "Tags", shape: "list" });
    expect(p.get("AWS::SSM::Parameter")).toEqual({ property: "Tags", shape: "map" });
    expect(p.get("AWS::BedrockAgentCore::Runtime")).toEqual({ property: "Tags", shape: "map" });
    expect(p.get("AWS::BedrockAgentCore::Memory")).toEqual({ property: "Tags", shape: "map" });
    expect(p.get("AWS::Cognito::UserPool")).toEqual({ property: "UserPoolTags", shape: "map" });
    expect(p.get("AWS::EC2::CapacityReservation")).toBeNull();
  });
});

describe("ownership stamping by tag shape (#4350)", () => {
  test("list type gets a [{Key, Value}] list in Tags", () => {
    const r = build("AWS::S3::Bucket", { BucketName: "b" });
    expect(r.Properties!.Tags).toEqual(Object.entries(MARKER).map(([Key, Value]) => ({ Key, Value })));
  });

  test("map type gets a map in Tags", () => {
    const r = build("AWS::SSM::Parameter", { Type: "String", Value: "v" });
    expect(r.Properties!.Tags).toEqual(MARKER);
  });

  test("Cognito user pool gets UserPoolTags, and no Tags", () => {
    const r = build("AWS::Cognito::UserPool", { UserPoolName: "p", UserPoolTags: { component: "loom-cognito" } });
    expect(r.Properties!.Tags).toBeUndefined();
    expect(r.Properties!.UserPoolTags).toEqual({ ...MARKER, component: "loom-cognito" });
  });

  test("explicit map tags merge on a map type, explicit key wins", () => {
    const r = build("AWS::SSM::Parameter", { Type: "String", Value: "v", Tags: { team: "a", "chant:env": "override" } });
    expect(r.Properties!.Tags).toEqual({ ...MARKER, team: "a", "chant:env": "override" });
  });

  test("explicit list tags on a map type are converted", () => {
    const r = build("AWS::SSM::Parameter", { Type: "String", Value: "v", Tags: [{ Key: "team", Value: "a" }] });
    expect(r.Properties!.Tags).toEqual({ ...MARKER, team: "a" });
  });

  test("explicit map tags on a list type are converted", () => {
    const r = build("AWS::S3::Bucket", { Tags: { team: "a" } });
    expect(r.Properties!.Tags).toContainEqual({ Key: "team", Value: "a" });
    expect(r.Properties!.Tags).toContainEqual({ Key: "chant:managed-by", Value: "chant" });
  });

  test("a type it can't place gets the marker in its own Metadata, not a Tags property", () => {
    const r = build("AWS::EC2::CapacityReservation", { InstanceType: "t3.micro" });
    expect(r.Properties!.Tags).toBeUndefined();
    expect(r.Metadata!["chant:ownership"]).toEqual(MARKER);
  });
});

describe("mergeTags", () => {
  const stamped = [{ Key: "chant:managed-by", Value: "chant" }];
  test("an intrinsic explicit value can't be merged", () => {
    expect(mergeTags({ "Fn::If": ["C", [], []] }, stamped, { property: "Tags", shape: "list" })).toBeUndefined();
    expect(mergeTags({ Ref: "T" }, stamped, { property: "Tags", shape: "map" })).toBeUndefined();
  });
  test("no explicit value stamps alone", () => {
    expect(mergeTags(undefined, stamped, { property: "Tags", shape: "map" })).toEqual({ "chant:managed-by": "chant" });
    expect(mergeTags(undefined, stamped, { property: "Tags", shape: "list" })).toEqual(stamped);
  });
});
