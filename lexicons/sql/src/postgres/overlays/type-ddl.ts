/**
 * `CREATE TYPE` and `CREATE DOMAIN`: the forms for new types. The catalog lists
 * the built-ins; the grammar for declaring more is not in it.
 */

import { arg, type Clause } from "./kinds";

export const TYPE_DDL: Record<string, Clause> = {
  enum: {
    summary: "CREATE TYPE name AS ENUM ('label', ...)",
    args: [arg("labels", "string", { repeated: true })],
  },
  composite: {
    summary: "CREATE TYPE name AS (attribute type [COLLATE c], ...)",
    args: [arg("attributes", "type", { repeated: true })],
  },
  domain: {
    summary: "CREATE DOMAIN name [AS] type [COLLATE c] [DEFAULT expression] [NOT NULL] [CHECK (expression)]",
    args: [
      arg("type", "type"),
      arg("collation", "identifier", { optional: true }),
      arg("default", "expression", { optional: true }),
      arg("notNull", "boolean", { optional: true }),
      arg("check", "expression", { optional: true, repeated: true }),
    ],
  },
  range: {
    summary: "CREATE TYPE name AS RANGE (SUBTYPE = type [, SUBTYPE_OPCLASS, COLLATION, CANONICAL, SUBTYPE_DIFF, MULTIRANGE_TYPE_NAME])",
    args: [
      arg("subtype", "type"),
      arg("subtypeOpclass", "identifier", { optional: true }),
      arg("collation", "identifier", { optional: true }),
      arg("canonical", "identifier", { optional: true }),
      arg("subtypeDiff", "identifier", { optional: true }),
      arg("multirangeTypeName", "identifier", { optional: true }),
    ],
  },
};
