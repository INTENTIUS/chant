/**
 * chant's ownership marker on ClickHouse objects (#3208): a trailer on the
 * object's own `COMMENT`.
 *
 * ClickHouse objects carry no tags or labels. The channels considered:
 *
 * - The object `COMMENT`. Every object kind has one (a table of any engine, a
 *   view, a materialized view, a database), it is set in the `CREATE` itself
 *   so an object is never created unmarked, `MODIFY COMMENT` restamps it, and
 *   `system.tables` / `system.databases` return it with the catalog read
 *   observation already makes. The #3046 candidate.
 * - Table `SETTINGS`: a MergeTree table refuses a setting it does not know.
 * - A registry table on the server naming the objects chant created: a record
 *   apart from the object, which is the state file chant does not keep, and
 *   one that goes on claiming a table someone dropped and created again.
 *
 * So the comment, and the question is the user's own comment, which is a
 * declared property (`COMMENT 'Raw events'`, classified by SQLCH203). The
 * marker never replaces it: it is appended as a bracketed trailer,
 *
 *     COMMENT 'Raw events [chant managed-by=chant stack=shop env=prod]'
 *
 * and taken off again wherever chant reads a definition (`readLiveSchema`
 * strips it from `SHOW CREATE`), so planning, the deep diff and import compare
 * and write the declared comment alone. Someone who edits the comment by hand
 * and drops the trailer makes the object read as foreign, which is the safe
 * direction: it is never pruned, and the next apply of its declaration
 * stamps it again.
 *
 * Values are percent-encoded outside `[A-Za-z0-9._-]`, so the trailer never
 * holds a quote, a backslash, a space or a bracket of its own.
 *
 * The trailer itself is the shared core's (`../core/ownership.ts`), the same in
 * every dialect. What is ClickHouse's here: the channel the plugin declares,
 * taking the trailer off a printed `COMMENT '...'` clause, and the trailer keys
 * of the rebuild migration's working objects.
 */

import type { ChannelKeys, OwnershipChannel } from "@intentius/chant/ownership";
import { COMMENT_OWNERSHIP_KEYS, RECEIPTS_TRAILER_KEY, TRAILER_PAIR, hasChantTrailerKey } from "../core/ownership";

export {
  carriesMarker,
  isChantManaged,
  markerTrailer,
  readMarker,
  readTrailerPairs,
  RECEIPTS_TRAILER_KEY,
  stampedComment,
  stripMarker,
  type CommentMarker,
} from "../core/ownership";

/** The keys inside the trailer. */
export const CLICKHOUSE_COMMENT_OWNERSHIP_KEYS: ChannelKeys = COMMENT_OWNERSHIP_KEYS;

/**
 * Where the marker is read back (#1348): `describeResources` and
 * `exportResources` read the comment from `system.tables` and
 * `system.databases`. The deep read takes it off with the rest of `SHOW CREATE`
 * and reports no verdict.
 */
export const SQL_OWNERSHIP_CHANNEL: OwnershipChannel = {
  keys: CLICKHOUSE_COMMENT_OWNERSHIP_KEYS,
  reads: ["describeResources", "exportResources"],
};

/** A comment that is the trailer alone, in a printed statement: the whole `COMMENT '...'` clause. */
const ONLY_TRAILER_CLAUSE = new RegExp(`\\s*\\bCOMMENT\\s+'\\[chant(?: ${TRAILER_PAIR})+\\]'`, "g");
/** The trailer inside a printed comment literal, just before its closing quote. */
const TRAILER_IN_LITERAL = new RegExp(`\\s+\\[chant(?: ${TRAILER_PAIR})+\\]'`, "g");

/**
 * The trailer key naming the table a rebuild migration object belongs to
 * (`./rebuild/`). An object carrying it is the rebuild's own working object,
 * not a declaration: a new table being filled, the dual-write view, an old
 * table being retained. Reading a schema leaves those out
 * (`./live/catalog.ts`), so a plan, an import or a prune never sees them.
 */
export const REBUILD_TRAILER_KEY = "rebuild";

/** Whether a comment marks a rebuild migration's working object. */
export function isRebuildObject(comment: string | undefined): boolean {
  return hasChantTrailerKey(comment, [REBUILD_TRAILER_KEY]);
}

/**
 * Whether a comment marks one of chant's own working objects: a rebuild's
 * new, dual-write or retained table, or the receipts database and table.
 * Schema reads leave them out.
 */
export function isChantWorkingObject(comment: string | undefined): boolean {
  return hasChantTrailerKey(comment, [REBUILD_TRAILER_KEY, RECEIPTS_TRAILER_KEY]);
}

/**
 * A `SHOW CREATE` statement with the trailer taken off its object comment, so
 * the statement reads as the declaration it came from. A comment that was the
 * trailer alone loses its whole `COMMENT` clause.
 */
export function stripMarkerFromStatement(statement: string): string {
  return statement.replace(ONLY_TRAILER_CLAUSE, "").replace(TRAILER_IN_LITERAL, "'");
}
