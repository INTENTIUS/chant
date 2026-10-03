/**
 * Index clauses. Which access method supports which of them is in the catalog
 * (`INDEX_METHOD_PROPERTIES`: `can_include`, `can_unique`, ...); the clause
 * shapes are here.
 */

import { arg, type Clause } from "./kinds";

export const INDEX_CLAUSES: Record<string, Clause> = {
  key: {
    summary: "{ column | (expression) } [COLLATE collation] [opclass [(parameters)]] [ASC | DESC] [NULLS FIRST | LAST]",
    args: [
      arg("key", "expression"),
      arg("collation", "identifier", { optional: true }),
      arg("opclass", "identifier", { optional: true }),
      arg("order", "keyword", { optional: true, values: ["ASC", "DESC"] }),
      arg("nulls", "keyword", { optional: true, values: ["FIRST", "LAST"] }),
    ],
  },
  using: { summary: "USING method", args: [arg("method", "keyword")] },
  include: { summary: "INCLUDE (columns)", args: [arg("columns", "column", { repeated: true })] },
  where: { summary: "WHERE predicate: a partial index", args: [arg("predicate", "expression")] },
  nullsNotDistinct: { summary: "NULLS [NOT] DISTINCT, on a unique index", args: [arg("notDistinct", "boolean")], since: 15 },
  tablespace: { summary: "TABLESPACE name", args: [arg("tablespace", "identifier")] },
  concurrently: { summary: "CREATE INDEX CONCURRENTLY: not inside a transaction block", args: [arg("concurrently", "boolean")] },
  only: { summary: "ON ONLY parent: an index on a partitioned table's parent without its partitions", args: [arg("only", "boolean")] },
};
