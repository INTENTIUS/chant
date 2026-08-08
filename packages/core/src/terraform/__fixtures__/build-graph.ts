import { buildGraph, collectExpressions, type ExpressionRefs } from "../graph";
import type { Hcl2JsonTree, TfGraph } from "../types";

/**
 * Test-only stand-in for the hcl2json expression AST (`parse.ts`'s
 * `resolveExpressionRefs`). Fixture expressions are simple `${<accessor>}`
 * templates, so each one's accessor list is just its interpolation bodies.
 * Production never takes this path — `parseTerraformDir` resolves every
 * expression through `getReferencesInExpression`.
 */
export function fixtureExprRefs(tree: Hcl2JsonTree): ExpressionRefs {
  const refs = new Map<string, string[]>();
  for (const expr of collectExpressions(tree)) {
    refs.set(
      expr,
      [...expr.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim()),
    );
  }
  return refs;
}

/** `buildGraph` over a hand-written fixture tree, accessors derived per {@link fixtureExprRefs}. */
export function buildFixtureGraph(tree: Hcl2JsonTree): TfGraph {
  return buildGraph(tree, fixtureExprRefs(tree));
}
