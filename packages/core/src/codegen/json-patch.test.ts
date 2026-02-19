import { describe, test, expect } from "bun:test";
import { rfc6902Apply } from "./json-patch";

describe("rfc6902Apply", () => {
  test("add to object", () => {
    const doc = JSON.stringify({ a: 1 });
    const patch = JSON.stringify([{ op: "add", path: "/b", value: 2 }]);
    expect(JSON.parse(rfc6902Apply(doc, patch))).toEqual({ a: 1, b: 2 });
  });

  test("add to nested object", () => {
    const doc = JSON.stringify({ a: { b: 1 } });
    const patch = JSON.stringify([{ op: "add", path: "/a/c", value: 2 }]);
    expect(JSON.parse(rfc6902Apply(doc, patch))).toEqual({ a: { b: 1, c: 2 } });
  });

  test("add to array with -", () => {
    const doc = JSON.stringify({ a: [1, 2] });
    const patch = JSON.stringify([{ op: "add", path: "/a/-", value: 3 }]);
    expect(JSON.parse(rfc6902Apply(doc, patch))).toEqual({ a: [1, 2, 3] });
  });

  test("add to array by index", () => {
    const doc = JSON.stringify({ a: [1, 3] });
    const patch = JSON.stringify([{ op: "add", path: "/a/1", value: 2 }]);
    expect(JSON.parse(rfc6902Apply(doc, patch))).toEqual({ a: [1, 2, 3] });
  });

  test("add replaces root when path is empty", () => {
    const doc = JSON.stringify({ a: 1 });
    const patch = JSON.stringify([{ op: "add", path: "", value: { b: 2 } }]);
    expect(JSON.parse(rfc6902Apply(doc, patch))).toEqual({ b: 2 });
  });

  test("remove from object", () => {
    const doc = JSON.stringify({ a: 1, b: 2 });
    const patch = JSON.stringify([{ op: "remove", path: "/b" }]);
    expect(JSON.parse(rfc6902Apply(doc, patch))).toEqual({ a: 1 });
  });

  test("remove from array", () => {
    const doc = JSON.stringify({ a: [1, 2, 3] });
    const patch = JSON.stringify([{ op: "remove", path: "/a/1" }]);
    expect(JSON.parse(rfc6902Apply(doc, patch))).toEqual({ a: [1, 3] });
  });

  test("remove root throws", () => {
    const doc = JSON.stringify({ a: 1 });
    const patch = JSON.stringify([{ op: "remove", path: "" }]);
    expect(() => rfc6902Apply(doc, patch)).toThrow("cannot remove root");
  });

  test("replace in object", () => {
    const doc = JSON.stringify({ a: 1, b: 2 });
    const patch = JSON.stringify([{ op: "replace", path: "/a", value: 99 }]);
    expect(JSON.parse(rfc6902Apply(doc, patch))).toEqual({ a: 99, b: 2 });
  });

  test("replace in array", () => {
    const doc = JSON.stringify({ a: [1, 2, 3] });
    const patch = JSON.stringify([{ op: "replace", path: "/a/1", value: 99 }]);
    expect(JSON.parse(rfc6902Apply(doc, patch))).toEqual({ a: [1, 99, 3] });
  });

  test("replace root when path is empty", () => {
    const doc = JSON.stringify({ a: 1 });
    const patch = JSON.stringify([{ op: "replace", path: "", value: 42 }]);
    expect(rfc6902Apply(doc, patch)).toBe("42");
  });

  test("replace non-existent key throws", () => {
    const doc = JSON.stringify({ a: 1 });
    const patch = JSON.stringify([{ op: "replace", path: "/b", value: 2 }]);
    expect(() => rfc6902Apply(doc, patch)).toThrow('key "b" not found for replace');
  });

  test("test operation is a no-op", () => {
    const doc = JSON.stringify({ a: 1 });
    const patch = JSON.stringify([{ op: "test", path: "/a", value: 1 }]);
    expect(JSON.parse(rfc6902Apply(doc, patch))).toEqual({ a: 1 });
  });

  test("multiple operations in sequence", () => {
    const doc = JSON.stringify({ a: 1 });
    const patch = JSON.stringify([
      { op: "add", path: "/b", value: 2 },
      { op: "replace", path: "/a", value: 10 },
      { op: "remove", path: "/b" },
    ]);
    expect(JSON.parse(rfc6902Apply(doc, patch))).toEqual({ a: 10 });
  });

  test("unsupported operation throws", () => {
    const doc = JSON.stringify({ a: 1 });
    const patch = JSON.stringify([{ op: "unknown", path: "/a" }]);
    expect(() => rfc6902Apply(doc, patch)).toThrow('unsupported operation "unknown"');
  });

  test("handles JSON pointer escaping (~0 and ~1)", () => {
    const doc = JSON.stringify({ "a/b": 1, "c~d": 2 });
    const patch = JSON.stringify([
      { op: "replace", path: "/a~1b", value: 10 },
      { op: "replace", path: "/c~0d", value: 20 },
    ]);
    expect(JSON.parse(rfc6902Apply(doc, patch))).toEqual({ "a/b": 10, "c~d": 20 });
  });

  test("deeply nested add", () => {
    const doc = JSON.stringify({ a: { b: { c: {} } } });
    const patch = JSON.stringify([{ op: "add", path: "/a/b/c/d", value: "deep" }]);
    expect(JSON.parse(rfc6902Apply(doc, patch))).toEqual({ a: { b: { c: { d: "deep" } } } });
  });
});
