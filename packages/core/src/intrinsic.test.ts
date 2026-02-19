import { describe, test, expect } from "bun:test";
import { INTRINSIC_MARKER, resolveIntrinsicValue, isIntrinsic } from "./intrinsic";

describe("resolveIntrinsicValue", () => {
  test("returns primitives as-is", () => {
    expect(resolveIntrinsicValue(42)).toBe(42);
    expect(resolveIntrinsicValue("hello")).toBe("hello");
    expect(resolveIntrinsicValue(true)).toBe(true);
    expect(resolveIntrinsicValue(null)).toBe(null);
    expect(resolveIntrinsicValue(undefined)).toBe(undefined);
  });

  test("returns plain objects as-is", () => {
    const obj = { a: 1 };
    expect(resolveIntrinsicValue(obj)).toBe(obj);
  });

  test("calls toJSON on intrinsic objects", () => {
    const intrinsic = {
      [INTRINSIC_MARKER]: true as const,
      toJSON: () => ({ Ref: "MyResource" }),
    };
    expect(resolveIntrinsicValue(intrinsic)).toEqual({ Ref: "MyResource" });
  });

  test("recurses into arrays", () => {
    const intrinsic = {
      [INTRINSIC_MARKER]: true as const,
      toJSON: () => ({ Ref: "A" }),
    };
    const result = resolveIntrinsicValue(["hello", intrinsic, 42]);
    expect(result).toEqual(["hello", { Ref: "A" }, 42]);
  });

  test("recurses into nested arrays", () => {
    const intrinsic = {
      [INTRINSIC_MARKER]: true as const,
      toJSON: () => "resolved",
    };
    const result = resolveIntrinsicValue([[intrinsic], "plain"]);
    expect(result).toEqual([["resolved"], "plain"]);
  });

  test("does not call toJSON on non-intrinsic objects with toJSON", () => {
    const obj = { toJSON: () => "should not be called" };
    expect(resolveIntrinsicValue(obj)).toBe(obj);
  });

  test("handles intrinsic without toJSON gracefully", () => {
    const intrinsic = { [INTRINSIC_MARKER]: true as const };
    expect(resolveIntrinsicValue(intrinsic)).toBe(intrinsic);
  });
});

describe("isIntrinsic", () => {
  test("returns true for intrinsic objects", () => {
    const intrinsic = {
      [INTRINSIC_MARKER]: true as const,
      toJSON: () => ({}),
    };
    expect(isIntrinsic(intrinsic)).toBe(true);
  });

  test("returns false for plain objects", () => {
    expect(isIntrinsic({})).toBe(false);
    expect(isIntrinsic(null)).toBe(false);
    expect(isIntrinsic("string")).toBe(false);
  });
});
