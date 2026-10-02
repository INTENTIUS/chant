import { checkOf, isTable, typeFamily } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

const FINE_FUNCTIONS =
  /\b(toStartOfSecond|toStartOfMinute|toStartOfFiveMinutes?|toStartOfTenMinutes|toStartOfFifteenMinutes|toStartOfHour|toRelativeSecondNum|toRelativeMinuteNum|toRelativeHourNum|toUnixTimestamp|toYYYYMMDDhhmmss|toStartOfInterval)\s*\(/;

/**
 * SQLCH112: a PARTITION BY finer than a day.
 *
 * Doc: https://clickhouse.com/docs/best-practices/choosing-a-partitioning-key
 * and the MergeTree page's note that partitioning is not meant to speed up
 * queries and that "you should not partition by too granular": every
 * partition is a separate set of parts, and the server stops inserts when a
 * table has too many (parts_to_throw_insert). Flags a bare DateTime column and
 * the sub-day truncation functions.
 */
export const sqlch112 = checkOf({ id: "SQLCH112", description: "A PARTITION BY expression is finer than a day" }, (ctx, report) => {
  for (const t of clickhouseObjects(ctx).filter(isTable)) {
    const expr = t.partitionBy?.trim();
    if (!expr) continue;
    const col = t.columns.find((c) => c.name === expr.replace(/^\(|\)$/g, "").trim());
    const bareDateTime = col?.type && ["DateTime", "DateTime64"].includes(typeFamily(col.type));
    if (!bareDateTime && !FINE_FUNCTIONS.test(expr)) continue;
    report({
      severity: "warning",
      message: `${t.export} (${t.name}) partitions by ${expr}, which makes a partition per second, minute or hour; partition by month or day`,
      entity: t.export,
    });
  }
});
