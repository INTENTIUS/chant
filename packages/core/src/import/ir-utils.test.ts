import { describe, expect, test } from "bun:test";
import { hasIntrinsicInValue, irUsesIntrinsic, collectDependencies } from "./ir-utils";
import type { TemplateIR } from "./parser";

describe("hasIntrinsicInValue", () => {
  test("finds intrinsic at top level", () => {
    expect(hasIntrinsicInValue({ __intrinsic: "Sub", template: "hello" }, "Sub")).toBe(true);
  });

  test("finds intrinsic nested in object", () => {
    const value = { foo: { bar: { __intrinsic: "Ref", name: "x" } } };
    expect(hasIntrinsicInValue(value, "Ref")).toBe(true);
  });

  test("finds intrinsic in array", () => {
    const value = [1, { __intrinsic: "If" }, "hello"];
    expect(hasIntrinsicInValue(value, "If")).toBe(true);
  });

  test("returns false for missing intrinsic", () => {
    const value = { __intrinsic: "Sub", template: "hello" };
    expect(hasIntrinsicInValue(value, "Ref")).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(hasIntrinsicInValue(null, "Sub")).toBe(false);
    expect(hasIntrinsicInValue(undefined, "Sub")).toBe(false);
  });

  test("returns false for primitives", () => {
    expect(hasIntrinsicInValue("hello", "Sub")).toBe(false);
    expect(hasIntrinsicInValue(42, "Sub")).toBe(false);
  });
});

describe("irUsesIntrinsic", () => {
  test("finds intrinsic in resource properties", () => {
    const ir: TemplateIR = {
      resources: [
        { logicalId: "A", type: "T::A", properties: { x: { __intrinsic: "Sub", template: "hi" } } },
      ],
      parameters: [],
    };
    expect(irUsesIntrinsic(ir, "Sub")).toBe(true);
    expect(irUsesIntrinsic(ir, "Ref")).toBe(false);
  });

  test("returns false for empty IR", () => {
    const ir: TemplateIR = { resources: [], parameters: [] };
    expect(irUsesIntrinsic(ir, "Sub")).toBe(false);
  });
});

describe("collectDependencies", () => {
  const awsPredicate = (obj: Record<string, unknown>): string | null => {
    if (obj.__intrinsic === "Ref") {
      const name = obj.name as string;
      return name.startsWith("AWS::") ? null : name;
    }
    if (obj.__intrinsic === "GetAtt") {
      return obj.logicalId as string;
    }
    return null;
  };

  test("collects Ref dependencies", () => {
    const value = { x: { __intrinsic: "Ref", name: "MyBucket" } };
    const deps = collectDependencies(value, awsPredicate);
    expect(deps).toEqual(new Set(["MyBucket"]));
  });

  test("collects GetAtt dependencies", () => {
    const value = { x: { __intrinsic: "GetAtt", logicalId: "MyBucket", attribute: "Arn" } };
    const deps = collectDependencies(value, awsPredicate);
    expect(deps).toEqual(new Set(["MyBucket"]));
  });

  test("skips AWS:: pseudo-parameters", () => {
    const value = { x: { __intrinsic: "Ref", name: "AWS::Region" } };
    const deps = collectDependencies(value, awsPredicate);
    expect(deps.size).toBe(0);
  });

  test("collects from nested arrays and objects", () => {
    const value = {
      a: [
        { __intrinsic: "Ref", name: "A" },
        { nested: { __intrinsic: "GetAtt", logicalId: "B", attribute: "Arn" } },
      ],
    };
    const deps = collectDependencies(value, awsPredicate);
    expect(deps).toEqual(new Set(["A", "B"]));
  });

  test("deduplicates", () => {
    const value = [
      { __intrinsic: "Ref", name: "A" },
      { __intrinsic: "Ref", name: "A" },
    ];
    const deps = collectDependencies(value, awsPredicate);
    expect(deps).toEqual(new Set(["A"]));
  });
});
