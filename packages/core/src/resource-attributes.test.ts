import { describe, test, expect, spyOn } from "bun:test";
import { resolveDependsOn } from "./resource-attributes";
import { DECLARABLE_MARKER, type Declarable } from "./declarable";

function mockDeclarable(type = "AWS::S3::Bucket"): Declarable {
  return {
    [DECLARABLE_MARKER]: true,
    lexicon: "aws",
    entityType: type,
    kind: "resource",
  } as Declarable;
}

describe("resolveDependsOn", () => {
  test("resolves a single Declarable to its logical name", () => {
    const bucket = mockDeclarable();
    const entityNames = new Map<Declarable, string>([[bucket, "MyBucket"]]);

    const result = resolveDependsOn(bucket, entityNames, "MyResource");
    expect(result).toEqual(["MyBucket"]);
  });

  test("resolves an array of Declarables", () => {
    const bucket = mockDeclarable("AWS::S3::Bucket");
    const role = mockDeclarable("AWS::IAM::Role");
    const entityNames = new Map<Declarable, string>([
      [bucket, "MyBucket"],
      [role, "MyRole"],
    ]);

    const result = resolveDependsOn([bucket, role], entityNames, "MyResource");
    expect(result).toEqual(["MyBucket", "MyRole"]);
  });

  test("passes through a single string", () => {
    const entityNames = new Map<Declarable, string>();
    const result = resolveDependsOn("ExternalResource", entityNames, "MyResource");
    expect(result).toEqual(["ExternalResource"]);
  });

  test("passes through an array of strings", () => {
    const entityNames = new Map<Declarable, string>();
    const result = resolveDependsOn(["ResA", "ResB"], entityNames, "MyResource");
    expect(result).toEqual(["ResA", "ResB"]);
  });

  test("handles mixed strings and Declarables", () => {
    const bucket = mockDeclarable();
    const entityNames = new Map<Declarable, string>([[bucket, "MyBucket"]]);

    const result = resolveDependsOn(["ManualRef", bucket], entityNames, "MyResource");
    expect(result).toEqual(["ManualRef", "MyBucket"]);
  });

  test("warns and skips Declarable not found in entityNames", () => {
    const bucket = mockDeclarable();
    const entityNames = new Map<Declarable, string>(); // bucket not registered
    const spy = spyOn(console, "warn").mockImplementation(() => {});

    const result = resolveDependsOn(bucket, entityNames, "MyResource");
    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("MyResource");

    spy.mockRestore();
  });

  test("returns empty array for empty array input", () => {
    const entityNames = new Map<Declarable, string>();
    const result = resolveDependsOn([], entityNames, "MyResource");
    expect(result).toEqual([]);
  });

  test("skips non-string non-Declarable values silently", () => {
    const entityNames = new Map<Declarable, string>();
    const result = resolveDependsOn([42, null, true] as unknown[], entityNames, "MyResource");
    expect(result).toEqual([]);
  });
});
