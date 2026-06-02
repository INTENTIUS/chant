import { describe, test, expect } from "vitest";
import { awsSerializer } from "./serializer";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { AttrRef } from "@intentius/chant/attrref";

class MockBucket implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "aws";
  readonly entityType = "AWS::S3::Bucket";
  readonly arn: AttrRef;
  readonly props: Record<string, unknown>;
  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
    this.arn = new AttrRef(this, "Arn");
  }
}

describe("awsSerializer ownership stamping (#119)", () => {
  test("stamps the ownership marker as tags when context.ownership is set", () => {
    const entities = new Map<string, Declarable>([["MyBucket", new MockBucket({ BucketName: "b" })]]);
    const out = awsSerializer.serialize(entities, [], { ownership: { stack: "billing", env: "prod" } });
    const template = JSON.parse(out as string);
    const tags = template.Resources.MyBucket.Properties.Tags as Array<{ Key: string; Value: string }>;
    const byKey = Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
    expect(byKey["chant:managed-by"]).toBe("chant");
    expect(byKey["chant:stack"]).toBe("billing");
    expect(byKey["chant:env"]).toBe("prod");
  });

  test("no ownership context → no chant tags injected", () => {
    const entities = new Map<string, Declarable>([["MyBucket", new MockBucket({ BucketName: "b" })]]);
    const out = awsSerializer.serialize(entities, []);
    const template = JSON.parse(out as string);
    const tags = (template.Resources.MyBucket.Properties?.Tags ?? []) as Array<{ Key: string }>;
    expect(tags.some((t) => t.Key.startsWith("chant:"))).toBe(false);
  });
});
