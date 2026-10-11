/**
 * Column type parameters and spellings: the overlay half.
 *
 * `pg_type` lists the types and `format_type()` gives each one's SQL spelling
 * (`int4` is `integer`). The parameters (`varchar(n)`, `numeric(p, s)`,
 * `timestamp(p)`, `interval` fields) and the spellings no catalog row carries
 * (`int`, `decimal`, `serial`) are in no catalog table. A type missing here
 * takes no parameters; generation fails when a key here is not a type at the
 * pins.
 */

import { arg, type ClauseArgument } from "./kinds";

/** Keyed by the canonical SQL name `format_type()` gives. */
export const COLUMN_TYPE_PARAMETERS: Record<string, readonly ClauseArgument[]> = {
  "character varying": [arg("length", "number", { optional: true, range: [1, 10485760] })],
  character: [arg("length", "number", { optional: true, range: [1, 10485760] })],
  bit: [arg("length", "number", { optional: true, range: [1, 83886080] })],
  "bit varying": [arg("length", "number", { optional: true, range: [1, 83886080] })],
  numeric: [arg("precision", "number", { optional: true, range: [1, 1000] }), arg("scale", "number", { optional: true, range: [-1000, 1000] })],
  "timestamp without time zone": [arg("precision", "number", { optional: true, range: [0, 6] })],
  "timestamp with time zone": [arg("precision", "number", { optional: true, range: [0, 6] })],
  "time without time zone": [arg("precision", "number", { optional: true, range: [0, 6] })],
  "time with time zone": [arg("precision", "number", { optional: true, range: [0, 6] })],
  interval: [
    arg("fields", "keyword", {
      optional: true,
      values: ["YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND", "YEAR TO MONTH", "DAY TO HOUR", "DAY TO MINUTE", "DAY TO SECOND", "HOUR TO MINUTE", "HOUR TO SECOND", "MINUTE TO SECOND"],
    }),
    arg("precision", "number", { optional: true, range: [0, 6] }),
  ],
};

/** Spellings that are not `format_type()` output, and the canonical name each stands for. */
export const TYPE_SPELLINGS: Record<string, string> = {
  int: "integer",
  decimal: "numeric",
  float: "double precision",
  varchar: "character varying",
  char: "character",
  varbit: "bit varying",
  timestamp: "timestamp without time zone",
  timestamptz: "timestamp with time zone",
  time: "time without time zone",
  timetz: "time with time zone",
};

/** Pseudo-types that declare a sequence-backed column; each stands for a type plus a default and a sequence. */
export const SERIAL_TYPES: Record<string, string> = {
  smallserial: "smallint",
  serial: "integer",
  bigserial: "bigint",
};

/** An array suffix: `integer[]`, `text[3]`, `ARRAY`. Dimensions are documentation only to the server. */
export const ARRAY_SUFFIX = { brackets: "[]", dimensioned: "[n]", keyword: "ARRAY" } as const;

/**
 * Spellings the grammar accepts that neither `pg_type` nor {@link TYPE_SPELLINGS}
 * lists, and the canonical name each stands for (gram.y, `Numeric`,
 * `Character`, `ConstDatetime`). Lint reads them beside the catalog so every
 * spelling Postgres accepts resolves. `float(p)` is `real` for p up to 24 and
 * `double precision` above; lint reads the precision.
 */
export const GRAMMAR_TYPE_SPELLINGS: Record<string, string> = {
  dec: "numeric",
  "char varying": "character varying",
  "national character": "character",
  "national char": "character",
  nchar: "character",
  "national character varying": "character varying",
  "national char varying": "character varying",
  "nchar varying": "character varying",
};

/** The serial spellings with a width suffix, beside {@link SERIAL_TYPES}. */
export const SERIAL_WIDTH_SPELLINGS: Record<string, string> = {
  serial2: "smallint",
  serial4: "integer",
  serial8: "bigint",
};
