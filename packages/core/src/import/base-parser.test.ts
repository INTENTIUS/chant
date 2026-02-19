import { describe, expect, test } from "bun:test";
import { BaseValueParser } from "./base-parser";

/**
 * Mock parser that recognizes {"UPPER": value} as an intrinsic.
 */
class MockParser extends BaseValueParser {
  protected dispatchIntrinsic(
    key: string,
    value: unknown,
    _obj: Record<string, unknown>,
  ): unknown | null {
    if (key === "UPPER") {
      return { __intrinsic: "UPPER", value: this.parseValue(value) };
    }
    return null;
  }
}

describe("BaseValueParser", () => {
  const parser = new MockParser();

  test("returns null/undefined as-is", () => {
    expect(parser.parseValue(null)).toBeNull();
    expect(parser.parseValue(undefined)).toBeUndefined();
  });

  test("returns primitives as-is", () => {
    expect(parser.parseValue("hello")).toBe("hello");
    expect(parser.parseValue(42)).toBe(42);
    expect(parser.parseValue(true)).toBe(true);
  });

  test("recurses into arrays", () => {
    expect(parser.parseValue([1, "two", null])).toEqual([1, "two", null]);
  });

  test("dispatches single-key intrinsic", () => {
    expect(parser.parseValue({ UPPER: "hello" })).toEqual({
      __intrinsic: "UPPER",
      value: "hello",
    });
  });

  test("recurses into intrinsic values", () => {
    expect(parser.parseValue({ UPPER: { UPPER: "nested" } })).toEqual({
      __intrinsic: "UPPER",
      value: { __intrinsic: "UPPER", value: "nested" },
    });
  });

  test("falls through for unknown single-key objects", () => {
    expect(parser.parseValue({ unknown: "value" })).toEqual({ unknown: "value" });
  });

  test("recurses into multi-key objects", () => {
    const result = parser.parseValue({ a: 1, b: { UPPER: "x" } });
    expect(result).toEqual({ a: 1, b: { __intrinsic: "UPPER", value: "x" } });
  });

  test("recurses arrays inside objects", () => {
    const result = parser.parseValue({ items: [{ UPPER: "a" }, "plain"] });
    expect(result).toEqual({
      items: [{ __intrinsic: "UPPER", value: "a" }, "plain"],
    });
  });
});
