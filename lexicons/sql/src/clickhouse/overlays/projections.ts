/**
 * Projections: the overlay half.
 *
 * `system.table_engines.supports_projections` says which engines accept a
 * projection, and is generated. The projection's own grammar is fixed and in
 * no table: a name and a parenthesised query over the table, either a
 * reordering (`SELECT * ORDER BY x`) or an aggregation (`SELECT k, sum(v)
 * GROUP BY k`). `system.projections` is runtime state, not grammar.
 *
 *     PROJECTION name (SELECT <columns or *> [GROUP BY ...] [ORDER BY ...])
 */

export interface ProjectionForm {
  form: "normal" | "aggregate";
  /** The clause that makes a projection this form. */
  marker: "ORDER BY" | "GROUP BY";
  summary: string;
}

export const PROJECTION_FORMS: readonly ProjectionForm[] = [
  { form: "normal", marker: "ORDER BY", summary: "A copy of the selected columns in another sort order." },
  { form: "aggregate", marker: "GROUP BY", summary: "Pre-aggregated rows, kept current by merges like an AggregatingMergeTree." },
];

/**
 * MergeTree settings that decide what a mutation or deduplicating merge does to
 * a table with projections. Changing either is metadata only; leaving them at
 * their defaults makes `ALTER ... UPDATE` on such a table an error.
 */
export const PROJECTION_SETTINGS: readonly string[] = [
  "deduplicate_merge_projection_mode",
  "lightweight_mutation_projection_mode",
];

/** Clauses a projection's query may not carry. */
export const PROJECTION_FORBIDDEN_CLAUSES: readonly string[] = ["WHERE", "JOIN", "LIMIT", "HAVING", "ARRAY JOIN"];
