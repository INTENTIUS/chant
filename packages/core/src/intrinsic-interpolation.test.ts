import { describe, expect, test } from "bun:test";
import { buildInterpolatedString, defaultInterpolationSerializer } from "./intrinsic-interpolation";
import { AttrRef } from "./attrref";
import { INTRINSIC_MARKER } from "./intrinsic";
import { DECLARABLE_MARKER } from "./declarable";

describe("buildInterpolatedString", () => {
  test("joins parts and values with serializer", () => {
    const result = buildInterpolatedString(
      ["Hello ", " world ", "!"],
      ["foo", "bar"],
      (v) => `<${v}>`,
    );
    expect(result).toBe("Hello <foo> world <bar>!");
  });

  test("handles no values", () => {
    const result = buildInterpolatedString(
      ["just text"],
      [],
      () => { throw new Error("should not be called"); },
    );
    expect(result).toBe("just text");
  });

  test("handles empty parts", () => {
    const result = buildInterpolatedString(
      ["", ""],
      ["only"],
      (v) => String(v),
    );
    expect(result).toBe("only");
  });
});

describe("defaultInterpolationSerializer", () => {
  const serialize = defaultInterpolationSerializer(
    (name, attr) => `\${${name}.${attr}}`,
    (ref) => `\${${ref}}`,
  );

  test("serializes AttrRef", () => {
    const parent = {};
    const ref = new AttrRef(parent, "Arn");
    ref._setLogicalName("MyBucket");

    expect(serialize(ref)).toBe("${MyBucket.Arn}");
  });

  test("throws for AttrRef without logical name", () => {
    const parent = {};
    const ref = new AttrRef(parent, "Arn");

    expect(() => serialize(ref)).toThrow("logical name not set");
  });

  test("serializes Intrinsic with Ref toJSON", () => {
    const intrinsic = {
      [INTRINSIC_MARKER]: true as const,
      toJSON: () => ({ Ref: "AWS::Region" }),
    };

    expect(serialize(intrinsic)).toBe("${AWS::Region}");
  });

  test("serializes Intrinsic with non-Ref toJSON as String", () => {
    const intrinsic = {
      [INTRINSIC_MARKER]: true as const,
      toJSON: () => ({ "Fn::Sub": "hello" }),
      toString: () => "[SubIntrinsic]",
    };

    expect(serialize(intrinsic)).toBe("[SubIntrinsic]");
  });

  test("throws for Declarable", () => {
    const declarable = {
      [DECLARABLE_MARKER]: true as const,
      lexicon: "test",
      entityType: "Bucket",
    };

    expect(() => serialize(declarable)).toThrow("Cannot embed Declarable");
  });

  test("serializes primitives via String()", () => {
    expect(serialize("hello")).toBe("hello");
    expect(serialize(42)).toBe("42");
    expect(serialize(true)).toBe("true");
  });
});
