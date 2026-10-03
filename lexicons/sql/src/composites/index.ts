/**
 * The sql lexicon's composites: tables and views that are usually declared
 * together, built from each dialect's `table`, `index` and `view` tags so every
 * field keeps its provenance. `./clickhouse` and `./postgres` are what the two
 * dialect subpaths export.
 */

export * from "./clickhouse";
export * from "./postgres";
