/** Column clauses: defaults, generated columns and identity. */

import { arg, type Clause } from "./kinds";

export const COLUMN_CLAUSES: Record<string, Clause> = {
  default: { summary: "DEFAULT expression", args: [arg("expression", "expression")] },
  generated: {
    summary: "GENERATED ALWAYS AS (expression) STORED",
    // VIRTUAL generated columns arrive in 18; before that only STORED is accepted.
    args: [arg("expression", "expression"), arg("storage", "keyword", { optional: true, values: ["STORED", "VIRTUAL"] })],
  },
  identity: {
    summary: "GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY [(sequence options)]",
    args: [arg("generation", "keyword", { values: ["ALWAYS", "BY DEFAULT"] }), arg("sequence", "identifier", { optional: true })],
  },
  collate: { summary: "COLLATE collation", args: [arg("collation", "identifier")] },
  compression: { summary: "COMPRESSION method", args: [arg("method", "keyword", { values: ["pglz", "lz4"] })] },
  storage: {
    summary: "STORAGE mode",
    args: [arg("mode", "keyword", { values: ["PLAIN", "EXTERNAL", "EXTENDED", "MAIN", "DEFAULT"] })],
  },
};

/** The options of an identity column's sequence and of `CREATE SEQUENCE`. */
export const SEQUENCE_OPTIONS: Record<string, readonly ReturnType<typeof arg>[]> = {
  asType: [arg("type", "type")],
  incrementBy: [arg("increment", "number")],
  minValue: [arg("minimum", "number")],
  maxValue: [arg("maximum", "number")],
  start: [arg("start", "number")],
  cache: [arg("cache", "number", { range: [1, Number.MAX_SAFE_INTEGER] })],
  cycle: [arg("cycle", "boolean")],
  ownedBy: [arg("column", "identifier")],
};
