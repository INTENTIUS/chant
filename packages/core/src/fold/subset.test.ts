import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import { fold, foldResource, collectConsts, FoldError } from "./fold";
import { briefNodeText, callExpressionMessage, findSubsetViolation } from "./subset";
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
  {
    // chant #1082 — a registered chant authoring helper is the one call shape
    // that folds, so EVL001 must not flag it either.
    name: "registered authoring helper call with foldable arguments",
    preamble: `const stack = "web";`,
    expr: `phase("Apply", [{ kind: "cfn-deploy", stack }])`,
  },
  {
    name: "registered authoring helper nested inside another",
    expr: `phase("Outer", [phase("Inner", []), gate("approve")])`,
  },
];

const UNSUPPORTED_CASES: SubsetCase[] = [
  { name: "function call as a value", expr: `getName()` },
  // chant #1966 moved "method call as a value" and "registered helper name
  // reached as a method" out of this strict-parity list and into "documented
  // divergences" below — a method call now folds when its receiver resolves,
  // which is exactly the identifier-resolution asymmetry every other
  // divergence there already documents.
  //
  // ...and a registered helper with an unfoldable argument is rejected on the
  // argument, by both sides, at the argument's own position.
  { name: "registered helper with an unfoldable argument", expr: `phase("Apply", [getName()])` },
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

  test("authoring-helper shadowing: fold rejects a registered name bound to a local const; EVL001 does not (shape-only, no binding resolution)", () => {
    // chant #1082 — `phase` is registered, but here it's the file's own local
    // arrow function, so the local binding wins and fold() rejects. EVL has no
    // binding resolver (subset.ts module doc, point 1) and stays permissive —
    // the same direction as every other divergence here.
    const source = `
      const phase = (n) => ({ phase: n });
      const bad = new Thing({ x: phase("Apply") });
    `;
    const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    const consts = collectConsts(sourceFile);
    const badInit = consts.get("bad") as ts.NewExpression;

    expect(() => foldResource(badInit, consts, [])).toThrow(FoldError);

    const context: LintContext = { sourceFile, entities: [], filePath: "t.ts", lexicon: undefined };
    expect(evl001NonLiteralExpressionRule.check(context)).toHaveLength(0);
  });

  test("method call on an unresolved receiver: fold rejects; EVL001 accepts the shape (chant #1966, resolution-dependent)", () => {
    // `config.getName()` — chant #1966 widened `findSubsetViolation` to
    // accept a method call unconditionally (mirroring `.step` and a nested
    // `new` before it), because whether the receiver resolves to a value
    // with that method is resolution-dependent (module doc, point 1) and out
    // of reach for a syntax-only classifier. fold() still rejects it here on
    // the receiver: `config` isn't a `const` this file has.
    const source = `const bad = new Thing({ x: config.getName() });`;
    const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    const consts = collectConsts(sourceFile);
    const badInit = consts.get("bad") as ts.NewExpression;

    expect(() => foldResource(badInit, consts, [])).toThrow(FoldError);

    const context: LintContext = { sourceFile, entities: [], filePath: "t.ts", lexicon: undefined };
    expect(evl001NonLiteralExpressionRule.check(context)).toHaveLength(0);
  });

  test("registered helper name reached as a method: not the registered call, on either side — rejected for a different reason since #1966", () => {
    // chant #1082 — a registered helper NAME reached through a namespace is
    // still a method call, never the bare registered call: `fold()`'s
    // `{__helper}` shape only ever matches a BARE identifier callee, so
    // `helpers.phase(...)` never gets that treatment, before or after #1966.
    // What changed is WHY it's rejected — `helpers` is an unresolved
    // identifier now reached through the general method-call case, not "no
    // case for a property-access callee" — same divergence direction as the
    // test above.
    const source = `const bad = new Thing({ x: helpers.phase("Apply", []) });`;
    const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    const consts = collectConsts(sourceFile);
    const badInit = consts.get("bad") as ts.NewExpression;

    let error: unknown;
    try {
      foldResource(badInit, consts, []);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FoldError);
    expect((error as FoldError).message).toContain("unresolved identifier: helpers");

    const context: LintContext = { sourceFile, entities: [], filePath: "t.ts", lexicon: undefined };
    expect(evl001NonLiteralExpressionRule.check(context)).toHaveLength(0);
  });

  test("composite step access: NO LONGER a divergence (chant #1174) — both fold and EVL001 accept it", () => {
    // `Checkout({...}).step` — the single-action Composite() wrapper idiom
    // every lexicon's own docs/examples embed inline inside a Job's
    // `steps:` array. This was a documented, EVL-only-permissive divergence
    // from chant #1544 until #1174: `fold()` had no way to invoke an
    // arbitrary composite factory, so it fell the file back to run
    // (correct, not an error) while EVL001 already opted into treating the
    // shape as valid via a since-removed `allowCompositeStepAccess` flag.
    //
    // fold() now folds this to a `{__compositeStep, args}` envelope
    // (../fold/fold.ts) that ../discovery/fold-import.ts's bridge resolves
    // through the folding file's own imports — interpreted when the callee
    // is a project-file registered Composite (chant #1023), invoked for
    // real otherwise (every lexicon-package composite, which is what
    // `Checkout` is) — and reads `.step` off the REAL result. Kept as a
    // test rather than deleted: the assertion that the divergence stays
    // closed.
    const source = `const bad = new Thing({ x: Checkout({}).step });`;
    const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    const consts = collectConsts(sourceFile);
    const badInit = consts.get("bad") as ts.NewExpression;

    expect(foldResource(badInit, consts, [])).toEqual({
      __resource: "Thing",
      props: { x: { __compositeStep: "Checkout", args: [{}] } },
    });

    // findSubsetViolation (fold()'s own shared predicate, no opt-in needed
    // anymore) agrees the shape is admissible.
    const stepAccessExpr = (
      (badInit.arguments![0] as ts.ObjectLiteralExpression).properties[0] as ts.PropertyAssignment
    ).initializer;
    expect(findSubsetViolation(stepAccessExpr)).toBeUndefined();

    const context: LintContext = { sourceFile, entities: [], filePath: "t.ts", lexicon: undefined };
    expect(evl001NonLiteralExpressionRule.check(context)).toHaveLength(0);
  });

  test("nested resource construction: NO LONGER a divergence (chant #1169) — both fold and EVL001 accept it", () => {
    // This was the largest divergence in the table until #1169: a nested
    // `new Type()` as a property value could only fold to a {__resource, props}
    // envelope nothing constructed, so it would have serialized wrong (real
    // fold-vs-run drift, caught by the #1025 differential on gitlab), and fold()
    // rejected it while EVL allowed it.
    //
    // fold() now produces the envelope and ../discovery/fold-import.ts revives
    // it into a REAL instance of the class the file imported, so the two sides
    // agree. Kept as a test rather than deleted: it is the assertion that the
    // divergence stays closed, and that the envelope carries the nested
    // constructor's own name and props for the bridge to build from.
    const source = `const bad = new Thing({ x: new Inner({ y: 1 }) });`;
    const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    const consts = collectConsts(sourceFile);
    const badInit = consts.get("bad") as ts.NewExpression;

    expect(foldResource(badInit, consts, [])).toEqual({
      __resource: "Thing",
      props: { x: { __resource: "Inner", props: { y: 1 } } },
    });

    const context: LintContext = { sourceFile, entities: [], filePath: "t.ts", lexicon: undefined };
    expect(evl001NonLiteralExpressionRule.check(context)).toHaveLength(0);
  });

  test("same-file resource used as a bare value: fold rejects it (would build a duplicate); EVL001 allows it statically", () => {
    // chant #1169's own new divergence, in the same safe direction as every
    // other one here. `DependsOn: [dbCluster]` hands the run path THE instance
    // this file already exported; folding the identifier would construct a
    // SECOND one, which discovery never registers and whose AttrRefs can never
    // be named. Rejected, so the file falls back to run — where both references
    // are the same object by construction. EVL sees a plain identifier and has
    // no binding resolver (subset.ts module doc, point 1), so it stays
    // permissive.
    const source = `
      const db = new DbCluster({ engine: "aurora" });
      const bad = new Instance({ x: 1 }, { DependsOn: [db] });
    `;
    const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    const consts = collectConsts(sourceFile);
    const badInit = consts.get("bad") as ts.NewExpression;

    expect(() => foldResource(badInit, consts, [])).toThrow(FoldError);

    const context: LintContext = { sourceFile, entities: [], filePath: "t.ts", lexicon: undefined };
    expect(evl001NonLiteralExpressionRule.check(context)).toHaveLength(0);
  });
});

/**
 * chant #1044 — the shared predicate's optional intrinsic registry.
 *
 * `findSubsetViolation` answers "is this shape foldable?" for a caller that
 * has a registry and one that doesn't: with it, the answer for a call is
 * exact (fold()'s own); without it, every call is a violation, the
 * pre-#1044 answer. EVL001 (`chant lint`) is the first kind as of #1106 —
 * `runLint` threads the active lexicons' intrinsics onto
 * `LintContext.intrinsics`, which EVL001 forwards here — and the second
 * kind whenever a caller hasn't resolved a project's lexicons (a bare unit
 * test, a tool asking "would this fold?" with no lexicon context of its
 * own).
 */
describe("findSubsetViolation — optional intrinsic registry (#1044)", () => {
  const REF: IntrinsicDef[] = [{ name: "Ref", isTag: false, foldsAsCall: true }];

  /** The `x` initializer of `const bad = new Thing({ x: <expr> });`. */
  function propValue(expr: string, preamble = ""): ts.Expression {
    const sourceFile = ts.createSourceFile(
      "t.ts",
      `${preamble}\nconst bad = new Thing({ x: ${expr} });`,
      ts.ScriptTarget.Latest,
      true,
    );
    const consts = collectConsts(sourceFile);
    const init = consts.get("bad") as ts.NewExpression;
    const props = init.arguments![0] as ts.ObjectLiteralExpression;
    return (props.properties[0] as ts.PropertyAssignment).initializer;
  }

  test("with the registry supplied, an opted-in intrinsic call is not a violation — the same answer fold() gives", () => {
    expect(findSubsetViolation(propValue(`Ref(env)`), REF)).toBeUndefined();
    const consts = collectConsts(
      ts.createSourceFile("t.ts", `const env = "p"; const x = Ref(env);`, ts.ScriptTarget.Latest, true),
    );
    expect(fold(consts.get("x") as ts.Expression, consts, REF)).toEqual({ __intrinsic: "Ref", args: ["p"] });
  });

  test("with NO registry, every call stays a violation — the pre-#1044 answer, and the safe one", () => {
    const v = findSubsetViolation(propValue(`Ref(env)`));
    expect(v?.ruleId).toBe("EVL001");
    expect(v?.message).toContain("function call as a value is not foldable: Ref(...)");
  });

  test("the registry doesn't widen anything else: a name in it without the opt-in, a closure-taking method, and a plain call stay violations", () => {
    const notOptedIn: IntrinsicDef[] = [{ name: "Reference", isTag: false }];
    expect(findSubsetViolation(propValue(`Reference("db")`), notOptedIn)).toBeDefined();
    // chant #1966 — `aws.Ref("db")` is a method call (`Ref` reached through a
    // namespace, not a bare identifier), so it's no longer here: shape-wise
    // it's now the same resolution-dependent divergence
    // "method call on an unresolved receiver" documents above, unrelated to
    // whether `Ref` itself is opted into `foldsAsCall`.
    expect(findSubsetViolation(propValue(`cidrs.map((c) => c)`, `const cidrs = [];`), REF)).toBeDefined();
    expect(findSubsetViolation(propValue(`makeName("a")`), REF)).toBeDefined();
  });

  test("arguments are still classified on their own terms, at their own position", () => {
    const v = findSubsetViolation(propValue(`Ref(getName())`), REF);
    expect(v?.message).toContain("getName(...)");
  });

  test("EVL converges with fold on an opted-in call once it carries the registry (chant #1106)", () => {
    // chant #1044 left EVL001 with no registry (see subset.ts module doc,
    // point 2c), so it flagged `Ref(...)` in a resource's props even though
    // fold() — which is always given one — folded it cleanly. #1106 closes
    // that by threading `runLint`'s intrinsics parameter onto
    // `LintContext.intrinsics`, which EVL001 passes straight through to this
    // same `findSubsetViolation`/`checkObjectMember` predicate. A
    // `LintContext` built WITH the registry (what `chant lint` now
    // constructs for a real project) no longer flags what fold() accepts.
    const source = `const bad = new Thing({ x: Ref(env) });`;
    const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    const consts = collectConsts(sourceFile);
    const badInit = consts.get("bad") as ts.NewExpression;

    expect(() => foldResource(badInit, consts, REF)).not.toThrow();

    const context: LintContext = { sourceFile, entities: [], filePath: "t.ts", lexicon: undefined, intrinsics: REF };
    expect(evl001NonLiteralExpressionRule.check(context)).toHaveLength(0);
  });

  test("without the registry, EVL001 keeps the pre-#1044 conservative answer", () => {
    // A `LintContext` built without `intrinsics` (a caller that hasn't
    // resolved a project's lexicons) still flags the call — the safe
    // default subset.ts's module doc describes, unchanged by #1106.
    const source = `const bad = new Thing({ x: Ref(env) });`;
    const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    const context: LintContext = { sourceFile, entities: [], filePath: "t.ts", lexicon: undefined };
    expect(evl001NonLiteralExpressionRule.check(context).length).toBeGreaterThan(0);
  });
});

/**
 * chant #1054 — `briefNodeText` is what keeps every fold fallback reason
 * that used to embed a node's raw `getText()` down to one bounded line. A
 * real composite call's source is many lines; a fold reason that reproduces
 * it verbatim buries the actual error after all of it (the bug this issue
 * reports) and breaks any line-oriented consumer of `[fold:run]` output.
 */
describe("briefNodeText — single-line, bounded diagnostic text (chant #1054)", () => {
  function initializerOf(source: string): ts.Expression {
    const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
    const consts = collectConsts(sourceFile);
    const init = consts.get("x");
    if (!init) throw new Error(`fixture error: "x" did not parse in ${JSON.stringify(source)}`);
    return init;
  }

  test("a short, single-line node passes through unchanged", () => {
    expect(briefNodeText(initializerOf(`const x = GkeCluster;`))).toBe("GkeCluster");
  });

  test("a multi-line node's newlines collapse to spaces — the result is always one line", () => {
    const text = briefNodeText(
      initializerOf(`
        const x = GkeCluster({
          name: config.clusterName,
          location: config.region,
        });
      `),
    );
    expect(text).not.toContain("\n");
    expect(text.split("\n")).toHaveLength(1);
  });

  test("text over the length cap is truncated with a trailing marker rather than left unbounded", () => {
    const text = briefNodeText(
      initializerOf(`const x = { aVeryLongPropertyNameNumberOne: 1, aVeryLongPropertyNameNumberTwo: 2 };`),
      20,
    );
    expect(text.length).toBe(20);
    expect(text.endsWith("...")).toBe(true);
  });
});

describe("callExpressionMessage — one line regardless of the call's own argument list (chant #1054)", () => {
  test("only the callee is embedded — a multi-line argument list never leaks into the message", () => {
    const sourceFile = ts.createSourceFile(
      "t.ts",
      `
        const x = GkeCluster({
          name: config.clusterName,
          location: config.region,
          machineType: "n2-standard-2",
        });
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    const consts = collectConsts(sourceFile);
    const call = consts.get("x") as ts.CallExpression;

    const message = callExpressionMessage(call);

    expect(message).toBe("function call as a value is not foldable: GkeCluster(...)");
  });
});
