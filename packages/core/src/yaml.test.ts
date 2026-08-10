import { describe, expect, test } from "vitest";
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

  test("multiline string emits as | block scalar", () => {
    const result = emitYAML("line1\nline2\nline3", 0);
    expect(result).toBe("|\nline1\nline2\nline3");
  });

  test("multiline string trims trailing empty line", () => {
    // Template literals often end with \n producing a trailing empty line
    const result = emitYAML("line1\nline2\n", 0);
    expect(result).toBe("|\nline1\nline2");
  });

  test("multiline string inside object value is properly indented", () => {
    const result = emitYAML({ config: "line1\nline2\nline3" }, 0);
    expect(result).toContain("config: |\n  line1\n  line2\n  line3");
  });

  test("multiline string inside array item is properly indented", () => {
    const result = emitYAML([{ data: "a\nb" }], 0);
    expect(result).toContain("data: |\n    a\n    b");
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

// Block scalars (#910) — round-trip parity with js-yaml for literal/folded/chomping,
// including block scalars nested inside array items (the case that mis-parsed).
describe("parseYAML block scalars (#910)", () => {
  test("top-level literal | keeps newlines, clips to one trailing", () => {
    expect(parseYAML("run: |\n  line1\n  line2\n")).toEqual({ run: "line1\nline2\n" });
  });

  test("literal | nested inside a later array item (the reported bug)", () => {
    expect(
      parseYAML("steps:\n  - name: first\n    run: echo hi\n  - name: second\n    run: |\n      line1\n      line2\n"),
    ).toEqual({
      steps: [
        { name: "first", run: "echo hi" },
        { name: "second", run: "line1\nline2\n" },
      ],
    });
  });

  test("block scalar as an array item's first key, with a sibling key after", () => {
    expect(parseYAML("steps:\n  - run: |\n      a\n      b\n    name: x\n")).toEqual({
      steps: [{ run: "a\nb\n", name: "x" }],
    });
  });

  test("strip |- drops the trailing newline; a sibling key after still parses", () => {
    expect(parseYAML("a: |-\n  x\n  y\nb: 2\n")).toEqual({ a: "x\ny", b: 2 });
  });

  test("folded > folds line breaks to spaces, blank line to one newline", () => {
    expect(parseYAML("msg: >\n  a\n  b\n\n  c\n")).toEqual({ msg: "a b\nc\n" });
  });

  // #1482 — a block scalar as the sequence ITEM itself (`- |`), not as an
  // item key's value. The header parsed as the literal string "|" and the
  // body lines leaked upward: inside a container list, every key after
  // `args:` — securityContext, even the following `containers:` — was
  // hoisted to the document root, so the post-synth security checks read a
  // manifest that had quietly lost the app containers.
  test("literal | as a sequence item (#1482)", () => {
    expect(parseYAML("args:\n  - |\n    set -eu\n    echo done\n")).toEqual({
      args: ["set -eu\necho done\n"],
    });
  });

  test("the #1482 shape: keys after a block-scalar arg stay on the item, and later keys stay nested", () => {
    const doc = [
      "spec:",
      "  initContainers:",
      "    - name: wait",
      "      args:",
      "        - |",
      "          line one",
      "          line two",
      "      securityContext:",
      "        runAsNonRoot: true",
      "  containers:",
      "    - name: app",
      "      image: x:1",
      "",
    ].join("\n");
    expect(parseYAML(doc)).toEqual({
      spec: {
        initContainers: [
          {
            name: "wait",
            args: ["line one\nline two\n"],
            securityContext: { runAsNonRoot: true },
          },
        ],
        containers: [{ name: "app", image: "x:1" }],
      },
    });
  });

  test("folded >- as a sequence item strips the trailing newline", () => {
    expect(parseYAML("cmds:\n  - >-\n    a\n    b\n  - plain\n")).toEqual({
      cmds: ["a b", "plain"],
    });
  });
});

// #1311 — a sequence item's sibling keys survive a nested block, whichever key
// comes first. The bug was purely positional: the same keys in the other order
// parsed correctly, so nothing about the keys themselves was at fault.
describe("parseYAML — sibling keys after a nested block in a sequence item (#1311)", () => {
  test("a sibling key after a nested MAPPING is not swallowed", () => {
    expect(parseYAML("items:\n- context:\n    cluster: c1\n  name: n1\n")).toEqual({
      items: [{ context: { cluster: "c1" }, name: "n1" }],
    });
  });

  test("the same keys in the other order still parse — the ordering is what mattered", () => {
    expect(parseYAML("items:\n- name: n1\n  context:\n    cluster: c1\n")).toEqual({
      items: [{ name: "n1", context: { cluster: "c1" } }],
    });
  });

  test("several siblings after a nested mapping", () => {
    expect(parseYAML("items:\n- context:\n    cluster: c1\n  name: n1\n  user: u1\n")).toEqual({
      items: [{ context: { cluster: "c1" }, name: "n1", user: "u1" }],
    });
  });

  test("back-to-back nested mappings", () => {
    expect(parseYAML("items:\n- a:\n    x: 1\n  b:\n    y: 2\n")).toEqual({ items: [{ a: { x: 1 }, b: { y: 2 } }] });
  });

  test("every item in a multi-item sequence keeps its siblings", () => {
    expect(parseYAML("items:\n- context:\n    cluster: c1\n  name: n1\n- context:\n    cluster: c2\n  name: n2\n")).toEqual({
      items: [
        { context: { cluster: "c1" }, name: "n1" },
        { context: { cluster: "c2" }, name: "n2" },
      ],
    });
  });

  test("a sibling key after a SAME-COLUMN nested sequence — valid YAML, and what kubectl emits", () => {
    expect(parseYAML("items:\n- ports:\n  - 80\n  - 443\n  name: n1\n")).toEqual({
      items: [{ ports: [80, 443], name: "n1" }],
    });
  });

  test("a key with no value stays null when the next line is a sibling, not its content", () => {
    // The reason a nested MAPPING must be indented PAST its key while a
    // sequence may share its column: `other` here belongs to the item, not to
    // `meta`. Reading both against the same threshold breaks one or the other.
    expect(parseYAML("items:\n- name: a\n  meta:\n  other: b\n")).toEqual({
      items: [{ name: "a", meta: null, other: "b" }],
    });
  });

  test("a real Kubernetes container: same-column sequences between scalar keys", () => {
    expect(
      parseYAML('containers:\n- name: web\n  ports:\n  - containerPort: 80\n  env:\n  - name: X\n    value: "1"\n  image: nginx\n'),
    ).toEqual({
      containers: [
        {
          name: "web",
          ports: [{ containerPort: 80 }],
          env: [{ name: "X", value: "1" }],
          image: "nginx",
        },
      ],
    });
  });

  test("a real kubeconfig context block — the shape that surfaced this", () => {
    const kubeconfig = [
      "contexts:",
      "- context:",
      "    cluster: arn:aws:eks:us-east-1:000000000000:cluster/cc-eks",
      "    user: arn:aws:eks:us-east-1:000000000000:cluster/cc-eks",
      "  name: arn:aws:eks:us-east-1:000000000000:cluster/cc-eks",
      "current-context: arn:aws:eks:us-east-1:000000000000:cluster/cc-eks",
      "",
    ].join("\n");
    const arn = "arn:aws:eks:us-east-1:000000000000:cluster/cc-eks";
    expect(parseYAML(kubeconfig)).toEqual({
      contexts: [{ context: { cluster: arn, user: arn }, name: arn }],
      "current-context": arn,
    });
  });

  test("a GitHub Actions step with `with:` before its sibling keys", () => {
    expect(parseYAML("steps:\n- with:\n    fetch-depth: 0\n  name: checkout\n  uses: actions/checkout@v4\n")).toEqual({
      steps: [{ with: { "fetch-depth": 0 }, name: "checkout", uses: "actions/checkout@v4" }],
    });
  });
});
