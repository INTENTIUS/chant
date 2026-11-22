/**
 * The MySQL change classifier's rules (#5449): every way a declared MySQL
 * object can change, the class of change it is on an InnoDB table, and the
 * restriction behind the class, cited from the MySQL 8.0 reference manual
 * ("Online DDL Operations").
 *
 * The classes are by the `ALGORITHM` InnoDB can use for the change:
 *
 * - `instant`: only the data dictionary changes (`ALGORITHM=INSTANT`); no
 *   row is read or written.
 * - `inplace`: the table is changed or rebuilt in place
 *   (`ALGORITHM=INPLACE`) while reads and writes go on, with a brief
 *   exclusive lock at the start and the end.
 * - `copy`: the table is copied row by row (`ALGORITHM=COPY`), and writes
 *   wait for the whole copy.
 *
 * Creating and dropping whole objects are classed `create` and `drop`. Where
 * the class depends on the minor (adding or dropping a column is INSTANT from
 * a later 8.0 minor), the rule takes the class every supported minor gives.
 */

import { classifierRule, type ChangeClasses, type ClassifierRule } from "../../core/classifier";

export type MysqlChangeClass = "create" | "instant" | "inplace" | "copy" | "drop";

export const MYSQL_CHANGE_CLASSES: ChangeClasses<MysqlChangeClass> = {
  order: ["create", "instant", "inplace", "copy", "drop"],
  label: {
    create: "create",
    instant: "INSTANT, metadata only",
    inplace: "INPLACE, reads and writes go on",
    copy: "COPY, writes wait",
    drop: "drop",
  },
  disruption: { create: "in-place", instant: "in-place", inplace: "rolling", copy: "rolling", drop: "destroy" },
};

const DOCS = "https://dev.mysql.com/doc/refman/8.0/en";
const ONLINE = `${DOCS}/innodb-online-ddl-operations.html`;
const COLUMNS = `${ONLINE}#online-ddl-column-operations`;
const INDEXES = `${ONLINE}#online-ddl-index-operations`;
const KEYS = `${ONLINE}#online-ddl-primary-key-operations`;
const FOREIGN = `${ONLINE}#online-ddl-foreign-key-operations`;
const TABLES = `${ONLINE}#online-ddl-table-operations`;

const rule = (id: string, cls: MysqlChangeClass, title: string, restriction: string, cite: string): ClassifierRule<MysqlChangeClass> => classifierRule(id, cls, title, restriction, cite);

export const MYSQL_CLASSIFIER_RULES = {
  SQLMY200: rule("SQLMY200", "create", "Create an object", "A new database, table or view is created; nothing existing changes.", `${DOCS}/create-table.html`),
  SQLMY201: rule("SQLMY201", "instant", "Add a column", "ADD COLUMN as the last column is INSTANT from 8.0.12; chant adds a new column last.", COLUMNS),
  SQLMY202: rule("SQLMY202", "copy", "Add an AUTO_INCREMENT or STORED generated column", "Adding an AUTO_INCREMENT column or a STORED generated column fills every row, and needs ALGORITHM=COPY.", COLUMNS),
  SQLMY203: rule("SQLMY203", "inplace", "Drop a column", "DROP COLUMN rebuilds the table in place, or is INSTANT from 8.0.29. The data is gone.", COLUMNS),
  SQLMY204: rule("SQLMY204", "copy", "Change a column's type", "Changing a column's data type copies the table, except for widening a VARCHAR within the same length-byte range, which chant does not tell apart.", COLUMNS),
  SQLMY205: rule("SQLMY205", "instant", "Set or drop a column default", "SET DEFAULT and DROP DEFAULT change only the data dictionary.", COLUMNS),
  SQLMY206: rule("SQLMY206", "inplace", "Make a column NULL or NOT NULL", "Changing a column's nullability rebuilds the table in place. Making it NOT NULL fails when a row holds NULL under strict SQL mode.", COLUMNS),
  SQLMY207: rule("SQLMY207", "inplace", "Change a column's other attributes", "A comment, ON UPDATE, AUTO_INCREMENT, visibility or SRID change is a MODIFY COLUMN, which chant classes as an in-place change.", COLUMNS),
  SQLMY208: rule("SQLMY208", "copy", "Change a column's character set or collation", "Converting a column's character set or collation rewrites its data, and copies the table.", COLUMNS),
  SQLMY209: rule("SQLMY209", "inplace", "Add a secondary index", "ADD INDEX builds the index in place while reads and writes go on. The first FULLTEXT index rebuilds the table; a SPATIAL index blocks writes while it is built.", INDEXES),
  SQLMY210: rule("SQLMY210", "inplace", "Drop a secondary index", "DROP INDEX changes only the data dictionary, in place.", INDEXES),
  SQLMY211: rule("SQLMY211", "instant", "Make an index visible or invisible", "ALTER INDEX ... VISIBLE or INVISIBLE changes only the data dictionary.", INDEXES),
  SQLMY212: rule("SQLMY212", "copy", "Change the primary key", "Dropping a primary key without adding another needs ALGORITHM=COPY, and any primary key change rebuilds the table; chant classes it as a copy.", KEYS),
  SQLMY213: rule("SQLMY213", "copy", "Add a foreign key", "ADD FOREIGN KEY is in place only with foreign_key_checks off; with it on, which is the default, the table is copied.", FOREIGN),
  SQLMY214: rule("SQLMY214", "inplace", "Drop a foreign key", "DROP FOREIGN KEY changes only the data dictionary, in place.", FOREIGN),
  SQLMY215: rule("SQLMY215", "copy", "Add or enforce a check", "Adding a CHECK constraint, or enforcing one, checks every row, and copies the table.", `${DOCS}/create-table-check-constraints.html`),
  SQLMY216: rule("SQLMY216", "instant", "Drop a check or stop enforcing it", "DROP CHECK and ALTER CHECK ... NOT ENFORCED change only the data dictionary.", `${DOCS}/create-table-check-constraints.html`),
  SQLMY217: rule("SQLMY217", "instant", "Change a table's comment", "A table comment is metadata only.", TABLES),
  SQLMY218: rule("SQLMY218", "copy", "Change a table's storage engine", "ENGINE = ... copies the table into the new engine.", TABLES),
  SQLMY219: rule("SQLMY219", "instant", "Change a table's default character set or collation", "DEFAULT CHARACTER SET and COLLATE change only the default for columns added later; existing columns keep theirs.", TABLES),
  SQLMY220: rule("SQLMY220", "inplace", "Change a table option", "ROW_FORMAT, KEY_BLOCK_SIZE and the other table options rebuild the table in place.", TABLES),
  SQLMY221: rule("SQLMY221", "instant", "Rename a table", "RENAME TABLE changes only the data dictionary.", `${DOCS}/rename-table.html`),
  SQLMY222: rule("SQLMY222", "instant", "Replace a view", "CREATE OR REPLACE VIEW changes only the view's definition.", `${DOCS}/create-view.html`),
  SQLMY223: rule("SQLMY223", "instant", "Change a database's defaults", "ALTER DATABASE changes the default character set and collation for tables created later; existing tables keep theirs.", `${DOCS}/alter-database.html`),
  SQLMY224: rule("SQLMY224", "drop", "Drop an object", "DROP TABLE removes the table and its rows. Only a table whose comment carries this project's chant marker is dropped, and only with prune.", `${DOCS}/drop-table.html`),
} as const;

export type MysqlClassifierRuleId = keyof typeof MYSQL_CLASSIFIER_RULES;
