import { checkOf, isTable } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

/**
 * SQLCH108: CREATE OR REPLACE TABLE in a database whose engine is not Atomic
 * (or Replicated, which is Atomic underneath).
 *
 * Doc: https://clickhouse.com/docs/sql-reference/statements/create/table
 * ("The REPLACE query is supported only for Atomic and Replicated databases"),
 * and https://clickhouse.com/docs/engines/database-engines/atomic for
 * EXCHANGE TABLES. Judged against a database the same build declares.
 */
export const sqlch108 = checkOf({ id: "SQLCH108", description: "CREATE OR REPLACE TABLE in a database that is not Atomic" }, (ctx, report) => {
  const objects = clickhouseObjects(ctx);
  const databases = new Map(objects.filter((o) => o.type === "ClickHouse::Database").map((d) => [d.name, d]));
  for (const t of objects.filter(isTable)) {
    if (!t.orReplace || !t.database) continue;
    const db = databases.get(t.database);
    const engine = db?.engine?.name;
    if (!db || !engine || engine === "Atomic" || engine === "Replicated") continue;
    report({
      severity: "error",
      message: `${t.export} (${t.name}) is CREATE OR REPLACE in database ${t.database}, whose engine is ${engine}; REPLACE needs Atomic or Replicated`,
      entity: t.export,
    });
  }
});
