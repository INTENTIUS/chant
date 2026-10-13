/**
 * Editing one property of a JSON or JSONC document in place (#3308): the
 * rest of the text is left as it was, comments and trailing commas included.
 */

import { describe, expect, test } from "vitest";
import { removeProperty, setProperty, valueAt } from "./json-edit";
import { parseJsonText } from "./jsonc";

const read = (text: string, jsonc = false) => {
  const r = parseJsonText(text, { jsonc });
  if (!r.ok) throw new Error(r.message);
  return r.value;
};

const JSON_TEXT = `{
    "name": "w",
    "members": [
        { "name": "a", "box": { "services": [] } },
        {
            "name": "b",
            "box": {
                "intent": "ws-001"
            }
        }
    ]
}
`;

const JSONC_TEXT = `{
  // the workspace
  "name": "w",
  "members": [
    {
      "name": "b",
      "box": {
        "listing": {
          "title": "Old", // kept as is
          "line": "one line",
        },
      },
    },
  ],
}
`;

describe("setProperty", () => {
  test("replaces a value in place and leaves every other byte", () => {
    const out = setProperty(JSON_TEXT, false, "/members/1/box", "intent", "ws-002");
    expect(out).toBe(JSON_TEXT.replace('"ws-001"', '"ws-002"'));
  });

  test("adds a key after the last one, indented like it, and an object value on its own lines", () => {
    const out = setProperty(JSON_TEXT, false, "/members/1/box", "listing", { title: "B", published: false });
    expect(out).toContain(`                "intent": "ws-001",\n                "listing": {\n                    "title": "B",\n                    "published": false\n                }\n            }`);
    expect(read(out)).toEqual({ ...(read(JSON_TEXT) as object), members: [{ name: "a", box: { services: [] } }, { name: "b", box: { intent: "ws-001", listing: { title: "B", published: false } } }] });
  });

  test("keeps an object on one line on one line", () => {
    const out = setProperty(JSON_TEXT, false, "/members/0/box", "listing", { title: "A" });
    expect(out).toContain(`{ "name": "a", "box": { "services": [], "listing": {"title":"A"} } }`);
    expect(valueAt(read(out), "/members/0/box/listing")).toEqual({ title: "A" });
  });

  test("fills an empty object", () => {
    const out = setProperty('{\n  "box": {}\n}\n', false, "/box", "listing", { title: "T" });
    expect(out).toBe('{\n  "box": {\n    "listing": {\n      "title": "T"\n    }\n  }\n}\n');
  });

  test("in JSONC, keeps comments with their lines and the trailing comma style", () => {
    const out = setProperty(JSONC_TEXT, true, "/members/0/box/listing", "published", false);
    expect(out).toContain(`          "line": "one line",\n          "published": false,\n        },`);
    const out2 = setProperty(JSONC_TEXT, true, "/members/0/box/listing", "title", "New");
    expect(out2).toBe(JSONC_TEXT.replace('"Old"', '"New"'));
    expect(out2).toContain("// kept as is");
  });

  test("puts a new key after a comment that ends the last property's line", () => {
    const text = '{\n  "a": 1, // one\n  "b": 2 // two\n}\n';
    const out = setProperty(text, true, "", "c", 3);
    expect(out).toBe('{\n  "a": 1, // one\n  "b": 2, // two\n  "c": 3\n}\n');
  });

  test("keeps CRLF line endings", () => {
    const text = '{\r\n  "box": {\r\n    "intent": "x"\r\n  }\r\n}\r\n';
    const out = setProperty(text, false, "/box", "listing", { title: "T" });
    expect(out).toBe('{\r\n  "box": {\r\n    "intent": "x",\r\n    "listing": {\r\n      "title": "T"\r\n    }\r\n  }\r\n}\r\n');
  });

  test("refuses when there is no object at the pointer", () => {
    expect(() => setProperty(JSON_TEXT, false, "/members/5/box", "listing", {})).toThrow(/no object at \/members\/5\/box/);
  });
});

describe("removeProperty", () => {
  test("removes a key with the comma after it, and its line", () => {
    const text = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n';
    expect(removeProperty(text, false, "", "b")).toBe('{\n  "a": 1,\n  "c": 3\n}\n');
  });

  test("removes the last key with the comma before it", () => {
    const text = '{\n  "a": 1,\n  "b": 2\n}\n';
    expect(removeProperty(text, false, "", "b")).toBe('{\n  "a": 1\n}\n');
  });

  test("removes a key on a one-line object", () => {
    expect(removeProperty('{ "a": 1, "b": 2 }', false, "", "a")).toBe('{ "b": 2 }');
    expect(removeProperty('{ "a": 1, "b": 2 }', false, "", "b")).toBe('{ "a": 1 }');
  });

  test("leaves {} when the only key goes, and the text unchanged when the key is not there", () => {
    expect(removeProperty('{\n  "box": {\n    "listing": {\n      "a": 1\n    }\n  }\n}', false, "/box/listing", "a")).toBe('{\n  "box": {\n    "listing": {}\n  }\n}');
    expect(removeProperty('{ "a": 1 }', false, "", "z")).toBe('{ "a": 1 }');
  });

  test("in JSONC, removes a key with its trailing comma and keeps the comments of the others", () => {
    const out = removeProperty(JSONC_TEXT, true, "/members/0/box/listing", "line");
    expect(out).toContain(`"title": "Old", // kept as is\n        },`);
    expect(valueAt(read(out, true), "/members/0/box/listing")).toEqual({ title: "Old" });
  });
});
