/** Table and relation clauses, views, materialized views and sequences. */

import { arg, type Clause } from "./kinds";

export const RELATION_CLAUSES: Record<string, Clause> = {
  persistence: { summary: "{ TEMPORARY | UNLOGGED } TABLE", args: [arg("persistence", "keyword", { values: ["TEMPORARY", "UNLOGGED"] })] },
  inherits: { summary: "INHERITS (parents)", args: [arg("parents", "identifier", { repeated: true })] },
  tablespace: { summary: "TABLESPACE name", args: [arg("tablespace", "identifier")] },
  using: { summary: "USING access_method", args: [arg("method", "keyword")] },
  onCommit: { summary: "ON COMMIT { PRESERVE ROWS | DELETE ROWS | DROP }, temporary tables only", args: [arg("action", "keyword", { values: ["PRESERVE ROWS", "DELETE ROWS", "DROP"] })] },
  withParameters: { summary: "WITH (storage_parameter = value, ...)", args: [arg("parameters", "expression", { repeated: true })] },
  likeSource: { summary: "LIKE source [INCLUDING | EXCLUDING option]", args: [arg("source", "identifier"), arg("options", "keyword", { optional: true, repeated: true, values: ["COMMENTS", "COMPRESSION", "CONSTRAINTS", "DEFAULTS", "GENERATED", "IDENTITY", "INDEXES", "STATISTICS", "STORAGE", "ALL"] })] },
  ofType: { summary: "OF composite_type: a typed table", args: [arg("type", "identifier")] },
};

export const VIEW_CLAUSES: Record<string, Clause> = {
  query: { summary: "AS query", args: [arg("query", "query")] },
  columns: { summary: "(column_names)", args: [arg("columns", "column", { repeated: true })] },
  recursive: { summary: "CREATE RECURSIVE VIEW", args: [arg("recursive", "boolean")] },
  checkOption: { summary: "WITH [CASCADED | LOCAL] CHECK OPTION, on an updatable view", args: [arg("option", "keyword", { values: ["CASCADED", "LOCAL"] })] },
  securityInvoker: { summary: "WITH (security_invoker = true): check permissions as the caller", args: [arg("securityInvoker", "boolean")], since: 15 },
  securityBarrier: { summary: "WITH (security_barrier = true)", args: [arg("securityBarrier", "boolean")] },
  withNoData: { summary: "WITH NO DATA: a materialized view created unpopulated", args: [arg("noData", "boolean")] },
};

export const SEQUENCE_CLAUSES: Record<string, Clause> = {
  persistence: { summary: "[ { TEMPORARY | UNLOGGED } ] SEQUENCE", args: [arg("persistence", "keyword", { values: ["TEMPORARY", "UNLOGGED"] })] },
  options: { summary: "AS type, INCREMENT, MINVALUE, MAXVALUE, START, CACHE, [NO] CYCLE, OWNED BY (see SEQUENCE_OPTIONS)", args: [] },
};
