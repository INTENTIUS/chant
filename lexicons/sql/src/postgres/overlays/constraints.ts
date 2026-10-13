/**
 * Constraint grammar: the arguments of each table and column constraint.
 * `MATCH`, `ON DELETE` and `DEFERRABLE` are grammar, not catalog.
 */

import { arg, type Clause } from "./kinds";

export const REFERENTIAL_ACTIONS = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"] as const;

const deferral = [
  arg("deferrable", "boolean", { optional: true }),
  arg("initially", "keyword", { optional: true, values: ["DEFERRED", "IMMEDIATE"] }),
];

export const CONSTRAINTS: Record<string, Clause> = {
  primaryKey: {
    summary: "PRIMARY KEY (columns) [INCLUDE (columns)] [USING INDEX TABLESPACE name]",
    args: [arg("columns", "column", { repeated: true }), arg("include", "column", { optional: true, repeated: true }), ...deferral],
  },
  unique: {
    summary: "UNIQUE [NULLS [NOT] DISTINCT] (columns) [INCLUDE (columns)]",
    args: [
      arg("columns", "column", { repeated: true }),
      arg("nullsNotDistinct", "boolean", { optional: true }),
      arg("include", "column", { optional: true, repeated: true }),
      ...deferral,
    ],
    since: 15,
  },
  check: {
    summary: "CHECK (expression) [NO INHERIT]",
    args: [arg("expression", "expression"), arg("noInherit", "boolean", { optional: true })],
  },
  foreignKey: {
    summary: "FOREIGN KEY (columns) REFERENCES table (columns) [MATCH FULL | SIMPLE] [ON DELETE action] [ON UPDATE action]",
    args: [
      arg("columns", "column", { repeated: true }),
      arg("references", "identifier"),
      arg("referencedColumns", "column", { optional: true, repeated: true }),
      arg("match", "keyword", { optional: true, values: ["FULL", "SIMPLE"] }),
      arg("onDelete", "keyword", { optional: true, values: REFERENTIAL_ACTIONS }),
      arg("onUpdate", "keyword", { optional: true, values: REFERENTIAL_ACTIONS }),
      ...deferral,
    ],
  },
  exclude: {
    summary: "EXCLUDE [USING method] (element WITH operator, ...) [WHERE (predicate)]",
    args: [
      arg("using", "keyword", { optional: true, values: ["gist", "spgist", "btree", "hash"] }),
      arg("elements", "expression", { repeated: true }),
      arg("where", "expression", { optional: true }),
      ...deferral,
    ],
  },
  notNull: { summary: "NOT NULL [NO INHERIT]", args: [arg("noInherit", "boolean", { optional: true })], since: 18 },
};
