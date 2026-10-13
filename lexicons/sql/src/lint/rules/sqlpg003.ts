import type { LintContext, LintDiagnostic, LintRule } from "@intentius/chant/lint/rule";
import { isTrivia, SqlSyntaxError } from "../../postgres/tokens";
import { findPostgresTemplates, postgresTokensOf, tokenPosition } from "./postgres-templates";

const REGCLASS_FUNCTIONS = ["NEXTVAL", "CURRVAL", "SETVAL"];

/**
 * SQLPG003: an object named in a string where Postgres reads a `regclass`:
 * `nextval('app.ticket_seq')`, `currval(...)`, `setval(...)`, or
 * `'app.ticket_seq'::regclass`.
 *
 * A name inside a string is text to the build, so it records no reference:
 * the table does not depend on the sequence, the creation order can put the
 * table first, and the create fails. Interpolating the object instead,
 * `nextval(${ticketSeq})`, renders the same `regclass` literal the catalog
 * prints (`nextval('app.ticket_seq'::regclass)`) and keeps the edge. A
 * sequence another tool owns is the exception, which is why this is a
 * warning.
 */
export const sqlpg003: LintRule = {
  id: "SQLPG003",
  severity: "warning",
  category: "correctness",
  description: "A sequence or relation named in a regclass string makes no reference; interpolate the object",

  check(context: LintContext): LintDiagnostic[] {
    const source = context.sourceFile;
    const out: LintDiagnostic[] = [];
    for (const found of findPostgresTemplates(source)) {
      let tokens;
      try {
        tokens = postgresTokensOf(found);
      } catch (err) {
        if (err instanceof SqlSyntaxError) continue;
        throw err;
      }
      const sig = tokens.filter((t) => !isTrivia(t));
      sig.forEach((t, k) => {
        if (t.kind !== "string" || !t.text.startsWith("'")) return;
        const prev = sig[k - 1];
        const fn = sig[k - 2];
        const inCall =
          prev?.kind === "punct" && prev.text === "(" && fn?.kind === "ident" && REGCLASS_FUNCTIONS.includes(fn.text.toUpperCase());
        const cast = sig[k + 1]?.kind === "op" && sig[k + 1]!.text === "::" && sig[k + 2]?.kind === "ident" && sig[k + 2]!.text.toLowerCase() === "regclass";
        if (!inCall && !cast) return;
        const named = t.text.slice(1, -1).replace(/''/g, "'");
        const how = inCall ? `${fn!.text}(\${...})` : "${...}::regclass";
        out.push({
          ruleId: "SQLPG003",
          severity: "warning",
          message: `'${named}' names an object in a string, which records no reference, so the build can create this object before it; interpolate the declared object instead: ${how}`,
          file: context.filePath,
          ...tokenPosition(source, found, t),
        });
      });
    }
    return out;
  },
};
