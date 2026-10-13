/**
 * What kind of value an argument or parameter takes. The catalog names an
 * argument (`ver`, `cluster`); it never says whether `ver` is a column and
 * `cluster` a name, which is what these say.
 */
export type ArgumentKind =
  /** One column of the table, by name. */
  | "column"
  /** A column, or a tuple of columns. */
  | "columns"
  /** Any expression over the table's columns. */
  | "expression"
  /** A database, table, cluster or dictionary name. */
  | "identifier"
  /** A string literal. */
  | "string"
  /** A numeric literal. */
  | "number"
  /** A bare keyword from a fixed set (`values`). */
  | "keyword"
  /** A column type (`Nullable(T)`'s `T`). */
  | "type"
  /** An aggregate function name with its parameters (`AggregateFunction(uniq, UUID)`'s `uniq`). */
  | "function"
  /** A codec, as written inside `CODEC(...)`. */
  | "codec";

export interface ArgumentOverlay {
  kind: ArgumentKind;
  /** Overrides the syntax line's optionality, with `note` saying why. */
  optional?: boolean;
  /** The legal values of a `keyword`, or of a `number` limited to a set (a codec's byte width: 1, 2, 4 or 8). */
  values?: readonly string[];
  /** The inclusive range of a `number`. */
  range?: readonly [number, number];
  /** Where the overlay knows something the syntax line does not. */
  note?: string;
}
