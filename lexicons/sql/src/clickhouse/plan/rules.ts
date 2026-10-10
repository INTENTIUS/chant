/**
 * The change classifier's rules (#3046 question 3): every way a declared
 * ClickHouse object can change, the class of change it is on the server, and
 * the `ALTER` restriction behind the class, cited.
 *
 * Three classes:
 *
 * - `metadata`: the server records the change and touches no existing data
 *   (a new column reads its default from old parts; a new index covers new
 *   parts until `MATERIALIZE INDEX`).
 * - `rewrite`: the change is a mutation that rewrites existing parts in the
 *   background (`system.mutations`), with no rollback.
 * - `rebuild`: ClickHouse cannot make the change to the table it has; the data
 *   has to be copied into a new table. A plan refuses to make one in place.
 *
 * Creating and dropping whole objects are classed `create` and `drop`.
 */

import { classifierRule, type ChangeClasses, type ClassifierRule as SqlClassifierRule } from "../../core/classifier";

export type ChangeClass = "metadata" | "rewrite" | "rebuild" | "create" | "drop";

/** A ClickHouse rule: the shared core's rule shape over these classes, citing a clickhouse.com page. */
export type ClassifierRule = SqlClassifierRule<ChangeClass>;

/** The classes as data: report order and labels, and what each costs for `classifyDisruption()`. */
export const CHANGE_CLASSES: ChangeClasses<ChangeClass> = {
  order: ["create", "metadata", "rewrite", "rebuild", "drop"],
  label: { create: "create", drop: "drop", metadata: "metadata only", rewrite: "background rewrite", rebuild: "REBUILD" },
  disruption: { metadata: "in-place", rewrite: "rolling", rebuild: "replace", create: "in-place", drop: "destroy" },
};

const DOCS = "https://clickhouse.com/docs/sql-reference/statements";

const rule = (id: string, cls: ChangeClass, title: string, restriction: string, cite: string): ClassifierRule => classifierRule(id, cls, title, restriction, cite);

export const CLASSIFIER_RULES = {
  SQLCH200: rule("SQLCH200", "create", "Create an object", "A new database, table, view, dictionary or function is created; nothing existing changes.", `${DOCS}/create`),
  SQLCH201: rule(
    "SQLCH201",
    "metadata",
    "Add a column",
    "ADD COLUMN only changes metadata: parts written before it read the column's default until they are merged or the column is materialized.",
    `${DOCS}/alter/column#add-column`,
  ),
  SQLCH202: rule(
    "SQLCH202",
    "metadata",
    "Drop a column",
    "DROP COLUMN removes the column's data from every part; it is not undone. A column in a key cannot be dropped (SQLCH213 covers that case).",
    `${DOCS}/alter/column#drop-column`,
  ),
  SQLCH203: rule("SQLCH203", "metadata", "Change a comment", "COMMENT COLUMN and MODIFY COMMENT change metadata only.", `${DOCS}/alter/comment`),
  SQLCH204: rule(
    "SQLCH204",
    "metadata",
    "Add, drop or change a skip index",
    "ADD INDEX and DROP INDEX change metadata; a new index covers parts written after it until MATERIALIZE INDEX rebuilds it for older parts.",
    `${DOCS}/alter/skipping-index`,
  ),
  SQLCH205: rule(
    "SQLCH205",
    "rewrite",
    "Change a TTL",
    "MODIFY TTL is recorded in metadata, and with materialize_ttl_after_modify (on by default) the server recalculates the TTL over existing data as a mutation.",
    `${DOCS}/alter/ttl`,
  ),
  SQLCH206: rule(
    "SQLCH206",
    "metadata",
    "Change a table setting",
    "MODIFY SETTING and RESET SETTING change metadata, for settings the server lets change after creation.",
    `${DOCS}/alter/setting`,
  ),
  SQLCH207: rule(
    "SQLCH207",
    "metadata",
    "Change a column's default",
    "MODIFY COLUMN with a new DEFAULT, MATERIALIZED or ALIAS expression changes metadata; values already written keep the old default until the column is materialized.",
    `${DOCS}/alter/column#modify-column`,
  ),
  SQLCH208: rule(
    "SQLCH208",
    "metadata",
    "Change a column's codec",
    "MODIFY COLUMN ... CODEC applies to parts written afterwards; existing parts keep their codec until they are merged or rewritten.",
    `${DOCS}/alter/column#modify-column`,
  ),
  SQLCH209: rule(
    "SQLCH209",
    "metadata",
    "Move a column",
    "MODIFY COLUMN ... FIRST | AFTER changes the column order in metadata only.",
    `${DOCS}/alter/column#modify-column`,
  ),
  SQLCH210: rule(
    "SQLCH210",
    "rewrite",
    "Change a column's type",
    "Changing the type of a column outside the primary key is a mutation that rewrites the column in every part in the background, with no rollback.",
    `${DOCS}/alter/column#modify-column`,
  ),
  SQLCH211: rule(
    "SQLCH211",
    "rebuild",
    "Change the type of a key column",
    "The type of a primary key column can change only when the change does not modify the data (for example adding values to an Enum); anything else needs a new table.",
    `${DOCS}/alter/column#modify-column`,
  ),
  SQLCH212: rule(
    "SQLCH212",
    "metadata",
    "Rename a column",
    "RENAME COLUMN changes metadata, for a column that is not in a key.",
    `${DOCS}/alter/column#rename-column`,
  ),
  SQLCH213: rule(
    "SQLCH213",
    "rebuild",
    "Rename or drop a key column",
    "A column in the sorting key, the primary key or the partition key cannot be renamed or dropped.",
    `${DOCS}/alter/column#rename-column`,
  ),
  SQLCH214: rule(
    "SQLCH214",
    "metadata",
    "Add, drop or change a projection",
    "ADD PROJECTION and DROP PROJECTION change metadata; a new projection covers new parts until MATERIALIZE PROJECTION builds it for older ones.",
    `${DOCS}/alter/projection`,
  ),
  SQLCH215: rule("SQLCH215", "metadata", "Add or drop a constraint", "ADD CONSTRAINT and DROP CONSTRAINT change metadata; existing rows are not checked.", `${DOCS}/alter/constraint`),
  SQLCH216: rule(
    "SQLCH216",
    "metadata",
    "Append new columns to the sorting key",
    "MODIFY ORDER BY can only append columns added by ADD COLUMN in the same ALTER, and leaves the primary key as it was; the declaration must keep the old key as PRIMARY KEY.",
    `${DOCS}/alter/order-by`,
  ),
  SQLCH217: rule(
    "SQLCH217",
    "metadata",
    "Change the sampling key",
    "MODIFY SAMPLE BY changes metadata; the new sampling expression must be part of the primary key, and the server refuses it otherwise.",
    `${DOCS}/alter/sample-by`,
  ),
  SQLCH218: rule(
    "SQLCH218",
    "rebuild",
    "Change a setting fixed at creation",
    "A table setting the server marks read-only (such as index_granularity) is fixed when the table is created and needs a new table to change.",
    `${DOCS}/alter/setting`,
  ),
  SQLCH220: rule(
    "SQLCH220",
    "rebuild",
    "Change the sorting key",
    "The sorting key is the on-disk order of every part (and in ReplacingMergeTree the deduplication identity); beyond appending new columns (SQLCH216) it cannot change in place.",
    `${DOCS}/alter/order-by`,
  ),
  SQLCH221: rule(
    "SQLCH221",
    "rebuild",
    "Change the primary key",
    "The primary key cannot be changed by ALTER; MODIFY ORDER BY leaves it as it was.",
    `${DOCS}/alter/order-by`,
  ),
  SQLCH222: rule(
    "SQLCH222",
    "rebuild",
    "Change the partition key",
    "There is no ALTER for the partition key; parts are laid out by it when they are written.",
    `${DOCS}/alter`,
  ),
  SQLCH223: rule(
    "SQLCH223",
    "rebuild",
    "Change the table engine or its arguments",
    "There is no ALTER for a table's engine or its arguments (a ReplacingMergeTree version column, a Distributed sharding key); a different engine is a different table.",
    `${DOCS}/alter`,
  ),
  SQLCH224: rule(
    "SQLCH224",
    "rebuild",
    "Change what kind of object it is",
    "A table cannot become a view or a view a table; the old object is dropped and the new one created.",
    `${DOCS}/create`,
  ),
  SQLCH230: rule(
    "SQLCH230",
    "metadata",
    "Rename or move a table or view",
    "RENAME TABLE changes the name, or moves the object to another database, in metadata on an Atomic database.",
    `${DOCS}/rename`,
  ),
  SQLCH231: rule("SQLCH231", "metadata", "Rename a database", "RENAME DATABASE is metadata only, for an Atomic database.", `${DOCS}/rename`),
  SQLCH232: rule(
    "SQLCH232",
    "rebuild",
    "Change a database's engine",
    "A database's engine is fixed at creation; there is no ALTER for it.",
    `${DOCS}/create/database`,
  ),
  SQLCH240: rule(
    "SQLCH240",
    "metadata",
    "Change a view's query",
    "A plain view stores no data; CREATE OR REPLACE VIEW replaces its query.",
    `${DOCS}/create/view`,
  ),
  SQLCH241: rule(
    "SQLCH241",
    "metadata",
    "Change a materialized view's query",
    "ALTER TABLE ... MODIFY QUERY replaces the query without stopping inserts; rows already written are not recomputed.",
    `${DOCS}/alter/view`,
  ),
  SQLCH242: rule(
    "SQLCH242",
    "rebuild",
    "Change a materialized view's target",
    "A materialized view's TO target is fixed at creation; the view is dropped and created again, and inserts into its source in between are not seen.",
    `${DOCS}/create/view`,
  ),
  SQLCH243: rule(
    "SQLCH243",
    "rebuild",
    "Change a materialized view's own storage",
    "A materialized view without TO keeps its rows in an inner table whose engine and keys are fixed like any table's.",
    `${DOCS}/create/view`,
  ),
  SQLCH244: rule(
    "SQLCH244",
    "metadata",
    "Change a refreshable view's schedule",
    "ALTER TABLE ... MODIFY REFRESH changes the schedule of a refreshable materialized view.",
    `${DOCS}/alter/view`,
  ),
  SQLCH245: rule(
    "SQLCH245",
    "metadata",
    "Change a dictionary",
    "A dictionary stores no data of its own: CREATE OR REPLACE DICTIONARY replaces its attributes, key, source, layout, lifetime or range, and it loads again from its source.",
    `${DOCS}/create/dictionary`,
  ),
  SQLCH260: rule(
    "SQLCH260",
    "metadata",
    "Change a function",
    "A SQL user-defined function stores no data: CREATE OR REPLACE FUNCTION replaces its parameters and expression, and queries that call it use the new one.",
    `${DOCS}/create/function`,
  ),
  SQLCH250: rule("SQLCH250", "drop", "Drop an object", "DROP removes the object and, for a table, its data; it is not undone.", `${DOCS}/drop`),
} as const satisfies Record<string, ClassifierRule>;

export type ClassifierRuleId = keyof typeof CLASSIFIER_RULES;
