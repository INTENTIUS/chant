import { describe, expect, test } from "vitest";
import * as upstream from "js-yaml";
import { FLOAT_TYPE, INT_TYPE, load, MAP_TYPE, NULL_TYPE, SEQ_TYPE, STR_TYPE, YAMLException } from "./js-yaml-load";

const BOOL_TYPE = {
  tag: "tag:yaml.org,2002:bool",
  kind: "scalar",
  resolve: (d: string | null) => d !== null && /^(?:true|True|TRUE|false|False|FALSE)$/.test(d),
  construct: (d: string) => /^(?:true|True|TRUE)$/.test(d),
};
const MERGE_TYPE = { tag: "tag:yaml.org,2002:merge", kind: "scalar", resolve: (d: string | null) => d === "<<" || d === null };

const TYPES = {
  implicit: [NULL_TYPE, BOOL_TYPE, INT_TYPE, FLOAT_TYPE, MERGE_TYPE],
  explicit: [STR_TYPE, SEQ_TYPE, MAP_TYPE],
};

/** Documents spanning the loader's paths: block and flow collections, every scalar style, anchors, tags, merge keys. */
const OPTIONS = { schema: upstream.CORE_SCHEMA.extend({ implicit: [new upstream.Type("tag:yaml.org,2002:merge", { kind: "scalar", resolve: (d: string | null) => d === "<<" || d === null })] }), json: true };

const VALID = [
  "",
  "a: 1\nb: [1, 2, {c: d}]\n",
  "- a\n- b: 1\n  c: 2\n-\n  - x\n  - y\n",
  "s: 'it''s'\nd: \"tab\\t \\u00e9 \\x41 \\\n  folded\"\n",
  "lit: |\n  one\n  two\n\nfold: >-\n  a\n  b\n\n  c\nkeep: |+\n  x\n\n",
  "base: &b {x: 1}\nuse: *b\nm:\n  <<: *b\n  y: 2\n",
  "n: ~\nm: null\nt: true\nT: True\nf: FALSE\nyes_: yes\n",
  "big: 1e999\nz: 0x\ny: -0\n",
  "i: 12\nh: 0x1F\no: 0o17\nbin: 0b101\nu: 1_000\nneg: -5\nfl: 1.5e3\ninf: .inf\nnan: .NaN\nd: .5\n",
  "? complex\n: value\n? [a, b]\n: seq key\n",
  "!!str 123: !!int '7'\nq: !!map {a: 1}\nz: !!seq [1]\n",
  "key with spaces: value # comment\n# full comment\nother: 'x' # trailing\n",
  "multi: first line\n  second line\n  third\n",
  "a:\n  b:\n    c:\n      - 1\n      - 2\n",
  "dup: 1\ndup: 2\n",
  "{a: 1, b: [x, y], c: {d: e}}",
  "[1, 2, 3]",
  "\ufeffa: bom\n",
  "a: 1\r\nb: 2\r\n",
  "%YAML 1.2\n---\na: 1\n",
  "__proto__: 1\nconstructor: 2\n",
  "emoji: \"\\U0001F600\"\nunicode: héllo ✓\n",
];

const INVALID = [
  "[".repeat(200),
  "a: 99999999999999999999999999\n" + "b: " + "[".repeat(150) + "]".repeat(150) + "\n",
  "a: 1\njust text\nb: 2\n",
  "a: [1, 2\n",
  "a: 'unterminated\n",
  "a: &x 1\nb: *y\n",
  "- a\nb: 1\n",
  "a:\n\t- b\n",
  "a: !!binary x\n",
  "a: 1\n---\nb: 2\n",
  "a: \"bad \\q escape\"\n",
  "a: b: c\n",
  "a\u0000b: 1\n",
  "{a: 1, a",
  "%YAML 1.2\n%YAML 1.2\n---\na: 1\n",
];

function outcome(fn: () => unknown): { ok: true; value: unknown } | { ok: false; reason: string; line: number | undefined } {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    const e = err as { reason: string; mark?: { line: number; column: number; position: number } };
    return { ok: false, reason: e.reason, line: e.mark?.line };
  }
}

describe("vendored js-yaml loader", () => {
  for (const text of VALID) {
    test(`reads ${JSON.stringify(text.slice(0, 40))} as js-yaml does`, () => {
      const mine = outcome(() => load(text, TYPES));
      const theirs = outcome(() => upstream.load(text, OPTIONS));
      expect(mine.ok).toBe(true);
      expect(mine).toEqual(theirs);
    });
  }

  for (const text of INVALID) {
    test(`rejects ${JSON.stringify(text.slice(0, 40))} with js-yaml's reason and line`, () => {
      const mine = outcome(() => load(text, TYPES));
      const theirs = outcome(() => upstream.load(text, OPTIONS));
      expect(mine.ok).toBe(false);
      expect(mine).toEqual(theirs);
    });
  }

  test("throws YAMLException carrying a reason and a position", () => {
    try {
      load("a: [1\n", TYPES);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(YAMLException);
      expect((err as YAMLException).reason).toBeTruthy();
      expect((err as { mark: { line: number } }).mark.line).toBe(1);
    }
  });

  test("an empty stream is undefined", () => {
    expect(load("", TYPES)).toBeUndefined();
    expect(load("# only a comment\n", TYPES)).toBeNull();
  });

  test("a custom multi tag type is consulted by prefix", () => {
    const types = {
      implicit: TYPES.implicit,
      explicit: [...TYPES.explicit, { tag: "!", kind: "scalar", multi: true, construct: (d: string, tag: string) => `${tag}:${d}` }],
    };
    expect(load("a: !Ref x\n", types)).toEqual({ a: "!Ref:x" });
  });
});
