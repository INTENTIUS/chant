/**
 * PromQL syntax checking, with the grammar the Prometheus project publishes
 * (`@prometheus-io/lezer-promql`, the parser behind the Prometheus web UI's
 * editor).
 *
 * This is a syntax check: unbalanced brackets, a bad duration in a range
 * selector, an unknown function, two selectors with no operator between
 * them. It does not type-check (`rate` over an instant vector parses), which
 * `promtool check rules` does when it is available (see `tools.ts`).
 */

import { parser } from "@prometheus-io/lezer-promql";

/** The grammar package and the exact version this lexicon checks PromQL with. */
export const PROMQL_GRAMMAR = Object.freeze({ source: "@prometheus-io/lezer-promql", version: "0.315.0" });

export type PromqlCheck = { ok: true } | { ok: false; position: number; message: string };

function describe(expr: string, at: number): string {
  if (expr.trim() === "") return "the expression is empty";
  if (at >= expr.length) return `the expression ends early (after "${expr.slice(Math.max(0, at - 20)).trim()}")`;
  const before = expr.slice(Math.max(0, at - 20), at);
  const after = expr.slice(at, at + 20);
  return `syntax error at offset ${at}: "${before}" >>> "${after}"`;
}

/** Check one PromQL expression's syntax. */
export function checkPromql(expr: string): PromqlCheck {
  if (typeof expr !== "string" || expr.trim() === "") {
    return { ok: false, position: 0, message: "the expression is empty" };
  }
  const tree = parser.parse(expr);
  let errorAt: number | undefined;
  tree.iterate({
    enter: (node) => {
      if (errorAt !== undefined) return false;
      if (node.type.isError) {
        errorAt = node.from;
        return false;
      }
      return undefined;
    },
  });
  if (errorAt === undefined) return { ok: true };
  return { ok: false, position: errorAt, message: describe(expr, errorAt) };
}
