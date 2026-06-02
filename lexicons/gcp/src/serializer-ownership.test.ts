import { describe, test, expect } from "vitest";
import { gcpSerializer } from "./serializer";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";

function mockResource(entityType: string, props: Record<string, unknown>): any {
  return { [DECLARABLE_MARKER]: true, lexicon: "gcp", entityType, kind: "resource", props };
}

describe("gcpSerializer ownership stamping (#119)", () => {
  test("stamps the ownership marker as labels when context.ownership is set", () => {
    const entities = new Map<string, any>([
      ["myBucket", mockResource("GCP::Storage::Bucket", { metadata: { name: "my-bucket" }, location: "US" })],
    ]);
    const yaml = gcpSerializer.serialize(entities, [], { ownership: { stack: "billing", env: "prod" } });
    expect(yaml).toContain("app.kubernetes.io/managed-by: chant");
    expect(yaml).toContain("chant.intentius.io/stack: billing");
    expect(yaml).toContain("chant.intentius.io/env: prod");
  });

  test("no ownership context → no chant labels", () => {
    const entities = new Map<string, any>([
      ["myBucket", mockResource("GCP::Storage::Bucket", { metadata: { name: "my-bucket" }, location: "US" })],
    ]);
    const yaml = gcpSerializer.serialize(entities, []);
    expect(yaml).not.toContain("managed-by: chant");
    expect(yaml).not.toContain("chant.intentius.io/stack");
  });
});
