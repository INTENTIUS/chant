import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import { fold, foldModule, collectConsts, FoldError, type FoldedValue } from "./fold";

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
    expect(foldConst(src, "ref")).toEqual({ __ref: "bucket", attr: "name" });
  });

  test("property access on a plain object indexes the folded value", () => {
    const src = `
      const obj = { name: "plain" };
      const x = obj.name;
    `;
    expect(foldConst(src, "x")).toBe("plain");
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
      spec: { __resource: "BucketPolicy", props: { bucketName: { __ref: "bucket", attr: "name" } } },
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
});
