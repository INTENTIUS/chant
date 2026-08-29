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
