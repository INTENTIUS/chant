import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import { fold, foldResource, collectConsts, FoldError } from "./fold";
import { evl001NonLiteralExpressionRule } from "../lint/rules/evl001-non-literal-expression";
import { evl003DynamicPropertyAccessRule } from "../lint/rules/evl003-dynamic-property-access";
import { evl004SpreadNonConstRule } from "../lint/rules/evl004-spread-non-const";
import type { LintContext } from "../lint/rule";
import type { IntrinsicDef } from "../lexicon";

/**
 * subset.test.ts — the equivalence property test for #1024: for a corpus of
 * supported AND unsupported expression shapes, `fold()` and the EVL rules
 * (EVL001 general, EVL003 for dynamic element-access keys) must agree —
 * "EVL-flags <=> fold-rejects" — citing the same rule id and the same
 * source position for every rejection.
 *
 * Every case here is a single-file, self-contained snippet (no imports, no
 * unresolved cross-file symbols) so it stays inside the part of the subset
 * that genuinely IS shared. A handful of real, environment/value-dependent
 * exceptions are NOT unifiable through shape alone — see subset.ts's module
 * doc for why — and are verified separately below, as documented
 * divergences, rather than folded into the main equivalence loop.
 */

interface SubsetCase {
  name: string;
  /** The expression under test, plugged in as `new Thing({ x: <expr> })`. */
  expr: string;
  /** Extra top-level `const` declarations the expression may reference. */
  preamble?: string;
  intrinsics?: IntrinsicDef[];
}

const SUPPORTED_CASES: SubsetCase[] = [
  { name: "string literal", expr: `"x"` },
  { name: "numeric literal", expr: `42` },
  { name: "boolean literal", expr: `true` },
  { name: "null", expr: `null` },
  { name: "undefined", expr: `undefined` },
  { name: "template literal interpolating a const", preamble: `const name = "world";`, expr: "`hello-${name}`" },
  { name: "nested object literal with shorthand", preamble: `const c = 2;`, expr: `{ a: 1, b: { c } }` },
  { name: "object spread from a const object", preamble: `const base = { a: 1 };`, expr: `{ ...base, b: 2 }` },
  { name: "array spread from a const array", preamble: `const arr = [2, 3];`, expr: `[1, ...arr, 4]` },
  { name: "property access chain", preamble: `const config = { role: "arn" };`, expr: `config.role` },
  { name: "element access with a literal key", preamble: `const config = { role: "arn" };`, expr: `config["role"]` },
  { name: "logical-not unary", preamble: `const flag = true;`, expr: `!flag` },
  { name: "numeric negation unary", preamble: `const n = 5;`, expr: `-n` },
  { name: "whitelisted binary operator (+)", preamble: `const n = 5;`, expr: `n + 1` },
  { name: "whitelisted binary operator (===)", preamble: `const n = 5;`, expr: `n === 5` },
  { name: "conditional with both branches foldable", preamble: `const flag = true;`, expr: `flag ? "yes" : "no"` },
  { name: "as cast", expr: `(1 + 1) as number` },
  { name: "satisfies", expr: `"ok" satisfies string` },
  { name: "parenthesized", expr: `(("nested"))` },
  { name: "non-null assertion", preamble: `const n = 5;`, expr: `n!` },
  {
    name: "registered intrinsic tagged template with foldable interior",
    preamble: `const name = "prefix";`,
    expr: "Sub`${name}-data`",
    intrinsics: [{ name: "Sub", isTag: true }],
  },
];

const UNSUPPORTED_CASES: SubsetCase[] = [
  { name: "function call as a value", expr: `getName()` },
  { name: "method call as a value", expr: `config.getName()` },
  { name: "computed/dynamic object-literal key", expr: `{ [dynKey]: 1 }` },
  { name: "dynamic element-access key", expr: `config[dynKey]` },
  { name: "non-whitelisted binary operator (%)", expr: `n % 2` },
  { name: "non-whitelisted unary operator (~)", expr: `~n` },
  { name: "unsupported object member (accessor)", expr: `{ get y() { return 1; } }` },
  { name: "unsupported expression kind (arrow function)", expr: `() => 1` },
  { name: "template literal with an unfoldable interpolation", expr: "`pre-${getName()}`" },
];

interface RunResult {
  foldError: FoldError | undefined;
  evl001Diags: ReturnType<typeof evl001NonLiteralExpressionRule.check>;
  evl003Diags: ReturnType<typeof evl003DynamicPropertyAccessRule.check>;
}

function run(c: SubsetCase): RunResult {
  const source = `${c.preamble ?? ""}\nconst bad = new Thing({ x: ${c.expr} });`;
  const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const consts = collectConsts(sourceFile);
  const badInit = consts.get("bad");
  if (!badInit || !ts.isNewExpression(badInit)) {
    throw new Error(`fixture error: "bad" did not parse as a NewExpression in case "${c.name}"`);
  }

  let foldError: FoldError | undefined;
  try {
    foldResource(badInit, consts, c.intrinsics ?? []);
  } catch (e) {
    if (e instanceof FoldError) {
      foldError = e;
    } else {
      throw e;
    }
  }

  const context: LintContext = { sourceFile, entities: [], filePath: "t.ts", lexicon: undefined };
  return {
    foldError,
    evl001Diags: evl001NonLiteralExpressionRule.check(context),
    evl003Diags: evl003DynamicPropertyAccessRule.check(context),
  };
}

describe("subset equivalence — supported cases: fold succeeds AND EVL is clean", () => {
  for (const c of SUPPORTED_CASES) {
    test(c.name, () => {
      const { foldError, evl001Diags, evl003Diags } = run(c);
      expect(foldError, `fold() unexpectedly rejected: ${foldError?.message}`).toBeUndefined();
      expect(evl001Diags, "EVL001 unexpectedly flagged a fold-supported construct").toHaveLength(0);
      expect(evl003Diags, "EVL003 unexpectedly flagged a fold-supported construct").toHaveLength(0);
    });
  }
});

describe("subset equivalence — unsupported cases: fold rejects AND EVL flags the same rule id + position", () => {
  for (const c of UNSUPPORTED_CASES) {
    test(c.name, () => {
      const { foldError, evl001Diags, evl003Diags } = run(c);
      expect(foldError, "fold() unexpectedly accepted an unsupported construct").toBeInstanceOf(FoldError);
      const err = foldError as FoldError;

      const matching = err.ruleId === "EVL003" ? evl003Diags : evl001Diags;
      expect(
        matching.length,
        `expected ${err.ruleId} to flag the same construct fold() rejected ("${err.message}")`,
      ).toBeGreaterThan(0);
      expect(matching[0].ruleId).toBe(err.ruleId);
      expect(matching[0].line, "EVL diagnostic line must match FoldError.line").toBe(err.line);
      expect(matching[0].column, "EVL diagnostic column must match FoldError.column").toBe(err.column);
    });
  }
});

/**
 * Documented, out-of-scope divergences (see subset.ts's module doc). These
 * are NOT bugs introduced by #1024 — they're inherent to a syntax-only
 * lint rule vs. an evaluator, and are asserted here so a future change that
 * accidentally "fixes" (or silently regresses) one of them gets caught.
 */
describe("documented divergences — NOT unified by design (see subset.ts module doc)", () => {
  test("identifier resolution: fold rejects an unresolved bare identifier; EVL001 does not (shape-only)", () => {
    const source = `const bad = new Thing({ x: missingVar });`;
    const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    const consts = collectConsts(sourceFile);
    const badInit = consts.get("bad") as ts.NewExpression;

    expect(() => foldResource(badInit, consts, [])).toThrow(FoldError);

    const context: LintContext = { sourceFile, entities: [], filePath: "t.ts", lexicon: undefined };
    expect(evl001NonLiteralExpressionRule.check(context)).toHaveLength(0);
  });

  test("intrinsic tag registration: fold rejects an unregistered tag; EVL001 does not (no lexicon manifest at lint time)", () => {
    const source = "const bad = new Thing({ x: Unknown`plain` });";
    const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    const consts = collectConsts(sourceFile);
    const badInit = consts.get("bad") as ts.NewExpression;

    expect(() => foldResource(badInit, consts, [])).toThrow(FoldError);

    const context: LintContext = { sourceFile, entities: [], filePath: "t.ts", lexicon: undefined };
    expect(evl001NonLiteralExpressionRule.check(context)).toHaveLength(0);
  });

  test("spread-source runtime type: fold rejects spreading a const number; no EVL rule catches it (needs evaluation)", () => {
    const source = `
      const n = 5;
      const bad = new Thing({ x: { ...n } });
    `;
    const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    const consts = collectConsts(sourceFile);
    const badInit = consts.get("bad") as ts.NewExpression;

    expect(() => foldResource(badInit, consts, [])).toThrow(FoldError);

    const context: LintContext = { sourceFile, entities: [], filePath: "t.ts", lexicon: undefined };
    expect(evl001NonLiteralExpressionRule.check(context)).toHaveLength(0);
    expect(evl004SpreadNonConstRule.check(context)).toHaveLength(0);
  });

  test("&&/||/?? short-circuit: fold folds only the taken side; EVL is flow-insensitive and flags the untaken side too", () => {
    // fold(): the left side is falsy, so `sideEffect()` is never folded — succeeds.
    const shortCircuitSrc = ts.createSourceFile(
      "t.ts",
      `const x = false && sideEffect();`,
      ts.ScriptTarget.Latest,
      true,
    );
    const shortCircuitConsts = collectConsts(shortCircuitSrc);
    const foldedValue = fold(shortCircuitConsts.get("x") as ts.Expression, shortCircuitConsts);
    expect(foldedValue).toBe(false);

    // EVL001 has no evaluator — it requires every operand to be shape-valid,
    // so it flags the untaken `sideEffect()` branch even though fold()
    // never touches it.
    const source = `const bad = new Thing({ x: false && sideEffect() });`;
    const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    const context: LintContext = { sourceFile, entities: [], filePath: "t.ts", lexicon: undefined };
    expect(evl001NonLiteralExpressionRule.check(context).length).toBeGreaterThan(0);
  });

  test("tagged-template interior: fold rejects an unfoldable interpolation in a registered intrinsic tag; EVL is lenient (no registry, interiors opaque)", () => {
    // `Sub`${getName()}`` — fold, with the intrinsic registry, folds the Sub
    // tag's interior and rejects the getName() call. EVL has no registry and
    // can't tell an intrinsic call (Ref, legit) from a plain one, so it treats
    // tagged-template interiors as opaque and does not flag — otherwise it would
    // false-flag `Sub`${Ref(env)}`` and break every intrinsic-using example.
    const source = "const bad = new Thing({ x: Sub`${getName()}` });";
    const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    const consts = collectConsts(sourceFile);
    const badInit = consts.get("bad") as ts.NewExpression;

    expect(() => foldResource(badInit, consts, [{ name: "Sub", isTag: true }])).toThrow(FoldError);

    const context: LintContext = { sourceFile, entities: [], filePath: "t.ts", lexicon: undefined };
    expect(evl001NonLiteralExpressionRule.check(context)).toHaveLength(0);
  });

  test("nested resource construction: fold rejects a nested `new Type()` used as a value (falls back to run); EVL001 allows it statically", () => {
    // A top-level `new Type()` folds (fold-import constructs a real Declarable),
    // but a NESTED one as a property value can only fold to a {__resource,props}
    // envelope that is never constructed, so it would serialize wrong (real
    // fold-vs-run drift, caught by the #1025 differential on gitlab). fold()
    // therefore rejects it, falling the file back to run; EVL allows it (a valid
    // TS constructor call), so this is an inherent, out-of-scope divergence.
    const source = `const bad = new Thing({ x: new Inner({ y: 1 }) });`;
    const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    const consts = collectConsts(sourceFile);
    const badInit = consts.get("bad") as ts.NewExpression;

    expect(() => foldResource(badInit, consts, [])).toThrow(FoldError);

    const context: LintContext = { sourceFile, entities: [], filePath: "t.ts", lexicon: undefined };
    expect(evl001NonLiteralExpressionRule.check(context)).toHaveLength(0);
  });
});
