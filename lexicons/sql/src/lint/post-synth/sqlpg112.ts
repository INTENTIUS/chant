import { checkOf, tablesOf } from "./postgres-helpers";

const SENSITIVE = /(^|_)(password|passwd|pwd|secret|token|api_?key|ssn|social_security|tax_id|credit_card|card_number|cvv|iban|passport|date_of_birth|dob|email|phone|address)(_|$)/i;

/**
 * SQLPG112: a secret- or PII-named column in a table with no comment.
 *
 * Doc: https://www.postgresql.org/docs/18/sql-comment.html. A COMMENT on the
 * table or the column is where the retention, encryption or masking rule is
 * written down, and where pg_dump, anonymizers and catalog scanners read it.
 * A column or a table comment satisfies the check.
 */
export const sqlpg112 = checkOf({ id: "SQLPG112", description: "A secret- or PII-named column with no comment on it or its table" }, (ctx, report) => {
  for (const t of tablesOf(ctx)) {
    if (t.comment) continue;
    for (const c of t.columns) {
      if (c.comment || !SENSITIVE.test(c.name)) continue;
      report({
        severity: "warning",
        message: `${t.export}.${c.name} looks like a secret or personal data and neither it nor ${t.sqlName} has a COMMENT; say what it holds and how it is protected`,
        entity: t.export,
      });
    }
  }
});
