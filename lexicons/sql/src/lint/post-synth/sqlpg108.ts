import { baseType, checkOf, tablesOf } from "./postgres-helpers";

/**
 * SQLPG108: a varchar(n) column whose limit no CHECK or domain explains.
 *
 * Doc: https://www.postgresql.org/docs/18/datatype-character.html ("there is
 * no performance difference among these three types"; a length limit only
 * buys the check, and raising it later takes a table rewrite on old majors).
 * Reported only for a limit that is a round number such as 255, the habit of
 * other databases. Prior art: squawk prefer-text-field.
 */
export const sqlpg108 = checkOf({ id: "SQLPG108", description: "A varchar(n) column with a habitual length limit" }, (ctx, report) => {
  for (const t of tablesOf(ctx)) {
    for (const c of t.columns) {
      const type = (c.type ?? "").toLowerCase();
      const m = /^(?:varchar|character varying)\s*\(\s*(\d+)\s*\)$/.exec(type.trim());
      if (!m || baseType(type) !== "varchar" && baseType(type) !== "character varying") continue;
      const n = Number(m[1]);
      if (![50, 100, 128, 200, 250, 255, 256, 500, 512, 1000, 1024].includes(n)) continue;
      report({
        severity: "warning",
        message: `${t.export}.${c.name} is varchar(${n}); text performs the same, and a CHECK states a real length rule`,
        entity: t.export,
      });
    }
  }
});
