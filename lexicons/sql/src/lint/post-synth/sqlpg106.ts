import { baseType, checkOf, tablesOf } from "./postgres-helpers";

/**
 * SQLPG106: a char(n) column.
 *
 * Doc: https://www.postgresql.org/docs/18/datatype-character.html ("there is
 * no performance advantage to character(n) ... it takes more storage because
 * of the blank padding"). Prior art: squawk ban-char-field.
 */
export const sqlpg106 = checkOf({ id: "SQLPG106", description: "A char(n) column" }, (ctx, report) => {
  for (const t of tablesOf(ctx)) {
    for (const c of t.columns) {
      const type = baseType(c.type);
      if (type !== "char" && type !== "character" && type !== "bpchar") continue;
      report({
        severity: "warning",
        message: `${t.export}.${c.name} is ${c.type}, which pads with blanks; use text, or varchar(n) for a length rule`,
        entity: t.export,
      });
    }
  }
});
