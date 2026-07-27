import * as ts from "typescript";
import { isFoldableHelperName } from "./foldable-helpers";
import { intrinsicCallFolds, type IntrinsicDef } from "../lexicon";

/**
 * subset — the single canonical definition of chant's statically-foldable
 * expression subset (chant #1024, epic #1019).
 *
 * `fold()` ({@link "./fold"}, the enforcement layer — a construct outside
 * this subset simply has no case there) and EVL001/EVL003
 * ({@link "../lint/rules/evl001-non-literal-expression"},
 * {@link "../lint/rules/evl003-dynamic-property-access"} — the pre-flight
 * diagnostic layer) both import this module so the two can never drift
 * apart on *which node kinds, operators, and key shapes* are foldable.
 * Before this module existed, `fold()` and EVL001 each hand-rolled their
 * own recursive classifier; they agreed almost everywhere but had several
 * real, silent gaps (see git history of #1024 for the enumerated list —
 * dynamic object-literal keys, template/tagged-template interiors, and
 * unrestricted binary/unary operators were all accepted by EVL001 but
 * rejected by `fold()`). This module is the fix: one classifier, two
 * importers.
 *
 * Scope — this module classifies *shape* only: the syntactic kind of an
 * expression, its operator, and (for keys) its literal-ness. It
 * deliberately does NOT resolve bindings or perform any evaluation, because
 * three things a full fold needs are inherently environment-dependent and
 * cannot be recovered from shape alone:
 *
 *   1. Identifier *resolution* — is a bare name actually a local `const`,
 *      vs. an unbound name? That needs the file's `consts` map. Both
 *      `fold()` and this module treat a bare identifier as shape-valid;
 *      `fold()` alone resolves it (and rejects if unresolved) once it has
 *      that map. A lint rule has no equivalent binding-resolution pass
 *      today, so EVL (via this module) stays permissive here — a known,
 *      intentional asymmetry, not a bug: it can only ever be a *false
 *      negative* on EVL's part (EVL passes something `fold()` might later
 *      reject for being unresolved), never the reverse.
 *   2. Tagged-template *tag registration* — needs a lexicon's intrinsics
 *      manifest, which isn't available to a syntax-only lint rule. `fold()`
 *      alone checks it; this module treats any tag name as shape-valid and
 *      only classifies the interpolated values.
 *   2b. Authoring-helper *provenance* (chant #1082) — a call to a registered
 *      chant helper (`phase(...)`, `output(...)`; ./foldable-helpers.ts)
 *      folds, but only when the name is genuinely bound to an import of
 *      chant's own. That needs the module graph, which a syntax-only lint
 *      rule doesn't have. This module checks the NAME only and stays
 *      permissive; `fold()`'s bridge does the provenance check and falls the
 *      file back to run when it fails. Same direction as every other item
 *      here — a false negative for EVL, never a false positive.
 *   2c. Intrinsic *call-form* registration (chant #1044) — a plain call to a
 *      lexicon intrinsic the lexicon opted in (`Ref(bucket)`,
 *      `Concat(a, b)`; `IntrinsicDef.foldsAsCall`, ../lexicon.ts) folds.
 *      Whether a given name is such an intrinsic is not knowable from shape,
 *      so {@link findSubsetViolation} takes the registry as an OPTIONAL
 *      parameter instead of guessing: supply it and the answer for a call is
 *      exact (fold()'s own), omit it and every call is a violation, the
 *      pre-#1044 answer.
 *
 *      That parameter is the whole reason the call case lives here rather
 *      than only in `fold()`. This module is a shared predicate, and the
 *      point of a shared predicate is that a consumer can ask "will this
 *      fold?" without running fold — a control plane deciding whether a
 *      repository needs a sandboxed child process at all, for instance.
 *      Keeping the case out of here would make the predicate answer "no" for
 *      idiomatic `Ref(...)` source that `fold()` reduces cleanly: not a
 *      permissive gap but a systematically WRONG answer in the expensive
 *      direction, and the one direction this module is not allowed to be
 *      wrong in (see the false-negative/false-positive rule in point 1, and
 *      the flow-sensitivity note below — the single divergence in the other
 *      direction, and the one this module treats as a wart). A caller with
 *      no registry degrades to "assume it runs", which is safe and cheap to
 *      reason about.
 *
 *      chant #1106 — EVL is no longer such a caller by default. `runLint`
 *      (../lint/engine.ts) takes the active lexicons' `IntrinsicDef[]` as a
 *      parameter and puts it on `LintContext.intrinsics`
 *      (../lint/rule.ts), and EVL001 (evl001-non-literal-expression.ts)
 *      passes it straight through to `checkObjectMember`. `chant lint`'s
 *      three CLI entry points (the `lint` command's initial pass, its
 *      `--fix` re-lint, and the LSP's per-file diagnostics) all resolve the
 *      project's lexicons and thread their intrinsics through, mirroring
 *      how `discover()` has done it for the fold path since #1039/#1105 —
 *      so `chant lint` on a real project no longer flags `Ref(...)` that
 *      `fold()` accepts. A `LintContext` built without that plumbing (a
 *      unit test constructing one directly, a consumer that hasn't
 *      resolved lexicons) still gets the pre-#1044 conservative answer —
 *      that path was never wrong, only stricter than it had to be.
 *   3. Runtime *type* of a folded value — e.g. spreading `const n = 5`
 *      (`{...n}`) is shape-valid (`n` is a plain identifier) but `fold()`
 *      rejects it once it discovers `n` folds to a number, not an object.
 *      Only real evaluation catches this; EVL004 independently narrows
 *      spread sources to a stricter "traceable to a const" shape, which
 *      catches most real-world misuse without evaluating, but is not a
 *      full substitute.
 *
 * One more inherent gap, on the *value-flow* side rather than shape:
 * `fold()` evaluates `&&`/`||`/`??` and `? :` lazily — it only folds the
 * side/branch actually taken, exactly like the JS runtime — so an
 * otherwise-unfoldable *untaken* branch does not reject
 * (`false && sideEffect()` folds cleanly to `false`). This module (and so
 * EVL) is flow-insensitive: it has no notion of "taken", so it requires
 * every operand/branch to be shape-valid. This can only make EVL *stricter*
 * than `fold()` (a false positive relative to fold, flagging code the
 * folder would actually accept) — never the reverse. Making EVL
 * flow-sensitive would mean re-implementing an evaluator inside a lint
 * rule; out of scope here. See #1024.
 */

/** The two EVL rule ids a shape violation can be attributed to. */
export type SubsetRuleId = "EVL001" | "EVL003";

/** A located, shape-level rejection: the offending node, the EVL rule id it maps to, and a message. */
export interface SubsetViolation {
  node: ts.Node;
  ruleId: SubsetRuleId;
  message: string;
}

function violation(node: ts.Node, message: string, ruleId: SubsetRuleId = "EVL001"): SubsetViolation {
  return { node, ruleId, message };
}

/** Binary operators `fold()` implements — see `fold()`'s operator switch in ./fold.ts. */
export const SUPPORTED_BINARY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.LessThanEqualsToken,
]);

/** Prefix unary operators `fold()` implements: logical-not and numeric negation. */
export const SUPPORTED_UNARY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ExclamationToken,
  ts.SyntaxKind.MinusToken,
]);

/** A property name foldable without execution: identifier, string, or numeric literal (not a computed name). */
export function isLiteralPropertyName(
  node: ts.PropertyName,
): node is ts.Identifier | ts.StringLiteral | ts.NumericLiteral {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node);
}

/** An element-access key foldable without execution: a string or numeric LITERAL only (EVL003 semantics). */
export function isLiteralElementKey(node: ts.Expression): node is ts.StringLiteral | ts.NumericLiteral {
  return ts.isStringLiteral(node) || ts.isNumericLiteral(node);
}

/**
 * A short, single-line rendering of `node`'s source text for embedding in a
 * diagnostic message — never the raw `getText()`, which reproduces the
 * node's ENTIRE source verbatim and can span dozens of lines for a real
 * composite call or object literal (chant #1054: a fold fallback reason that
 * embeds one of these buries the actual error after it, and breaks any
 * line-oriented consumer of `[fold:run]` output). Internal whitespace
 * (including newlines) collapses to a single space, and the result is capped
 * to a bounded length so one pathological node can't blow out an otherwise
 * one-line reason either.
 */
export function briefNodeText(node: ts.Node, maxLength = 60): string {
  const collapsed = node.getText().replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 3)}...` : collapsed;
}

// ---------------------------------------------------------------------------
// Shared message builders — `fold()` and `findSubsetViolation` both call
// these so the diagnostic text for the same violation kind is the same
// string, not two hand-written copies that can drift.
// ---------------------------------------------------------------------------

export function computedPropertyNameMessage(node: ts.PropertyName): string {
  return `computed/dynamic property name not foldable: ${briefNodeText(node)}`;
}

export function dynamicElementAccessMessage(keyNode: ts.Expression): string {
  return `dynamic property access — computed key must be a string or numeric literal: ${briefNodeText(keyNode)}`;
}

export const UNSUPPORTED_OBJECT_MEMBER_MESSAGE = "unsupported object member";

export const UNSUPPORTED_UNARY_MESSAGE = "unsupported unary";

export function unsupportedBinaryMessage(opKind: ts.SyntaxKind): string {
  return `unsupported binary operator: ${ts.SyntaxKind[opKind]}`;
}

/**
 * chant #1054 — the ONE wording for "a bare function/method call used where
 * chant needs a value it can fold." Before this, `fold()` (this message) and
 * `../discovery/fold-import.ts`'s `resolveCallExpression` (a top-level
 * export's own call-as-a-value check) had each grown their own hand-written
 * copy — "function call as a value" here, "call expression as a value"
 * there — for the identical rejection, which meant a tool grouping fallback
 * reasons by text had to match both to avoid silently under-counting one of
 * them. `resolveCallExpression` now calls this function directly instead of
 * building its own string.
 */
export function callExpressionMessage(node: ts.CallExpression): string {
  return `function call as a value is not foldable: ${briefNodeText(node.expression)}(...)`;
}

export function unsupportedExpressionMessage(node: ts.Node): string {
  return `unsupported expression: ${ts.SyntaxKind[node.kind]}`;
}

/**
 * Classify one object-literal member (`{ a: 1 }`'s `a: 1`, `{ ...x }`'s
 * `...x`, or a shorthand `{ a }`). Checks the key's shape before the
 * value's, mirroring `propName()` in fold.ts, which runs before folding
 * the value. Returns the first violation within this member, or
 * `undefined` when it's fully in the subset.
 */
export function checkObjectMember(
  prop: ts.ObjectLiteralElementLike,
  intrinsics?: readonly IntrinsicDef[],
): SubsetViolation | undefined {
  if (ts.isPropertyAssignment(prop)) {
    if (!isLiteralPropertyName(prop.name)) {
      return violation(prop.name, computedPropertyNameMessage(prop.name));
    }
    return findSubsetViolation(prop.initializer, intrinsics);
  }
  if (ts.isShorthandPropertyAssignment(prop)) {
    return undefined;
  }
  if (ts.isSpreadAssignment(prop)) {
    return findSubsetViolation(prop.expression, intrinsics);
  }
  return violation(prop, UNSUPPORTED_OBJECT_MEMBER_MESSAGE);
}

/** Classify one array-literal element: a value, or a `...spread`. */
function checkArrayElement(
  el: ts.Expression,
  intrinsics?: readonly IntrinsicDef[],
): SubsetViolation | undefined {
  if (ts.isSpreadElement(el)) return findSubsetViolation(el.expression, intrinsics);
  return findSubsetViolation(el, intrinsics);
}

/**
 * The canonical recursive shape classifier: is `node`'s expression *shape*
 * within the subset `fold()` can reduce? Mirrors `fold()`'s own dispatch
 * node-kind for node-kind (see ./fold.ts) — every branch here has a
 * matching branch there, and vice versa — but performs no
 * resolution/evaluation (see the module doc comment for the three
 * environment-dependent exceptions). Returns the first (deepest,
 * `fold()`-evaluation-order) unsupported node, or `undefined` when `node`'s
 * whole shape is foldable.
 */
export function findSubsetViolation(
  node: ts.Node,
  intrinsics?: readonly IntrinsicDef[],
): SubsetViolation | undefined {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return findSubsetViolation(node.expression, intrinsics);
  }

  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return undefined;
  }

  // Identifiers (including a bare `undefined` reference, which the parser
  // represents as an Identifier, not a keyword token) — resolution is
  // environment-dependent, see module doc.
  if (ts.isIdentifier(node)) return undefined;

  if (ts.isTaggedTemplateExpression(node)) {
    // Tagged-template interiors are OPAQUE to the shape classifier. A tagged
    // template may be a registered lexicon intrinsic (e.g. Sub`...`) whose
    // interpolations legitimately contain deploy-time intrinsic references
    // (Ref(env), AWS.StackName, ...) — valid, but not statically foldable. EVL
    // has no intrinsic registry at lint time (see module doc), so it cannot tell
    // an intrinsic call from a plain one; recursing here would false-flag Ref()
    // inside Sub`...` and break every intrinsic-using example. fold() DOES have
    // the registry: it recurses into a *registered* tag's interior itself
    // (foldIntrinsicValue) and rejects an unfoldable one there. So an unfoldable
    // tagged-template interior is a documented fold/EVL divergence, not a hole.
    return undefined;
  }

  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const v = findSubsetViolation(span.expression, intrinsics);
      if (v) return v;
    }
    return undefined;
  }

  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      const v = checkObjectMember(prop, intrinsics);
      if (v) return v;
    }
    return undefined;
  }

  if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) {
      const v = checkArrayElement(el, intrinsics);
      if (v) return v;
    }
    return undefined;
  }

  if (ts.isPropertyAccessExpression(node)) {
    return findSubsetViolation(node.expression, intrinsics);
  }

  if (ts.isElementAccessExpression(node)) {
    if (!isLiteralElementKey(node.argumentExpression)) {
      return violation(node.argumentExpression, dynamicElementAccessMessage(node.argumentExpression), "EVL003");
    }
    return findSubsetViolation(node.expression, intrinsics);
  }

  if (ts.isPrefixUnaryExpression(node)) {
    if (!SUPPORTED_UNARY_OPERATORS.has(node.operator)) {
      return violation(node, UNSUPPORTED_UNARY_MESSAGE);
    }
    return findSubsetViolation(node.operand, intrinsics);
  }

  if (ts.isBinaryExpression(node)) {
    const opKind = node.operatorToken.kind;
    if (!SUPPORTED_BINARY_OPERATORS.has(opKind)) {
      return violation(node, unsupportedBinaryMessage(opKind));
    }
    // Flow-insensitive — see module doc: fold() short-circuits &&/||/?? and
    // only evaluates the taken side; EVL requires both sides shape-valid.
    return findSubsetViolation(node.left, intrinsics) ?? findSubsetViolation(node.right, intrinsics);
  }

  if (ts.isConditionalExpression(node)) {
    // Flow-insensitive — see module doc: fold() only folds the taken branch.
    return (
      findSubsetViolation(node.condition, intrinsics) ??
      findSubsetViolation(node.whenTrue, intrinsics) ??
      findSubsetViolation(node.whenFalse, intrinsics)
    );
  }

  if (ts.isNewExpression(node)) {
    // chant #1082 — no positional assumption about which argument is the
    // props object. `foldResource` folds every argument in source order (the
    // props object is second in `new Parameter("String", {...})`), so every
    // argument is classified on its own terms and nothing is rejected merely
    // for being in the "wrong" position.
    for (const arg of node.arguments ?? []) {
      const v = findSubsetViolation(arg, intrinsics);
      if (v) return v;
    }
    return undefined;
  }

  if (ts.isSpreadElement(node)) {
    return findSubsetViolation(node.expression, intrinsics);
  }

  if (ts.isCallExpression(node)) {
    // chant #1082 — a call to a REGISTERED chant authoring helper folds
    // (`phase(...)`, `output(...)`, …; see ./foldable-helpers.ts), so this
    // classifier must accept it too or EVL001 would flag source `fold()`
    // reduces cleanly. Name-only here, deliberately: this module classifies
    // shape and never resolves bindings (module doc, point 1), and the
    // provenance half of the check — is this name actually bound to an import
    // of chant's own? — needs the module graph, which only
    // ../discovery/fold-import.ts has. Same asymmetry as intrinsic tag
    // registration (point 2) and in the same direction: this module can only
    // ever be MORE permissive than `fold()`, never stricter.
    if (ts.isIdentifier(node.expression) && isFoldableHelperName(node.expression.text)) {
      for (const arg of node.arguments) {
        const v = findSubsetViolation(arg, intrinsics);
        if (v) return v;
      }
      return undefined;
    }

    // chant #1044 — a plain call to a lexicon intrinsic whose lexicon opted
    // its call form in folds too (`Ref(bucket)`, `Concat("a", b)`). Unlike
    // the helper case above, this one is only answerable with the registry
    // in hand, which is exactly why it is a parameter: a caller that passes
    // `intrinsics` gets fold()'s own answer, and a caller that can't supply
    // one (EVL, any syntax-only tool) keeps the pre-#1044 answer — every
    // call is a violation. See the module doc, point 2c, for why the
    // registry-less answer is the safe one to leave in place.
    if (
      intrinsics &&
      ts.isIdentifier(node.expression) &&
      intrinsics.some((i) => i.name === (node.expression as ts.Identifier).text && intrinsicCallFolds(i))
    ) {
      for (const arg of node.arguments) {
        const v = findSubsetViolation(arg, intrinsics);
        if (v) return v;
      }
      return undefined;
    }

    return violation(node, callExpressionMessage(node));
  }

  return violation(node, unsupportedExpressionMessage(node));
}
