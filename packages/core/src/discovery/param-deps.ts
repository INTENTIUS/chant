import * as ts from "typescript";
import type { PathOrigin } from "../provenance";

/**
 * Which build parameters an authored props expression READS, per path (chant
 * #1443) — the declared-side counterpart of `managed-fields.ts`'s per-path live
 * `owners`.
 *
 * This is a syntactic dependency, not a value taint. Fold substitutes
 * `params.<name>` before anything is emitted, so by output time the value is a
 * literal and indistinguishable from one typed by hand; tainting the value
 * through fold's evaluator would mean propagating a tag through every operator
 * it supports, and one operator that forgot would produce silently wrong
 * provenance. Recording which parameters the *expression* mentions cannot
 * degrade that way: a shape this walk does not follow drops a dependency, it
 * never invents one.
 *
 * It also answers the more useful question. For
 * `replicas: params.tier === "prod" ? 5 : 1`, a taint reports that the value
 * came from the literal `5` — true, and no help to anyone about to edit the
 * field. The dependency reports that the field is governed by `tier`.
 *
 * Known under-reporting, all in the safe direction: destructured parameters
 * (`const { tier } = params`) are not tracked, because `collectConsts` only
 * records identifier bindings; a bare reference to the whole `params` object
 * names no single parameter and records nothing; and the run path has no
 * expression to walk at all.
 *
 * The one direction it can over-report is a local binding that shadows a
 * top-level `const` of the same name, since names resolve against the file's
 * consts without scope tracking. That reports a parameter the field could
 * plausibly be governed by rather than one it definitely is, which is the
 * failure the "could affect" reading is written to absorb.
 *
 * {@link collectCompositeOrigins} (chant #2161) is the same walk pointed at a
 * different parameter object: a composite factory's own props, inside a body
 * the fold interprets. It shares the path grammar, the const-following and the
 * under-reporting posture, and adds the one answer a build parameter has no use
 * for — a path that reads no parameter at all, which for a composite means the
 * field is fixed.
 */

/** The property name a member declares, when it is a literal one. */
function literalName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** Strip the wrappers that do not change what an initializer reads. */
function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * Every parameter name `expr` reads, following this file's own top-level
 * `const` bindings so a value hoisted into a local is still attributed
 * (`const replicas = params.tier === "prod" ? 5 : 1` used as `replicas`).
 */
function readParams(
  expr: ts.Expression,
  consts: ReadonlyMap<string, ts.Expression>,
  paramLocals: ReadonlySet<string>,
  out: Set<string>,
): void {
  const followed = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && paramLocals.has(node.expression.text)) {
        out.add(node.name.text);
        return;
      }
      visit(node.expression);
      return;
    }

    if (ts.isElementAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && paramLocals.has(node.expression.text)) {
        if (ts.isStringLiteralLike(node.argumentExpression)) out.add(node.argumentExpression.text);
      } else {
        visit(node.expression);
      }
      visit(node.argumentExpression);
      return;
    }

    if (ts.isIdentifier(node)) {
      // A bare `params` names no single parameter — see the under-reporting
      // note above.
      if (paramLocals.has(node.text)) return;
      const initializer = consts.get(node.text);
      if (initializer && !followed.has(node.text)) {
        followed.add(node.text);
        visit(initializer);
      }
      return;
    }

    // A property KEY is not a reference; without this a nested `{ tier: 1 }`
    // would resolve `tier` against `consts` and manufacture a dependency.
    if (ts.isPropertyAssignment(node)) {
      visit(node.initializer);
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(expr);
}

/**
 * Path → build-parameter origin for one resource's props object literal.
 *
 * Paths are dotted property names only, per `EntityProvenance.paths`: an object
 * literal is descended into, and anything else — an array literal included — is
 * attributed whole at its own path. An array's elements are deliberately not
 * indexed, because an index-shaped key would not survive an element moving and
 * would not match the `[#key]` addressing a diff uses.
 *
 * A spread is attributed to the object it spreads INTO, at that object's own
 * path (the entity root for a top-level spread), since which keys it
 * contributes is not knowable here.
 */
export function collectParamDependencies(
  props: ts.ObjectLiteralExpression,
  consts: ReadonlyMap<string, ts.Expression>,
  paramLocals: ReadonlySet<string>,
): Record<string, PathOrigin> {
  const out: Record<string, PathOrigin> = {};
  if (paramLocals.size === 0) return out;

  const record = (path: string, expr: ts.Expression): void => {
    const found = new Set<string>();
    readParams(expr, consts, paramLocals, found);
    if (found.size === 0) return;
    const existing = out[path];
    const merged =
      existing && existing.kind === "build-param" ? new Set([...existing.params, ...found]) : found;
    out[path] = { kind: "build-param", params: [...merged].sort() };
  };

  const walk = (object: ts.ObjectLiteralExpression, prefix: string): void => {
    for (const member of object.properties) {
      if (ts.isSpreadAssignment(member)) {
        record(prefix, member.expression);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(member)) {
        const key = member.name.text;
        record(prefix ? `${prefix}.${key}` : key, member.name);
        continue;
      }
      if (!ts.isPropertyAssignment(member)) continue;
      const key = literalName(member.name);
      if (key === undefined) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const initializer = unwrap(member.initializer);
      if (ts.isObjectLiteralExpression(initializer)) {
        walk(initializer, path);
        continue;
      }
      record(path, member.initializer);
    }
  };

  walk(props, "");
  return out;
}

/**
 * The factory-parameter names in scope inside one composite body (chant #2161).
 *
 * A `Composite()` factory takes at most one argument, so a parameter path is a
 * path INTO that argument: `props.scaling.max` is the parameter path
 * `scaling.max`. Two binding forms reach the same place — `(props) => …` binds
 * the whole object under one name, `({ name, port }) => …` binds leaves — so
 * the scope carries both.
 */
export interface CompositeParamScope {
  /** Local names bound to the whole props object (`(props) => …`). */
  whole: ReadonlySet<string>;
  /** Local name → the parameter path it was destructured from (`({ name }) => …`). */
  destructured: ReadonlyMap<string, string>;
}

/** The parameter path `node` addresses, or `undefined` when it is not rooted at one. */
function parameterPathOf(node: ts.Expression, scope: CompositeParamScope): string | undefined {
  const segments: string[] = [];
  let current: ts.Expression = node;
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      segments.unshift(current.name.text);
      current = current.expression;
      continue;
    }
    if (ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression)) {
      segments.unshift(current.argumentExpression.text);
      current = current.expression;
      continue;
    }
    break;
  }
  if (!ts.isIdentifier(current)) return undefined;
  if (scope.whole.has(current.text)) {
    // A bare `props` addresses no single parameter — the same call the
    // build-param collector makes about a bare `params`.
    return segments.length === 0 ? undefined : segments.join(".");
  }
  const base = scope.destructured.get(current.text);
  if (base === undefined) return undefined;
  return segments.length === 0 ? base : `${base}.${segments.join(".")}`;
}

/**
 * True for a `const` bound to a sibling ENTITY rather than to a value: a
 * `new Type(...)`, or a call (a nested composite, a helper).
 *
 * Following one would answer the wrong question. `const bucket = new Bucket({
 * BucketName: props.name })` and then `Description: bucket.Arn` reads a
 * reference to a sibling the composite wired up, not the value of `name`.
 * Chasing it would report `Description` as governed by `name`, and the return
 * leg would propose editing `name` to fix a field that is a cross-reference. A
 * field wired inside the composite is one the composite fixes, and the refusal
 * is the right answer.
 */
function isEntityBinding(initializer: ts.Expression): boolean {
  const expr = unwrap(initializer);
  return ts.isNewExpression(expr) || ts.isCallExpression(expr);
}

/**
 * Every factory parameter path `expr` reads, following `consts` so a value
 * hoisted into a body-local `const` is still attributed.
 */
function readCompositeParameters(
  expr: ts.Expression,
  consts: ReadonlyMap<string, ts.Expression>,
  scope: CompositeParamScope,
  out: Set<string>,
): void {
  const followed = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const path = parameterPathOf(node as ts.Expression, scope);
      if (path !== undefined) {
        out.add(path);
        return;
      }
      visit(node.expression);
      if (ts.isElementAccessExpression(node)) visit(node.argumentExpression);
      return;
    }

    if (ts.isIdentifier(node)) {
      const path = parameterPathOf(node, scope);
      if (path !== undefined) {
        out.add(path);
        return;
      }
      if (scope.whole.has(node.text)) return;
      const initializer = consts.get(node.text);
      if (initializer && !followed.has(node.text) && !isEntityBinding(initializer)) {
        followed.add(node.text);
        visit(initializer);
      }
      return;
    }

    // A property KEY is not a reference — see `readParams` for the same guard.
    if (ts.isPropertyAssignment(node)) {
      visit(node.initializer);
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(expr);
}

/**
 * Path → composite origin for one `new Type({...})` inside an interpreted
 * composite factory body (chant #2161).
 *
 * Same walk, same path grammar and the same under-reporting posture as
 * {@link collectParamDependencies}, with one added answer: a path whose
 * expression reads NO parameter is recorded as `composite-literal` rather than
 * left silent, because "the composite fixes this" is a finding in its own
 * right — it is what the reconcile refuses on.
 *
 * A spread is the one place nothing is recorded when no parameter is found.
 * Which keys it contributes is not knowable here, so `composite-parameter` at
 * the containing object is a safe over-approximation of "a parameter governs
 * something under here", while `composite-literal` would be a claim that every
 * key it brings is fixed. That claim is left unmade, and those paths come back
 * `unknown` from ../fold-provenance.ts instead.
 */
export function collectCompositeOrigins(
  props: ts.ObjectLiteralExpression,
  consts: ReadonlyMap<string, ts.Expression>,
  scope: CompositeParamScope,
  composite: string,
): Record<string, PathOrigin> {
  const out: Record<string, PathOrigin> = {};

  const parametersOf = (expr: ts.Expression): string[] => {
    const found = new Set<string>();
    readCompositeParameters(expr, consts, scope, found);
    return [...found].sort();
  };

  const record = (path: string, expr: ts.Expression, spread: boolean): void => {
    const parameters = parametersOf(expr);
    if (parameters.length > 0) {
      const existing = out[path];
      const merged =
        existing && existing.kind === "composite-parameter"
          ? [...new Set([...existing.parameters, ...parameters])].sort()
          : parameters;
      out[path] = { kind: "composite-parameter", composite, parameters: merged };
      return;
    }
    if (spread) return;
    out[path] ??= { kind: "composite-literal", composite };
  };

  const walk = (object: ts.ObjectLiteralExpression, prefix: string): void => {
    for (const member of object.properties) {
      if (ts.isSpreadAssignment(member)) {
        record(prefix, member.expression, true);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(member)) {
        const key = member.name.text;
        record(prefix ? `${prefix}.${key}` : key, member.name, false);
        continue;
      }
      if (!ts.isPropertyAssignment(member)) continue;
      const key = literalName(member.name);
      if (key === undefined) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const initializer = unwrap(member.initializer);
      if (ts.isObjectLiteralExpression(initializer)) {
        walk(initializer, path);
        continue;
      }
      record(path, member.initializer, false);
    }
  };

  walk(props, "");
  return out;
}
