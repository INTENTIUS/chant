import * as ts from "typescript";

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

// ---------------------------------------------------------------------------
// Shared message builders — `fold()` and `findSubsetViolation` both call
// these so the diagnostic text for the same violation kind is the same
// string, not two hand-written copies that can drift.
// ---------------------------------------------------------------------------

export function computedPropertyNameMessage(node: ts.PropertyName): string {
  return `computed/dynamic property name not foldable: ${node.getText()}`;
}

export function dynamicElementAccessMessage(keyNode: ts.Expression): string {
  return `dynamic property access — computed key must be a string or numeric literal: ${keyNode.getText()}`;
}

export const UNSUPPORTED_OBJECT_MEMBER_MESSAGE = "unsupported object member";

export const UNSUPPORTED_UNARY_MESSAGE = "unsupported unary";

export function unsupportedBinaryMessage(opKind: ts.SyntaxKind): string {
  return `unsupported binary operator: ${ts.SyntaxKind[opKind]}`;
}

export function callExpressionMessage(node: ts.CallExpression): string {
  return `function call as a value is not foldable: ${node.expression.getText()}(...)`;
}

export function unsupportedExpressionMessage(node: ts.Node): string {
  return `unsupported expression: ${ts.SyntaxKind[node.kind]}`;
}

export function resourceCtorArgMessage(typeName: string): string {
  return `resource constructor argument must be an object literal: ${typeName}(...)`;
}

/**
 * Classify one object-literal member (`{ a: 1 }`'s `a: 1`, `{ ...x }`'s
 * `...x`, or a shorthand `{ a }`). Checks the key's shape before the
 * value's, mirroring `propName()` in fold.ts, which runs before folding
 * the value. Returns the first violation within this member, or
 * `undefined` when it's fully in the subset.
 */
export function checkObjectMember(prop: ts.ObjectLiteralElementLike): SubsetViolation | undefined {
  if (ts.isPropertyAssignment(prop)) {
    if (!isLiteralPropertyName(prop.name)) {
      return violation(prop.name, computedPropertyNameMessage(prop.name));
    }
    return findSubsetViolation(prop.initializer);
  }
  if (ts.isShorthandPropertyAssignment(prop)) {
    return undefined;
  }
  if (ts.isSpreadAssignment(prop)) {
    return findSubsetViolation(prop.expression);
  }
  return violation(prop, UNSUPPORTED_OBJECT_MEMBER_MESSAGE);
}

/** Classify one array-literal element: a value, or a `...spread`. */
function checkArrayElement(el: ts.Expression): SubsetViolation | undefined {
  if (ts.isSpreadElement(el)) return findSubsetViolation(el.expression);
  return findSubsetViolation(el);
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
export function findSubsetViolation(node: ts.Node): SubsetViolation | undefined {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return findSubsetViolation(node.expression);
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
    // Tag registration is environment-dependent (see module doc) — shape
    // only classifies the interpolated values.
    const template = node.template;
    if (ts.isNoSubstitutionTemplateLiteral(template)) return undefined;
    for (const span of template.templateSpans) {
      const v = findSubsetViolation(span.expression);
      if (v) return v;
    }
    return undefined;
  }

  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const v = findSubsetViolation(span.expression);
      if (v) return v;
    }
    return undefined;
  }

  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      const v = checkObjectMember(prop);
      if (v) return v;
    }
    return undefined;
  }

  if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) {
      const v = checkArrayElement(el);
      if (v) return v;
    }
    return undefined;
  }

  if (ts.isPropertyAccessExpression(node)) {
    return findSubsetViolation(node.expression);
  }

  if (ts.isElementAccessExpression(node)) {
    if (!isLiteralElementKey(node.argumentExpression)) {
      return violation(node.argumentExpression, dynamicElementAccessMessage(node.argumentExpression), "EVL003");
    }
    return findSubsetViolation(node.expression);
  }

  if (ts.isPrefixUnaryExpression(node)) {
    if (!SUPPORTED_UNARY_OPERATORS.has(node.operator)) {
      return violation(node, UNSUPPORTED_UNARY_MESSAGE);
    }
    return findSubsetViolation(node.operand);
  }

  if (ts.isBinaryExpression(node)) {
    const opKind = node.operatorToken.kind;
    if (!SUPPORTED_BINARY_OPERATORS.has(opKind)) {
      return violation(node, unsupportedBinaryMessage(opKind));
    }
    // Flow-insensitive — see module doc: fold() short-circuits &&/||/?? and
    // only evaluates the taken side; EVL requires both sides shape-valid.
    return findSubsetViolation(node.left) ?? findSubsetViolation(node.right);
  }

  if (ts.isConditionalExpression(node)) {
    // Flow-insensitive — see module doc: fold() only folds the taken branch.
    return (
      findSubsetViolation(node.condition) ??
      findSubsetViolation(node.whenTrue) ??
      findSubsetViolation(node.whenFalse)
    );
  }

  if (ts.isNewExpression(node)) {
    const [firstArg] = node.arguments ?? [];
    if (!firstArg) return undefined;
    if (!ts.isObjectLiteralExpression(firstArg)) {
      return violation(firstArg, resourceCtorArgMessage(node.expression.getText()));
    }
    return findSubsetViolation(firstArg);
  }

  if (ts.isSpreadElement(node)) {
    return findSubsetViolation(node.expression);
  }

  if (ts.isCallExpression(node)) {
    return violation(node, callExpressionMessage(node));
  }

  return violation(node, unsupportedExpressionMessage(node));
}
