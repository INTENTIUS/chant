/**
 * chant's ownership marker as a trailer on an object's own comment, in every
 * dialect that can comment on its objects (#3208).
 *
 * The marker never replaces the user's comment, which is a declared property.
 * It is appended as a bracketed trailer,
 *
 *     Raw events [chant managed-by=chant stack=shop env=prod]
 *
 * and taken off again wherever chant reads a definition, so planning, the deep
 * diff and import compare and write the declared comment alone. Someone who
 * edits the comment by hand and drops the trailer makes the object read as
 * foreign, which is the safe direction: it is never pruned, and the next apply
 * of its declaration stamps it again.
 *
 * Values are percent-encoded outside `[A-Za-z0-9._-]`, so the trailer never
 * holds a quote, a backslash, a space or a bracket of its own.
 *
 * Where the comment lives in a statement, and so how a trailer comes off a
 * printed `CREATE`, is the dialect's grammar and stays with the dialect.
 */

import { OWNERSHIP_MANAGED_BY_VALUE, type ChannelKeys, type OwnershipMarker } from "@intentius/chant/ownership";

/** The keys inside the trailer. */
export const COMMENT_OWNERSHIP_KEYS: ChannelKeys = {
  managedBy: "managed-by",
  stack: "stack",
  env: "env",
};

/**
 * The trailer key on the objects that hold effect receipts. Like a
 * migration's working objects, they are chant's own bookkeeping and never
 * part of a declared schema.
 */
export const RECEIPTS_TRAILER_KEY = "receipts";

const VALUE = "[A-Za-z0-9._%-]*";
/** One `key=value` pair of a trailer, as a regular expression source. */
export const TRAILER_PAIR = `[A-Za-z0-9._-]+=${VALUE}`;
/** The trailer at the end of a comment's text. */
const TRAILER = new RegExp(`(?:^|\\s+)\\[chant((?: ${TRAILER_PAIR})+)\\]$`);

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
 * `extra` appends more pairs after the marker's own; a migration Op uses them
 * to say which migration an object it made belongs to.
 * Keys are `[A-Za-z0-9._-]+`; values are encoded like the rest.
 */
export function markerTrailer(marker: OwnershipMarker | undefined, extra: Readonly<Record<string, string>> = {}): string {
  const k = COMMENT_OWNERSHIP_KEYS;
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

/** Whether a comment carries chant's managed-by marker and any of `keys` in its trailer. */
export function hasChantTrailerKey(comment: string | undefined, keys: readonly string[]): boolean {
  const pairs = readTrailerPairs(comment);
  return pairs?.get(COMMENT_OWNERSHIP_KEYS.managedBy) === OWNERSHIP_MANAGED_BY_VALUE && keys.some((k) => pairs!.has(k));
}

/** The marker a comment carries, or undefined when it carries none. */
export function readMarker(comment: string | undefined): CommentMarker | undefined {
  const pairs = readTrailerPairs(comment);
  if (!pairs) return undefined;
  const k = COMMENT_OWNERSHIP_KEYS;
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
