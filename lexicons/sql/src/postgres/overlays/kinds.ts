/**
 * What kind of value a clause argument takes. The catalog lists names (types,
 * access methods, operator classes); it never says that `varchar`'s one
 * argument is a length or that `ON DELETE` takes one of five actions. The
 * overlays say that, with these.
 */
export type ArgumentKind =
  /** A column of the table, by name. */
  | "column"
  /** Any expression; in an index key or a check, over the table's columns. */
  | "expression"
  /** A schema-qualified or bare object name. */
  | "identifier"
  /** A string literal. */
  | "string"
  /** A numeric literal. */
  | "number"
  /** A boolean. */
  | "boolean"
  /** A bare keyword from a fixed set (`values`). */
  | "keyword"
  /** A column type. */
  | "type"
  /** A query. */
  | "query";

export interface ClauseArgument {
  name: string;
  kind: ArgumentKind;
  optional?: boolean;
  /** The argument repeats, comma separated. */
  repeated?: boolean;
  /** The legal values of a `keyword`. */
  values?: readonly string[];
  /** The inclusive range of a `number`. */
  range?: readonly [number, number];
}

/** A clause that is in some majors and not others. A bound outside 14..18 is a mistake generation reports. */
export interface Versioned {
  since?: number;
  until?: number;
}

export type Clause = { args: readonly ClauseArgument[]; summary: string } & Versioned;

export const arg = (
  name: string,
  kind: ArgumentKind,
  extra: Partial<Omit<ClauseArgument, "name" | "kind">> = {},
): ClauseArgument => ({ name, kind, ...extra });

export const INT_MAX = 2147483647;
