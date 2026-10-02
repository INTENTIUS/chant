/**
 * TTL clauses: the whole grammar is overlay.
 *
 * No system table describes TTL. A table TTL is a list of rules, each an
 * expression evaluating to a `Date` or `DateTime` and an action; a column TTL
 * is a single expression with no action, after which the column resets to its
 * default. Which engines accept TTL at all is generated
 * (`capabilities.ttl` from `system.table_engines.supports_ttl`).
 *
 *     TTL expr [DELETE | RECOMPRESS codec | TO DISK 'd' | TO VOLUME 'v'] [WHERE cond]
 *         [, expr GROUP BY key_columns SET col = agg(col), ...]
 */

import type { ArgumentOverlay } from "./kinds";

export interface TtlAction {
  /** The keywords that open the action, as written. */
  keywords: string;
  /** What follows the keywords. */
  argument?: ArgumentOverlay;
  /** Whether a trailing `WHERE cond` may filter the rows it applies to. */
  where: boolean;
  /**
   * What the server's `SHOW CREATE` prints when the action is written as the
   * default. A declared `TTL ts + INTERVAL 1 DAY DELETE` reads back with
   * `DELETE` dropped, so a comparison must treat the two as one.
   */
  impliedWhenOmitted?: boolean;
}

export const TTL_ACTIONS: readonly TtlAction[] = [
  { keywords: "DELETE", where: true, impliedWhenOmitted: true },
  { keywords: "RECOMPRESS", argument: { kind: "codec", note: "A CODEC(...) expression." }, where: true },
  { keywords: "TO DISK", argument: { kind: "string", note: "A disk of the table's storage policy." }, where: true },
  { keywords: "TO VOLUME", argument: { kind: "string", note: "A volume of the table's storage policy." }, where: true },
  {
    keywords: "GROUP BY",
    argument: { kind: "columns", note: "A prefix of the sort key, then SET col = aggregate(col), ..." },
    where: true,
  },
];

/** A column TTL takes an expression and nothing else. */
export const COLUMN_TTL_ACTIONS: readonly TtlAction[] = [];

/** The types a TTL expression must evaluate to. */
export const TTL_RESULT_TYPES: readonly string[] = ["Date", "Date32", "DateTime", "DateTime64"];

/** MergeTree settings that change how TTL runs, for lint and hover to point at. */
export const TTL_SETTINGS: readonly string[] = [
  "merge_with_ttl_timeout",
  "merge_with_recompression_ttl_timeout",
  "ttl_only_drop_parts",
  "materialize_ttl_recalculate_only",
];
