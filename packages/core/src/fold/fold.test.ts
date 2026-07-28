import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import { fold, foldModule, collectConsts, FoldError, type FoldedValue } from "./fold";
import { createResource } from "../runtime";
import { resolveAttrRefs } from "../discovery/resolve";
import type { Declarable } from "../declarable";
import type { AttrRef } from "../attrref";
import type { IntrinsicDef } from "../lexicon";

/** Parse a snippet and return its top-level `const` map, for direct `fold()` tests. */
function parseConsts(source: string): Map<string, ts.Expression> {
  const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
  return collectConsts(sourceFile);
}

/** Fold the initializer of the named top-level `const` in `source`. */
function foldConst(source: string, name: string): FoldedValue {
  const consts = parseConsts(source);
  const expr = consts.get(name);
  if (!expr) throw new Error(`fixture error: no such const "${name}" in source`);
  return fold(expr, consts);
}

describe("fold — literals", () => {
  test("string literal", () => {
    expect(foldConst(`const x = "hello";`, "x")).toBe("hello");
  });

  test("numeric literal", () => {
    expect(foldConst(`const x = 42;`, "x")).toBe(42);
  });

  test("boolean literals", () => {
    expect(foldConst(`const x = true;`, "x")).toBe(true);
    expect(foldConst(`const x = false;`, "x")).toBe(false);
  });

  test("null", () => {
    expect(foldConst(`const x = null;`, "x")).toBeNull();
  });

  test("undefined", () => {
    expect(foldConst(`const x = undefined;`, "x")).toBeUndefined();
  });

  test("no-substitution template literal", () => {
    expect(foldConst("const x = `plain`;", "x")).toBe("plain");
  });
});

describe("fold — template interpolation", () => {
  test("interpolates a const identifier", () => {
    const src = `
      const name = "World";
      const x = \`Hello \${name}!\`;
    `;
    expect(foldConst(src, "x")).toBe("Hello World!");
  });

  test("interpolates multiple spans and coerces non-strings", () => {
    const src = `
      const count = 3;
      const x = \`count=\${count}, ok=\${true}\`;
    `;
    expect(foldConst(src, "x")).toBe("count=3, ok=true");
  });
});

describe("fold — objects and spread", () => {
  test("object literal with property and shorthand assignment", () => {
    const src = `
      const b = 2;
      const x = { a: 1, b };
    `;
    expect(foldConst(src, "x")).toEqual({ a: 1, b: 2 });
  });

  test("spreads a folded object", () => {
    const src = `
      const base = { a: 1, b: 2 };
      const x = { ...base, b: 3, c: 4 };
    `;
    expect(foldConst(src, "x")).toEqual({ a: 1, b: 3, c: 4 });
  });

  test("nested objects", () => {
    const src = `const x = { a: { b: { c: 1, d: [1, 2] } } };`;
    expect(foldConst(src, "x")).toEqual({ a: { b: { c: 1, d: [1, 2] } } });
  });
});

describe("fold — arrays and spread", () => {
  test("array literal", () => {
    expect(foldConst(`const x = [1, "two", true];`, "x")).toEqual([1, "two", true]);
  });

  test("spreads a folded array in place", () => {
    const src = `
      const rest = [2, 3];
      const x = [1, ...rest, 4];
    `;
    expect(foldConst(src, "x")).toEqual([1, 2, 3, 4]);
  });
});

describe("fold — const identifier resolution", () => {
  test("resolves a chain of const identifiers", () => {
    const src = `
      const a = 5;
      const b = a;
      const c = b;
    `;
    expect(foldConst(src, "c")).toBe(5);
  });
});

describe("fold — cross-resource attribute refs", () => {
  test("property access on a const bound to `new` becomes a symbolic ref", () => {
    const src = `
      const bucket = new S3Bucket({ name: "my-bucket" });
      const ref = bucket.name;
    `;
    expect(foldConst(src, "ref")).toEqual({ __attrRef: { entity: "bucket", attribute: "name" } });
  });

  test("property access on a plain object indexes the folded value", () => {
    const src = `
      const obj = { name: "plain" };
      const x = obj.name;
    `;
    expect(foldConst(src, "x")).toBe("plain");
  });

  test("differential: fold(bucket.arn) matches the AttrRef.toJSON() the run path yields", () => {
    // Run path: build a real resource instance the way generated lexicon
    // code does (runtime.createResource), then resolve it exactly like
    // discovery does for a real project (discovery/resolve.ts).
    const Bucket = createResource("S3Bucket", "aws", { arn: "arn" });
    const bucket = new Bucket({ name: "my-bucket" }) as unknown as Declarable & { arn: AttrRef };
    const entities = new Map<string, Declarable>([["bucket", bucket]]);
    resolveAttrRefs(entities);
    const runResult = bucket.arn.toJSON();

    // Fold path: the same source, folded with no module execution.
    const src = `
      const bucket = new S3Bucket({ name: "my-bucket" });
      const ref = bucket.arn;
    `;
    const foldResult = foldConst(src, "ref");

    expect(foldResult).toEqual(runResult);
    expect(foldResult).toEqual({ __attrRef: { entity: "bucket", attribute: "arn" } });
  });
});

describe("fold — element access", () => {
  test("string literal key on a plain object indexes the folded value", () => {
    const src = `
      const obj = { name: "plain" };
      const x = obj["name"];
    `;
    expect(foldConst(src, "x")).toBe("plain");
  });

  test("numeric literal key indexes a folded array", () => {
    const src = `
      const arr = ["a", "b", "c"];
      const x = arr[1];
    `;
    expect(foldConst(src, "x")).toBe("b");
  });

  test("element access on a const bound to `new` becomes a symbolic ref, same as dot access", () => {
    const src = `
      const bucket = new S3Bucket({ name: "my-bucket" });
      const ref = bucket["name"];
    `;
    expect(foldConst(src, "ref")).toEqual({ __attrRef: { entity: "bucket", attribute: "name" } });
  });

  test("numeric element access on a const bound to `new` becomes a symbolic ref with a stringified attribute", () => {
    const src = `
      const thing = new Thing({});
      const ref = thing[0];
    `;
    expect(foldConst(src, "ref")).toEqual({ __attrRef: { entity: "thing", attribute: "0" } });
  });

  test("a dynamic/computed element key throws a located FoldError (EVL003 semantics)", () => {
    const src = `
      const key = "dynamic";
      const obj = { dynamic: 1 };
      const bad = obj[key];
    `;
    let error: unknown;
    try {
      foldConst(src, "bad");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FoldError);
    expect((error as FoldError).message).toContain("computed key must be a string or numeric literal");
  });

  test("a dynamic element key on a resource ref is also rejected", () => {
    const src = `
      const key = "arn";
      const bucket = new S3Bucket({});
      const bad = bucket[key];
    `;
    expect(() => foldConst(src, "bad")).toThrow(FoldError);
  });
});

describe("fold — intrinsic tagged templates", () => {
  const SUB: IntrinsicDef = { name: "Sub", isTag: true, outputKey: "Fn::Sub" };

  test("a registered tag folds to the intrinsic node form", () => {
    const src = `const x = Sub\`\${name}-data\`;`;
    const consts = parseConsts(`const name = "prefix"; ${src}`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(fold(expr, consts, [SUB])).toEqual({
      __intrinsic: "Sub",
      strings: ["", "-data"],
      values: ["prefix"],
    });
  });

  test("Params.StackName-style pseudo-parameter access is preserved symbolically, not stringified", () => {
    const consts = parseConsts(`const x = Intrinsic\`\${Params.StackName}-data\`;`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    const INTRINSIC: IntrinsicDef = { name: "Intrinsic", isTag: true };
    expect(fold(expr, consts, [INTRINSIC])).toEqual({
      __intrinsic: "Intrinsic",
      strings: ["", "-data"],
      values: [{ __symbol: "Params.StackName" }],
    });
  });

  test("folds only the interpolated sub-expressions — a nested resource ref stays a ref, not a string", () => {
    const src = `
      const bucket = new S3Bucket({ name: "my-bucket" });
      const x = Sub\`\${bucket.arn}/*\`;
    `;
    const consts = parseConsts(src);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(fold(expr, consts, [SUB])).toEqual({
      __intrinsic: "Sub",
      strings: ["", "/*"],
      values: [{ __attrRef: { entity: "bucket", attribute: "arn" } }],
    });
  });

  test("a no-substitution tagged template folds with an empty values array", () => {
    const consts = parseConsts("const x = Sub`plain-value`;");
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(fold(expr, consts, [SUB])).toEqual({ __intrinsic: "Sub", strings: ["plain-value"], values: [] });
  });

  test("an unregistered tagged template is rejected with a located FoldError", () => {
    const consts = parseConsts("const x = Unknown`${1}`;");
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    let error: unknown;
    try {
      fold(expr, consts, [SUB]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FoldError);
    expect((error as FoldError).message).toContain("Unknown");
  });

  test("a tagged template is rejected when no intrinsics are registered at all", () => {
    const consts = parseConsts("const x = Sub`${1}`;");
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(() => fold(expr, consts)).toThrow(FoldError);
  });
});

/**
 * chant #1044 — registered lexicon intrinsics in PLAIN-CALL form.
 *
 * The registry is the whole door: a name folds as a call only when an active
 * lexicon registered it AND set `foldsAsCall`. Everything below that pairs a
 * folding case with the near-miss that must keep rejecting.
 */
describe("fold — registered call-form intrinsics (#1044)", () => {
  /** Shaped like aws's real registration (lexicons/aws/src/plugin.ts). */
  const REF: IntrinsicDef = { name: "Ref", isTag: false, foldsAsCall: true };
  const JOIN: IntrinsicDef = { name: "Join", isTag: false, foldsAsCall: true };
  /** Registered, but its lexicon never opted the call form in — the default. */
  const NOT_OPTED_IN: IntrinsicDef = { name: "Reference", isTag: false };
  const SUB: IntrinsicDef = { name: "Sub", isTag: true };

  test("an opted-in call folds to the intrinsic node form, arguments folded in order", () => {
    const consts = parseConsts(`const env = "prod"; const x = Ref(env);`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(fold(expr, consts, [REF])).toEqual({ __intrinsic: "Ref", args: ["prod"] });
  });

  test("the envelope is the same family the tagged-template form produces — same __intrinsic key, positional args", () => {
    const consts = parseConsts(`const x = Join("-", ["a", "b"]);`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(fold(expr, consts, [JOIN])).toEqual({ __intrinsic: "Join", args: ["-", ["a", "b"]] });
  });

  test("calls nest, and a call-form intrinsic folds inside a registered tag's interpolation", () => {
    const consts = parseConsts(`const env = "prod"; const x = Sub\`\${Ref(env)}-fn\`;`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(fold(expr, consts, [SUB, REF])).toEqual({
      __intrinsic: "Sub",
      strings: ["", "-fn"],
      values: [{ __intrinsic: "Ref", args: ["prod"] }],
    });
  });

  test("an argument nothing can resolve stays symbolic, exactly as inside a tag", () => {
    const consts = parseConsts(`const x = Ref(AWS.StackName);`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(fold(expr, consts, [REF])).toEqual({
      __intrinsic: "Ref",
      args: [{ __symbol: "AWS.StackName" }],
    });
  });

  test("an already-resolved cross-file binding wins over the symbolic path — identity must survive", () => {
    const consts = parseConsts(`const x = Ref(environment);`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    const live = { marker: "the real, shared Parameter instance" };
    const folded = fold(expr, consts, [REF], new Map([["environment", live]])) as {
      __intrinsic: string;
      args: unknown[];
    };
    expect(folded.args[0]).toBe(live);
  });

  test("a REGISTERED intrinsic that was never opted in is still rejected — the opt-in is the door, not registration", () => {
    const consts = parseConsts(`const x = Reference("db");`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    let error: unknown;
    try {
      fold(expr, consts, [NOT_OPTED_IN]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FoldError);
    expect((error as FoldError).message).toContain("function call as a value is not foldable: Reference(...)");
  });

  test("an opted-in name is rejected when its lexicon isn't among the active ones", () => {
    const consts = parseConsts(`const x = Ref("db");`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(() => fold(expr, consts)).toThrow(FoldError);
  });

  test("a TAGGED-TEMPLATE intrinsic called as a plain function is rejected — the two forms are disjoint", () => {
    const consts = parseConsts(`const x = Sub("literal");`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(() => fold(expr, consts, [SUB])).toThrow(FoldError);
  });

  test("a call-form intrinsic used as a TAG is rejected too — opting the call in doesn't register a tag", () => {
    const consts = parseConsts(`const x = Ref\`literal\`;`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    let error: unknown;
    try {
      fold(expr, consts, [REF]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FoldError);
    expect((error as FoldError).message).toContain("unregistered tagged template intrinsic: Ref");
  });

  test("a registered name reached as a METHOD (`ns.Ref(...)`) is rejected — only a bare identifier callee folds", () => {
    const consts = parseConsts(`const x = aws.Ref("db");`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(() => fold(expr, consts, [REF])).toThrow(FoldError);
  });

  test("an array method taking a closure is rejected — .map is arbitrary JS, not a registered intrinsic", () => {
    const consts = parseConsts(`const cidrs = ["10.0.0.0/24"]; const x = cidrs.map((c) => Ref(c));`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    let error: unknown;
    try {
      fold(expr, consts, [REF]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FoldError);
    expect((error as FoldError).message).toContain("cidrs.map(...)");
  });

  test("a user-defined function is rejected however it's named", () => {
    const consts = parseConsts(`const x = makeName("a", "b");`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(() => fold(expr, consts, [REF])).toThrow(FoldError);
  });

  test("a registered name SHADOWED by a local const is rejected — the local binding wins, and it isn't the lexicon's", () => {
    const consts = parseConsts(`const Ref = (n) => ({ mine: n }); const x = Ref("db");`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(() => fold(expr, consts, [REF])).toThrow(FoldError);
  });

  test("an unfoldable argument still rejects the whole call", () => {
    const consts = parseConsts(`const x = Ref(getName());`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    let error: unknown;
    try {
      fold(expr, consts, [REF]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FoldError);
    expect((error as FoldError).message).toContain("getName(...)");
  });

  test("a same-file resource passed to an intrinsic call rejects rather than folding to a look-alike envelope", () => {
    const consts = parseConsts(`const bucket = new S3Bucket({ name: "b" }); const x = Ref(bucket);`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(() => fold(expr, consts, [REF])).toThrow(FoldError);
  });
});

describe("fold — registered authoring helpers (#1082)", () => {
  test("a registered helper call folds to the helper-call node form, arguments folded in order", () => {
    const consts = parseConsts(`const stack = "web"; const x = phase("Apply", [{ kind: "cfn-deploy", stack }]);`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(fold(expr, consts)).toEqual({
      __helper: "phase",
      args: ["Apply", [{ kind: "cfn-deploy", stack: "web" }]],
    });
  });

  test("helper calls nest, so a fan-out phase folds to nested envelopes", () => {
    const consts = parseConsts(`const x = phase("Outer", [phase("Inner", []), gate("approve")]);`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(fold(expr, consts)).toEqual({
      __helper: "phase",
      args: [
        "Outer",
        [
          { __helper: "phase", args: ["Inner", []] },
          { __helper: "gate", args: ["approve"] },
        ],
      ],
    });
  });

  test("an unfoldable argument still rejects the whole call", () => {
    const consts = parseConsts(`const x = phase("Apply", [{ stack: getName() }]);`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(() => fold(expr, consts)).toThrow(FoldError);
  });

  test("an UNREGISTERED name is still rejected — the allowlist is closed, not a general call case", () => {
    const consts = parseConsts(`const x = compose("Apply", []);`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    let error: unknown;
    try {
      fold(expr, consts);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FoldError);
    expect((error as FoldError).message).toContain("function call as a value is not foldable: compose(...)");
  });

  test("a registered name SHADOWED by a local const is rejected — the local binding wins, and it isn't chant's", () => {
    const consts = parseConsts(`const phase = (n) => ({ phase: n }); const x = phase("Apply");`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(() => fold(expr, consts)).toThrow(FoldError);
  });

  test("a registered name used as a METHOD (`ns.phase(...)`) is rejected — only a bare identifier callee folds", () => {
    const consts = parseConsts(`const x = helpers.phase("Apply", []);`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(() => fold(expr, consts)).toThrow(FoldError);
  });

  test("a spread argument is rejected — fold has no case for one, registered callee or not", () => {
    const consts = parseConsts(`const steps = []; const x = phase(...steps);`);
    const expr = consts.get("x");
    if (!expr) throw new Error("fixture error");
    expect(() => fold(expr, consts)).toThrow(FoldError);
  });
});

describe("fold — nullish coalescing, ternary, arithmetic", () => {
  test("?? falls through only on null/undefined", () => {
    expect(foldConst(`const x = null ?? "fallback";`, "x")).toBe("fallback");
    expect(foldConst(`const x = undefined ?? "fallback";`, "x")).toBe("fallback");
    expect(foldConst(`const x = 0 ?? "fallback";`, "x")).toBe(0);
  });

  test("ternary picks a branch", () => {
    expect(foldConst(`const x = 2 > 1 ? "yes" : "no";`, "x")).toBe("yes");
    expect(foldConst(`const x = 1 > 2 ? "yes" : "no";`, "x")).toBe("no");
  });

  test("arithmetic operators", () => {
    expect(foldConst(`const x = 2 + 3;`, "x")).toBe(5);
    expect(foldConst(`const x = 5 - 2;`, "x")).toBe(3);
    expect(foldConst(`const x = 4 * 3;`, "x")).toBe(12);
    expect(foldConst(`const x = 9 / 3;`, "x")).toBe(3);
  });

  test("+ concatenates strings", () => {
    expect(foldConst(`const p = "fountain"; const x = p + "-" + "db";`, "x")).toBe("fountain-db");
  });

  test("comparison operators", () => {
    expect(foldConst(`const x = 3 === 3;`, "x")).toBe(true);
    expect(foldConst(`const x = 3 !== 3;`, "x")).toBe(false);
    expect(foldConst(`const x = 3 >= 3;`, "x")).toBe(true);
    expect(foldConst(`const x = 2 <= 1;`, "x")).toBe(false);
  });
});

describe("fold — logical short-circuit (no execution of the untaken branch)", () => {
  test("&& short-circuits on a falsy left without evaluating the call on the right", () => {
    expect(foldConst(`const x = false && sideEffect();`, "x")).toBe(false);
  });

  test("&& evaluates the right side when the left is truthy", () => {
    expect(foldConst(`const x = true && "right";`, "x")).toBe("right");
  });

  test("|| short-circuits on a truthy left without evaluating the call on the right", () => {
    expect(foldConst(`const x = true || sideEffect();`, "x")).toBe(true);
  });

  test("|| evaluates the right side when the left is falsy", () => {
    expect(foldConst(`const x = false || "right";`, "x")).toBe("right");
  });
});

describe("fold — unary operators", () => {
  test("logical not", () => {
    expect(foldConst(`const x = !true;`, "x")).toBe(false);
    expect(foldConst(`const x = !false;`, "x")).toBe(true);
  });

  test("numeric negation", () => {
    expect(foldConst(`const n = 5; const x = -n;`, "x")).toBe(-5);
  });
});

describe("fold — as / satisfies / parenthesized", () => {
  test("`as` cast unwraps to the inner value", () => {
    expect(foldConst(`const x = (1 + 1) as number;`, "x")).toBe(2);
  });

  test("`satisfies` unwraps to the inner value", () => {
    expect(foldConst(`const x = "ok" satisfies string;`, "x")).toBe("ok");
  });

  test("parenthesized expressions unwrap", () => {
    expect(foldConst(`const x = (("nested"));`, "x")).toBe("nested");
  });
});

describe("fold — rejections", () => {
  test("a function call as a value throws FoldError naming the callee", () => {
    const src = `const bad = computeName("x");`;
    let error: unknown;
    try {
      foldConst(src, "bad");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FoldError);
    expect((error as FoldError).message).toContain("computeName(...)");
  });

  test("a call throws FoldError with a located line/column", () => {
    const src = `\nconst bad = computeName("x");`;
    try {
      foldConst(src, "bad");
      throw new Error("expected foldConst to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FoldError);
      const err = e as FoldError;
      expect(err.line).toBe(2);
      expect(err.column).toBeGreaterThan(0);
    }
  });

  test("a computed/dynamic property key is not foldable", () => {
    const src = `
      const key = "dynamic";
      const bad = { [key]: 1 };
    `;
    expect(() => foldConst(src, "bad")).toThrow(FoldError);
  });

  test("spread from a call expression is not foldable", () => {
    const src = `const bad = { ...computeExtras() };`;
    expect(() => foldConst(src, "bad")).toThrow(FoldError);
  });

  test("spread from a resolved non-object value is not foldable", () => {
    const src = `
      const n = 5;
      const bad = { ...n };
    `;
    expect(() => foldConst(src, "bad")).toThrow(FoldError);
  });

  test("array-spread from a resolved non-array value is not foldable", () => {
    const src = `
      const n = 5;
      const bad = [...n];
    `;
    expect(() => foldConst(src, "bad")).toThrow(FoldError);
  });

  test("an unresolved identifier is not foldable", () => {
    const src = `const bad = missingVar;`;
    expect(() => foldConst(src, "bad")).toThrow(FoldError);
    try {
      foldConst(src, "bad");
    } catch (e) {
      expect((e as FoldError).message).toContain("missingVar");
    }
  });

  test("an unsupported expression form is not foldable", () => {
    const src = `const bad = function () { return 1; };`;
    expect(() => foldConst(src, "bad")).toThrow(FoldError);
  });
});

describe("foldResource — constructor argument positions (#1082)", () => {
  test("a props object that isn't the FIRST argument still folds, reported as a positional arg list", () => {
    // AWS's deploy-time Parameter is `(type, props)` — lexicons/aws/src/parameter.ts.
    const src = `export const p = new Parameter("String", { description: "vpc id", defaultValue: "" });`;
    const result = foldModule(src);
    expect(result.p).toEqual({
      ok: true,
      spec: {
        __resource: "Parameter",
        props: { description: "vpc id", defaultValue: "" },
        args: ["String", { description: "vpc id", defaultValue: "" }],
      },
    });
  });

  test("a constructor with no object-literal argument at all folds to its bare argument list", () => {
    const src = `export const p = new Parameter("String");`;
    const result = foldModule(src);
    expect(result.p).toEqual({ ok: true, spec: { __resource: "Parameter", props: {}, args: ["String"] } });
  });

  test("the classic (props) shape is unchanged — no `args` list", () => {
    const src = `export const b = new S3Bucket({ name: "b" });`;
    const result = foldModule(src);
    expect(result.b).toEqual({ ok: true, spec: { __resource: "S3Bucket", props: { name: "b" } } });
  });

  test("the classic (props, attributes) shape is unchanged — no `args` list", () => {
    const src = `export const b = new S3Bucket({ name: "b" }, { DependsOn: "other" });`;
    const result = foldModule(src);
    expect(result.b).toEqual({
      ok: true,
      spec: { __resource: "S3Bucket", props: { name: "b" }, attributes: { DependsOn: "other" } },
    });
  });

  test("a non-object-literal argument is folded, not rejected for its position — but must still be foldable", () => {
    const src = `export const p = new Parameter(getType(), { description: "x" });`;
    const result = foldModule(src);
    expect(result.p?.ok).toBe(false);
    if (result.p && !result.p.ok) {
      expect(result.p.error).toContain("getType(...)");
    }
  });
});

describe("foldModule", () => {
  test("folds an exported const resource to { ok: true, spec }", () => {
    const src = `
      export const bucket = new S3Bucket({ name: "my-bucket", versioned: true });
    `;
    const result = foldModule(src);
    expect(result.bucket).toEqual({
      ok: true,
      spec: { __resource: "S3Bucket", props: { name: "my-bucket", versioned: true } },
    });
  });

  test("folds multiple resources, mixing ok and error results", () => {
    const src = `
      export const good = new Thing({ value: "ok" });
      export const bad = new Thing({ value: computeName("x") });
    `;
    const result = foldModule(src);

    expect(result.good).toEqual({ ok: true, spec: { __resource: "Thing", props: { value: "ok" } } });
    expect(result.bad?.ok).toBe(false);
    if (result.bad && !result.bad.ok) {
      expect(result.bad.error).toContain("computeName(...)");
    }
  });

  test("resolves cross-resource attribute refs inside a folded resource", () => {
    const src = `
      export const bucket = new S3Bucket({ name: "my-bucket" });
      export const policy = new BucketPolicy({ bucketName: bucket.name });
    `;
    const result = foldModule(src);
    expect(result.policy).toEqual({
      ok: true,
      spec: {
        __resource: "BucketPolicy",
        props: { bucketName: { __attrRef: { entity: "bucket", attribute: "name" } } },
      },
    });
  });

  test("leaves non-resource const exports out of the result", () => {
    const src = `
      export const helperValue = 5;
      export const thing = new Thing({ value: "ok" });
    `;
    const result = foldModule(src);
    expect(result.thing).toBeDefined();
    expect(result.helperValue).toBeUndefined();
  });

  test("performs zero module execution — a throwing top-level statement never runs", () => {
    const src = `
      throw new Error("this must never execute");
      export const thing = new Thing({ value: "ok" });
    `;
    // If foldModule ran the module, this call itself would throw.
    const result = foldModule(src);
    expect(result.thing).toEqual({ ok: true, spec: { __resource: "Thing", props: { value: "ok" } } });
  });

  // #1025 differential regression: `new Type(props, attributes)`'s second
  // argument (CFN-style resource attributes — DependsOn, Condition,
  // DeletionPolicy, UpdateReplacePolicy, CreationPolicy, Metadata — see
  // `createResource`'s `attributes` param in ../runtime.ts) was silently
  // dropped by `foldResource`, which only ever read `node.arguments[0]`. The
  // #1025 fold-vs-run differential corpus caught this as real drift on
  // `lexicons/aws/examples/docs-snippets` (its `resource-attributes.ts` and
  // `depends-on.ts` snippets both pass a second argument) before this fix.
  test("folds the optional second constructor argument as `attributes`", () => {
    const src = `
      export const dbInstance = new DbInstance(
        { Engine: "postgres" },
        { DeletionPolicy: "Snapshot", UpdateReplacePolicy: "Snapshot" },
      );
    `;
    const result = foldModule(src);
    expect(result.dbInstance).toEqual({
      ok: true,
      spec: {
        __resource: "DbInstance",
        props: { Engine: "postgres" },
        attributes: { DeletionPolicy: "Snapshot", UpdateReplacePolicy: "Snapshot" },
      },
    });
  });

  test("omits `attributes` from the spec when the constructor takes only props", () => {
    const src = `export const bucket = new S3Bucket({ name: "my-bucket" });`;
    const result = foldModule(src);
    expect(result.bucket?.ok).toBe(true);
    if (result.bucket?.ok) {
      expect(result.bucket.spec.attributes).toBeUndefined();
    }
  });

  test("a non-object-literal second argument is not foldable", () => {
    const src = `
      const attrs = computeAttrs();
      export const bad = new Thing({ value: "ok" }, attrs);
    `;
    const result = foldModule(src);
    expect(result.bad?.ok).toBe(false);
  });
});

/**
 * chant #1169 — a `new Type(...)` used as a VALUE.
 *
 * `fold()` produces the same {@link FoldedResource} envelope for a nested
 * construction as for a top-level one, and it is symbolic in exactly the sense
 * `{__intrinsic}`/`{__helper}` are: nothing is executed here, the constructor's
 * NAME and folded arguments are recorded, and ../discovery/fold-import.ts
 * resolves the name through the file's own imports and builds the real
 * instance. These tests own the envelope; the construction half is
 * ../discovery/fold-import.test.ts's.
 */
describe("constructions as values (chant #1169)", () => {
  test("a nested construction folds to a `{__resource}` envelope, recursively", () => {
    const src = `
      export const job = new Job({
        image: new Image({ name: "node:22" }),
        rules: [new Rule({ if: "$CI" })],
        deep: { inner: new Guest({ cpus: new Count({ n: 1 }) }) },
      });
    `;
    expect(foldModule(src).job).toEqual({
      ok: true,
      spec: {
        __resource: "Job",
        props: {
          image: { __resource: "Image", props: { name: "node:22" } },
          rules: [{ __resource: "Rule", props: { if: "$CI" } }],
          deep: {
            inner: { __resource: "Guest", props: { cpus: { __resource: "Count", props: { n: 1 } } } },
          },
        },
      },
    });
  });

  test("a nested construction with a non-props-first signature keeps its positional `args`", () => {
    // chant #1082's shape, nested. `props` stays the first object-literal
    // argument (a view, for readers); `args` is what the entity is built from.
    const src = `export const p = new Outer({ x: new Parameter("String", { Default: "dev" }) });`;
    const result = foldModule(src);
    expect(result.p?.ok).toBe(true);
    if (!result.p?.ok) return;
    expect(result.p.spec.props.x).toEqual({
      __resource: "Parameter",
      props: { Default: "dev" },
      args: ["String", { Default: "dev" }],
    });
  });

  test("a nested `new ns.Type(...)` is rejected — the class must be reachable through a named import", () => {
    const src = `export const job = new Job({ image: new ns.Image({ name: "x" }) });`;
    const result = foldModule(src);
    expect(result.job?.ok).toBe(false);
    if (result.job?.ok) return;
    expect(result.job?.error).toContain("needs a plain imported constructor");
  });

  test("a BARE reference to a same-file resource const is rejected without a caller that can construct", () => {
    // `fold()` on its own has no module graph, so it cannot hand back the
    // instance the reference means — and re-folding the initializer would build
    // a duplicate. Rejected; `externals` (the bridge's pre-resolved same-file
    // instances) is the only thing that answers this.
    const src = `
      const db = new DbCluster({ engine: "aurora" });
      export const worker = new Instance({ needs: [db] });
    `;
    const result = foldModule(src);
    expect(result.worker?.ok).toBe(false);
    if (result.worker?.ok) return;
    expect(result.worker?.error).toContain("same-file resource `db` used as a value is not foldable");
  });

  test("`externals` answers a same-file resource reference when a caller pre-resolved it", () => {
    const src = `
      const db = new DbCluster({ engine: "aurora" });
      export const worker = new Instance({ needs: [db] });
    `;
    const sourceFile = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true);
    const consts = collectConsts(sourceFile);
    const liveDb = { pretendInstance: true };

    const folded = fold(consts.get("worker") as ts.Expression, consts, [], new Map([["db", liveDb]]));
    // The exact object, not a copy of it: identity is what makes the reference
    // and the registered entity the same thing.
    expect((folded as { props: { needs: unknown[] } }).props.needs[0]).toBe(liveDb);
  });

  test("an ATTRIBUTE reference to a same-file resource is unaffected — still the `{__attrRef}` envelope", () => {
    const src = `
      const db = new DbCluster({ engine: "aurora" });
      export const worker = new Instance({ host: db.Endpoint });
    `;
    const sourceFile = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true);
    const consts = collectConsts(sourceFile);

    const folded = fold(consts.get("worker") as ts.Expression, consts, [], new Map([["db", { live: true }]]));
    // `consts` is consulted before `externals` for a property access, so a
    // pre-resolved instance does not change what a sibling attribute reference
    // folds to.
    expect((folded as { props: Record<string, unknown> }).props.host).toEqual({
      __attrRef: { entity: "db", attribute: "Endpoint" },
    });
  });
});
