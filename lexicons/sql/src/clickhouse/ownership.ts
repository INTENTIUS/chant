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
 */

import { OWNERSHIP_MANAGED_BY_VALUE, type ChannelKeys, type OwnershipChannel, type OwnershipMarker } from "@intentius/chant/ownership";

/** The keys inside the trailer. */
export const CLICKHOUSE_COMMENT_OWNERSHIP_KEYS: ChannelKeys = {
  managedBy: "managed-by",
  stack: "stack",
  env: "env",
};

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

const VALUE = "[A-Za-z0-9._%-]*";
const PAIR = `[A-Za-z0-9._-]+=${VALUE}`;
/** The trailer at the end of a comment's text. */
const TRAILER = new RegExp(`(?:^|\\s+)\\[chant((?: ${PAIR})+)\\]$`);
/** A comment that is the trailer alone, in a printed statement: the whole `COMMENT '...'` clause. */
const ONLY_TRAILER_CLAUSE = new RegExp(`\\s*\\bCOMMENT\\s+'\\[chant(?: ${PAIR})+\\]'`, "g");
/** The trailer inside a printed comment literal, just before its closing quote. */
const TRAILER_IN_LITERAL = new RegExp(`\\s+\\[chant(?: ${PAIR})+\\]'`, "g");

const encode = (v: string) => v.replace(/[^A-Za-z0-9._-]/g, (c) => [...new TextEncoder().encode(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""));
const decode = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/** What a trailer says: the managed-by value and, when stamped, the stack and env. */
export interface CommentMarker {
  managedBy: string;
  stack?: string;
  env?: string;
}

/**
 * The trailer for a marker: `[chant managed-by=chant stack=<stack> env=<env>]`.
 * `extra` appends more pairs after the marker's own; the rebuild migration
 * (`./rebuild/`) uses them to say which rebuild an object it made belongs to.
 * Keys are `[A-Za-z0-9._-]+`; values are encoded like the rest.
 */
export function markerTrailer(marker: OwnershipMarker | undefined, extra: Readonly<Record<string, string>> = {}): string {
  const k = CLICKHOUSE_COMMENT_OWNERSHIP_KEYS;
  const pairs = [`${k.managedBy}=${OWNERSHIP_MANAGED_BY_VALUE}`];
  if (marker?.stack) pairs.push(`${k.stack}=${encode(marker.stack)}`);
  if (marker?.env) pairs.push(`${k.env}=${encode(marker.env)}`);
  for (const [key, value] of Object.entries(extra)) {
    if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error(`ownership trailer key ${JSON.stringify(key)} is not [A-Za-z0-9._-]+`);
    pairs.push(`${key}=${encode(value)}`);
  }
  return `[chant ${pairs.join(" ")}]`;
}

/** A comment's text with the trailer taken off. */
export function stripMarker(comment: string): string {
  return comment.replace(TRAILER, "");
}

/** The comment to set: the declared comment, then the trailer (with `extra` pairs, see {@link markerTrailer}). */
export function stampedComment(declared: string | undefined, marker: OwnershipMarker | undefined, extra?: Readonly<Record<string, string>>): string {
  const own = stripMarker(declared ?? "");
  return own ? `${own} ${markerTrailer(marker, extra)}` : markerTrailer(marker, extra);
}

/** Every pair in a comment's trailer, decoded, or undefined when it has no trailer. */
export function readTrailerPairs(comment: string | undefined): Map<string, string> | undefined {
  const m = TRAILER.exec(comment ?? "");
  if (!m) return undefined;
  return new Map(
    m[1]!
      .trim()
      .split(" ")
      .map((p) => {
        const at = p.indexOf("=");
        return [p.slice(0, at), decode(p.slice(at + 1))] as const;
      }),
  );
}

/**
 * The trailer key naming the table a rebuild migration object belongs to
 * (`./rebuild/`). An object carrying it is the rebuild's own working object,
 * not a declaration: a new table being filled, the dual-write view, an old
 * table being retained. Reading a schema leaves those out
 * (`./live/catalog.ts`), so a plan, an import or a prune never sees them.
 */
export const REBUILD_TRAILER_KEY = "rebuild";

/**
 * The trailer key on the database and table that hold effect receipts
 * (`./rebuild/receipts.ts`). Like a rebuild's working objects, they are
 * chant's own bookkeeping and never part of a declared schema.
 */
export const RECEIPTS_TRAILER_KEY = "receipts";

/** Whether a comment marks a rebuild migration's working object. */
export function isRebuildObject(comment: string | undefined): boolean {
  const pairs = readTrailerPairs(comment);
  return pairs?.get(CLICKHOUSE_COMMENT_OWNERSHIP_KEYS.managedBy) === OWNERSHIP_MANAGED_BY_VALUE && pairs.has(REBUILD_TRAILER_KEY);
}

/**
 * Whether a comment marks one of chant's own working objects: a rebuild's
 * new, dual-write or retained table, or the receipts database and table.
 * Schema reads leave them out.
 */
export function isChantWorkingObject(comment: string | undefined): boolean {
  const pairs = readTrailerPairs(comment);
  return pairs?.get(CLICKHOUSE_COMMENT_OWNERSHIP_KEYS.managedBy) === OWNERSHIP_MANAGED_BY_VALUE && (pairs.has(REBUILD_TRAILER_KEY) || pairs.has(RECEIPTS_TRAILER_KEY));
}

/** The marker a comment carries, or undefined when it carries none. */
export function readMarker(comment: string | undefined): CommentMarker | undefined {
  const pairs = readTrailerPairs(comment);
  if (!pairs) return undefined;
  const k = CLICKHOUSE_COMMENT_OWNERSHIP_KEYS;
  const managedBy = pairs.get(k.managedBy);
  if (managedBy === undefined) return undefined;
  const stack = pairs.get(k.stack);
  const env = pairs.get(k.env);
  return { managedBy, ...(stack ? { stack } : {}), ...(env ? { env } : {}) };
}

/** Whether a comment carries chant's managed-by marker. */
export function isChantManaged(comment: string | undefined): boolean {
  return readMarker(comment)?.managedBy === OWNERSHIP_MANAGED_BY_VALUE;
}

/** Whether the comment's marker is exactly this project's: managed by chant, same stack, same env. */
export function carriesMarker(comment: string | undefined, marker: OwnershipMarker | undefined): boolean {
  const m = readMarker(comment);
  if (m?.managedBy !== OWNERSHIP_MANAGED_BY_VALUE) return false;
  return (m.stack ?? undefined) === (marker?.stack || undefined) && (m.env ?? undefined) === (marker?.env || undefined);
}

/**
 * A `SHOW CREATE` statement with the trailer taken off its object comment, so
 * the statement reads as the declaration it came from. A comment that was the
 * trailer alone loses its whole `COMMENT` clause.
 */
export function stripMarkerFromStatement(statement: string): string {
  return statement.replace(ONLY_TRAILER_CLAUSE, "").replace(TRAILER_IN_LITERAL, "'");
}
