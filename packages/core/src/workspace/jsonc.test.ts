import { describe, expect, test } from "vitest";
import { parseJsonText } from "./jsonc";

const json = { jsonc: false };
const jsonc = { jsonc: true };

describe("parseJsonText (#2534)", () => {
  test("reads what JSON.parse reads", () => {
    const text = '{ "a": [1, -2.5e3, true, false, null, "x\\n\\u00e9"], "b": {} }';
    const r = parseJsonText(text, json);
    expect(r.ok && r.value).toEqual(JSON.parse(text));
  });

  test("locates values and keys by JSON Pointer, and falls back to the nearest ancestor", () => {
    const r = parseJsonText('{\n  "members": [\n    { "name": "a" },\n    { "a/b": 1 }\n  ]\n}\n', json);
    if (!r.ok) throw new Error(r.message);
    expect(r.locate("/members/0/name")).toEqual({ line: 3, column: 15 });
    expect(r.locate("/members/0/name", true)).toEqual({ line: 3, column: 7 });
    expect(r.locate("/members/1/a~1b", true)).toEqual({ line: 4, column: 7 });
    expect(r.locate("/members/1/missing")).toEqual({ line: 4, column: 5 });
    expect(r.locate("")).toEqual({ line: 1, column: 1 });
  });

  test("names the line and column of a syntax error", () => {
    const r = parseJsonText('{\n  "name": "a",\n  "schema": 1\n  "members": []\n}', json);
    expect(r).toMatchObject({ ok: false, location: { line: 4, column: 3 } });
    if (!r.ok) expect(r.message).toMatch(/expected "," or "}"/);
  });

  test("never reads an empty or blank file as a value", () => {
    for (const text of ["", "  \n", "﻿"]) {
      expect(parseJsonText(text, json)).toMatchObject({ ok: false, message: "the file is empty" });
    }
  });

  test("refuses duplicate keys at the second key", () => {
    const r = parseJsonText('{ "a": 1,\n  "a": 2 }', json);
    expect(r).toMatchObject({ ok: false, location: { line: 2, column: 3 } });
    if (!r.ok) expect(r.message).toBe('duplicate key "a"');
  });

  test("comments and trailing commas only in jsonc", () => {
    const text = '// a workspace\n{ "a": [1, 2,], /* note */ "b": 1, }\n';
    expect(parseJsonText(text, jsonc)).toMatchObject({ ok: true, value: { a: [1, 2], b: 1 } });
    const strict = parseJsonText(text, json);
    expect(strict).toMatchObject({ ok: false, location: { line: 1, column: 1 } });
    if (!strict.ok) expect(strict.message).toMatch(/only allowed in chant\.workspace\.jsonc/);
    const comma = parseJsonText('{ "a": 1, }', json);
    if (!comma.ok) expect(comma.message).toMatch(/trailing comma/);
    expect(comma.ok).toBe(false);
  });

  test("refuses what JSON refuses", () => {
    for (const text of ["{ a: 1 }", "{ 'a': 1 }", '{ "a": 01 }', '{ "a": "\t" }', "[1] [2]", '{ "a": NaN }', '"unterminated']) {
      expect(parseJsonText(text, jsonc).ok, text).toBe(false);
    }
  });

  test("a __proto__ key is data, not a prototype", () => {
    const r = parseJsonText('{ "__proto__": { "polluted": true } }', json);
    if (!r.ok) throw new Error(r.message);
    expect(Object.keys(r.value as object)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
