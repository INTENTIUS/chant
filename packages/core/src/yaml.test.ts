import { describe, expect, test } from "bun:test";
import { emitYAML, parseYAML, parseScalar } from "./yaml";

// ---------------------------------------------------------------------------
// emitYAML
// ---------------------------------------------------------------------------
describe("emitYAML", () => {
  test("null", () => {
    expect(emitYAML(null, 0)).toBe("null");
    expect(emitYAML(undefined, 0)).toBe("null");
  });

  test("booleans", () => {
    expect(emitYAML(true, 0)).toBe("true");
    expect(emitYAML(false, 0)).toBe("false");
  });

  test("numbers", () => {
    expect(emitYAML(42, 0)).toBe("42");
    expect(emitYAML(3.14, 0)).toBe("3.14");
  });

  test("plain strings", () => {
    expect(emitYAML("hello", 0)).toBe("hello");
  });

  test("strings requiring quoting", () => {
    // boolean-like
    expect(emitYAML("true", 0)).toBe("'true'");
    expect(emitYAML("yes", 0)).toBe("'yes'");
    // colon-space
    expect(emitYAML("key: value", 0)).toBe("'key: value'");
    // hash
    expect(emitYAML("a # comment", 0)).toBe("'a # comment'");
    // leading special chars
    expect(emitYAML("$VAR", 0)).toBe("'$VAR'");
    expect(emitYAML("!ref", 0)).toBe("'!ref'");
    expect(emitYAML("*alias", 0)).toBe("'*alias'");
    expect(emitYAML("{obj}", 0)).toBe("'{obj}'");
    expect(emitYAML("[arr]", 0)).toBe("'[arr]'");
    // leading digit
    expect(emitYAML("123abc", 0)).toBe("'123abc'");
    // empty string
    expect(emitYAML("", 0)).toBe("''");
  });

  test("single-quote escaping", () => {
    // A string that needs quoting (leading digit) AND contains a single quote
    expect(emitYAML("1's", 0)).toBe("'1''s'");
  });

  test("empty array", () => {
    expect(emitYAML([], 0)).toBe("[]");
  });

  test("simple array", () => {
    const result = emitYAML(["a", "b"], 0);
    expect(result).toBe("\n- a\n- b");
  });

  test("array of objects inlines first key on dash line", () => {
    const result = emitYAML([{ name: "x", value: 1 }], 0);
    expect(result).toContain("- name: x");
    expect(result).toContain("  value: 1");
  });

  test("empty object", () => {
    expect(emitYAML({}, 0)).toBe("{}");
  });

  test("nested object", () => {
    const result = emitYAML({ a: { b: 1 } }, 0);
    expect(result).toContain("a:");
    expect(result).toContain("  b: 1");
  });

  test("tagged value with array", () => {
    const result = emitYAML({ tag: "!reference", value: [".base", "script"] }, 0);
    expect(result).toBe("!reference [.base, script]");
  });

  test("tagged value with scalar", () => {
    const result = emitYAML({ tag: "!include", value: "file.yml" }, 0);
    expect(result).toBe("!include file.yml");
  });

  test("indentation at depth", () => {
    const result = emitYAML({ key: "val" }, 1);
    expect(result).toBe("\n  key: val");
  });
});

// ---------------------------------------------------------------------------
// parseYAML
// ---------------------------------------------------------------------------
describe("parseYAML", () => {
  test("JSON passthrough", () => {
    const result = parseYAML('{"a": 1}');
    expect(result).toEqual({ a: 1 });
  });

  test("simple key-value", () => {
    const result = parseYAML("name: hello\ncount: 42");
    expect(result).toEqual({ name: "hello", count: 42 });
  });

  test("nested object", () => {
    const result = parseYAML("parent:\n  child: value");
    expect(result).toEqual({ parent: { child: "value" } });
  });

  test("block array", () => {
    const result = parseYAML("items:\n  - a\n  - b\n  - c");
    expect(result).toEqual({ items: ["a", "b", "c"] });
  });

  test("inline array", () => {
    const result = parseYAML('items: ["a", "b"]');
    expect(result).toEqual({ items: ["a", "b"] });
  });

  test("inline object", () => {
    const result = parseYAML('data: {"x": 1}');
    expect(result).toEqual({ data: { x: 1 } });
  });

  test("comments and blank lines are skipped", () => {
    const result = parseYAML("# comment\na: 1\n\n# another\nb: 2");
    expect(result).toEqual({ a: 1, b: 2 });
  });

  test("scalar coercion", () => {
    const result = parseYAML("a: true\nb: false\nc: null\nd: yes\ne: no\nf: ~");
    expect(result).toEqual({ a: true, b: false, c: null, d: true, e: false, f: null });
  });

  test("quoted strings preserve value", () => {
    const result = parseYAML("a: 'true'\nb: \"42\"");
    expect(result).toEqual({ a: "true", b: "42" });
  });

  test("handles CRLF line endings", () => {
    const result = parseYAML("apiVersion: v1\r\nkind: Pod\r\nmetadata:\r\n  name: test\r\n");
    expect(result).toEqual({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "test" },
    });
  });

  test("handles bare CR line endings", () => {
    const result = parseYAML("a: 1\rb: 2\r");
    expect(result).toEqual({ a: 1, b: 2 });
  });

  test("array of objects", () => {
    const result = parseYAML("items:\n  - name: x\n    value: 1\n  - name: y\n    value: 2");
    expect(result).toEqual({
      items: [
        { name: "x", value: 1 },
        { name: "y", value: 2 },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// parseScalar
// ---------------------------------------------------------------------------
describe("parseScalar", () => {
  test("null variants", () => {
    expect(parseScalar("")).toBe(null);
    expect(parseScalar("~")).toBe(null);
    expect(parseScalar("null")).toBe(null);
  });

  test("boolean variants", () => {
    expect(parseScalar("true")).toBe(true);
    expect(parseScalar("yes")).toBe(true);
    expect(parseScalar("false")).toBe(false);
    expect(parseScalar("no")).toBe(false);
  });

  test("numbers", () => {
    expect(parseScalar("42")).toBe(42);
    expect(parseScalar("3.14")).toBe(3.14);
  });

  test("plain strings", () => {
    expect(parseScalar("hello")).toBe("hello");
  });
});
