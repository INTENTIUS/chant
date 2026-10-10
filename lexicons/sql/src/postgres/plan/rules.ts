/**
 * The Postgres change classifier's rules (#3279, #3275 question 3): every way
 * a declared Postgres object can change, the class of change it is on the
 * server, and the restriction behind the class, cited from the Postgres 18
 * documentation (the pinned major), with the differences across the
 * supported majors 14 to 18 stated where there are any.
 *
 * The classes are by the lock a change takes and whether it reads or
 * rewrites the table ("Explicit Locking", `ALTER TABLE`'s Notes):
 *
 * - `metadata`: a catalog change under a brief lock; no row is read or
 *   written. Most `ALTER TABLE` forms take `ACCESS EXCLUSIVE` even so, which
 *   queues behind every running query, so the applier (#3280) sets a
 *   `lock_timeout`.
 * - `validate`: every row is read to check a constraint, under a lock weaker
 *   than `ACCESS EXCLUSIVE` (`SHARE UPDATE EXCLUSIVE` for `VALIDATE
 *   CONSTRAINT`, so reads and writes go on).
 * - `concurrently`: an index build, which blocks writes for its whole run
 *   unless it is `CONCURRENTLY`, and `CONCURRENTLY` cannot run inside a
 *   transaction block.
 * - `rewrite`: the table is rewritten, or read in full, under `ACCESS
 *   EXCLUSIVE`, blocking reads and writes for the duration.
 * - `expand`: no in-place change keeps old readers working (a rename, a type
 *   change with no cast in place, a change of partitioning): it is made as
 *   expand and contract, by the migration Op (#3281). A plan refuses it.
 *
 * Creating and dropping whole objects are classed `create` and `drop`.
 */

import { classifierRule, type ChangeClasses, type ClassifierRule as SqlClassifierRule } from "../../core/classifier";

export type PgChangeClass = "metadata" | "validate" | "concurrently" | "rewrite" | "expand" | "create" | "drop";

export type PgClassifierRule = SqlClassifierRule<PgChangeClass>;

export const PG_CHANGE_CLASSES: ChangeClasses<PgChangeClass> = {
  order: ["create", "metadata", "validate", "concurrently", "rewrite", "expand", "drop"],
  label: {
    create: "create",
    metadata: "metadata only",
    validate: "validates under a weaker lock",
    concurrently: "needs CONCURRENTLY",
    rewrite: "ACCESS EXCLUSIVE rewrite or scan",
    expand: "EXPAND AND CONTRACT",
    drop: "drop",
  },
  disruption: { create: "in-place", metadata: "in-place", validate: "rolling", concurrently: "rolling", rewrite: "rolling", expand: "replace", drop: "destroy" },
};

const DOCS = "https://www.postgresql.org/docs/18";
const ALTER_TABLE = `${DOCS}/sql-altertable.html`;
const LOCKING = `${DOCS}/explicit-locking.html`;
const CREATE_INDEX = `${DOCS}/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY`;

const rule = (id: string, cls: PgChangeClass, title: string, restriction: string, cite: string): PgClassifierRule => classifierRule(id, cls, title, restriction, cite);

export const PG_CLASSIFIER_RULES = {
  SQLPG200: rule("SQLPG200", "create", "Create an object", "A new object is created; nothing existing changes. A table created in the same plan as its indexes needs no CONCURRENTLY.", `${DOCS}/sql-createtable.html`),
  SQLPG201: rule(
    "SQLPG201",
    "metadata",
    "Add a column",
    "ADD COLUMN with no default, or with a non-volatile default, changes only the catalog under ACCESS EXCLUSIVE: the default is stored once and read for existing rows (since 11, so in every supported major). A NOT NULL column needs that default.",
    ALTER_TABLE,
  ),
  SQLPG202: rule(
    "SQLPG202",
    "rewrite",
    "Add a column whose value has to be computed for every row",
    "ADD COLUMN with a volatile default (clock_timestamp(), random(), gen_random_uuid(), nextval()), a STORED generated column or an identity column rewrites the whole table under ACCESS EXCLUSIVE. A VIRTUAL generated column (18) does not.",
    ALTER_TABLE,
  ),
  SQLPG203: rule(
    "SQLPG203",
    "expand",
    "Add a NOT NULL column with no default",
    "ADD COLUMN ... NOT NULL with no default fails on a table that has rows. Add it nullable, backfill it, then set NOT NULL.",
    ALTER_TABLE,
  ),
  SQLPG204: rule("SQLPG204", "metadata", "Drop a column", "DROP COLUMN only hides the column in the catalog under ACCESS EXCLUSIVE; its space is reclaimed as rows are rewritten. The data is gone.", ALTER_TABLE),
  SQLPG205: rule(
    "SQLPG205",
    "expand",
    "Rename a column",
    "RENAME COLUMN is a catalog change, but every reader still using the old name fails the moment it runs: add the new column, write both, move readers, drop the old.",
    ALTER_TABLE,
  ),
  SQLPG206: rule(
    "SQLPG206",
    "metadata",
    "Change a column's type without a rewrite",
    "ALTER COLUMN TYPE to a binary-coercible type (varchar(n) to a longer varchar or to text, numeric(p,s) to a wider precision or to unconstrained numeric, cidr to inet) needs no rewrite; indexes on the column may still be rebuilt. ACCESS EXCLUSIVE, briefly.",
    ALTER_TABLE,
  ),
  SQLPG207: rule(
    "SQLPG207",
    "rewrite",
    "Change a column's type with a rewrite",
    "ALTER COLUMN TYPE that is not binary-coercible (integer to bigint, a shorter varchar, real to double precision) rewrites the table and rebuilds its indexes under ACCESS EXCLUSIVE.",
    ALTER_TABLE,
  ),
  SQLPG208: rule(
    "SQLPG208",
    "expand",
    "Change a column's type across kinds",
    "A type change between kinds (text to integer, a type to an enum) needs a USING expression and breaks readers that expect the old type: add the new column, backfill, move readers, drop the old.",
    ALTER_TABLE,
  ),
  SQLPG209: rule("SQLPG209", "metadata", "Change a column's default", "SET DEFAULT and DROP DEFAULT change only the catalog; existing rows keep their values.", ALTER_TABLE),
  SQLPG210: rule(
    "SQLPG210",
    "rewrite",
    "Set NOT NULL",
    "SET NOT NULL reads the whole table under ACCESS EXCLUSIVE, unless a valid CHECK (column IS NOT NULL) constraint already proves it (since 12). Declare that check NOT VALID, validate it, then set NOT NULL; 18 can also add NOT NULL ... NOT VALID.",
    ALTER_TABLE,
  ),
  SQLPG211: rule("SQLPG211", "metadata", "Drop NOT NULL", "DROP NOT NULL changes only the catalog.", ALTER_TABLE),
  SQLPG212: rule(
    "SQLPG212",
    "rewrite",
    "Change a generated column's expression",
    "ALTER COLUMN SET EXPRESSION (17 and later) rewrites a STORED generated column under ACCESS EXCLUSIVE; on 14 to 16 the column has to be dropped and added. A VIRTUAL column (18) changes only the catalog.",
    ALTER_TABLE,
  ),
  SQLPG213: rule("SQLPG213", "metadata", "Change a column's identity", "ADD, SET and DROP IDENTITY change the column's sequence and the catalog, not the rows.", ALTER_TABLE),
  SQLPG214: rule("SQLPG214", "rewrite", "Change a column's collation", "A collation change is ALTER COLUMN TYPE with COLLATE: the column's indexes are rebuilt under ACCESS EXCLUSIVE.", ALTER_TABLE),
  SQLPG215: rule("SQLPG215", "metadata", "Change a column's storage or compression", "SET STORAGE and SET COMPRESSION apply to values written afterwards; existing values are not rewritten.", ALTER_TABLE),
  SQLPG216: rule("SQLPG216", "metadata", "Change a comment", "COMMENT ON changes only the catalog.", `${DOCS}/sql-comment.html`),
  SQLPG217: rule(
    "SQLPG217",
    "metadata",
    "Add a constraint NOT VALID",
    "ADD CONSTRAINT ... NOT VALID checks new rows only and reads none of the existing ones; a foreign key takes SHARE ROW EXCLUSIVE on both tables, briefly. Validate it as a separate step.",
    ALTER_TABLE,
  ),
  SQLPG218: rule(
    "SQLPG218",
    "rewrite",
    "Add a CHECK constraint",
    "ADD CONSTRAINT ... CHECK reads every row under ACCESS EXCLUSIVE. Declare it NOT VALID, then remove NOT VALID to validate it under SHARE UPDATE EXCLUSIVE (SQLPG220).",
    ALTER_TABLE,
  ),
  SQLPG219: rule(
    "SQLPG219",
    "validate",
    "Add a foreign key",
    "ADD FOREIGN KEY reads every row under SHARE ROW EXCLUSIVE on both tables, which blocks writes to them for the scan. Declare it NOT VALID, then remove NOT VALID to validate it under SHARE UPDATE EXCLUSIVE (SQLPG220).",
    ALTER_TABLE,
  ),
  SQLPG220: rule(
    "SQLPG220",
    "validate",
    "Validate a constraint",
    "VALIDATE CONSTRAINT reads every row under SHARE UPDATE EXCLUSIVE, so reads and writes go on (ROW SHARE on a foreign key's referenced table).",
    LOCKING,
  ),
  SQLPG221: rule(
    "SQLPG221",
    "concurrently",
    "Add a primary key or unique constraint",
    "ADD PRIMARY KEY or UNIQUE builds its index under ACCESS EXCLUSIVE. Build the unique index CONCURRENTLY first, then ADD CONSTRAINT ... USING INDEX, which changes only the catalog.",
    ALTER_TABLE,
  ),
  SQLPG222: rule("SQLPG222", "rewrite", "Add an exclusion constraint", "ADD CONSTRAINT ... EXCLUDE builds its index under ACCESS EXCLUSIVE; there is no concurrent form.", ALTER_TABLE),
  SQLPG223: rule("SQLPG223", "metadata", "Drop a constraint", "DROP CONSTRAINT changes the catalog under ACCESS EXCLUSIVE, briefly; a primary key's or unique constraint's index goes with it.", ALTER_TABLE),
  SQLPG224: rule(
    "SQLPG224",
    "metadata",
    "Change storage parameters",
    "SET and RESET of storage parameters change the catalog; fillfactor and the autovacuum parameters take only SHARE UPDATE EXCLUSIVE. Rows are not rewritten; a new fillfactor applies to pages written afterwards.",
    ALTER_TABLE,
  ),
  SQLPG225: rule("SQLPG225", "rewrite", "Make a table LOGGED or UNLOGGED", "SET LOGGED and SET UNLOGGED rewrite the table under ACCESS EXCLUSIVE.", ALTER_TABLE),
  SQLPG226: rule("SQLPG226", "rewrite", "Change a table's access method or tablespace", "SET ACCESS METHOD (15 and later) and SET TABLESPACE rewrite the table under ACCESS EXCLUSIVE.", ALTER_TABLE),
  SQLPG227: rule(
    "SQLPG227",
    "expand",
    "Change partitioning or inheritance",
    "A table's partition key, its parent or bound, INHERITS and OF type cannot be altered in place: a new table is filled and swapped in. DETACH PARTITION CONCURRENTLY (14 and later) and ATTACH PARTITION, which takes SHARE UPDATE EXCLUSIVE on the parent, are the steps.",
    `${DOCS}/ddl-partitioning.html`,
  ),
  SQLPG228: rule(
    "SQLPG228",
    "expand",
    "Rename an object or move it to another schema",
    "RENAME and SET SCHEMA are catalog changes, but every reader still using the old name fails at once: create the new name (a view over the old object works), move readers, drop the old.",
    ALTER_TABLE,
  ),
  SQLPG229: rule("SQLPG229", "metadata", "Rename an index", "ALTER INDEX ... RENAME changes only the catalog; nothing reads an index by name.", `${DOCS}/sql-alterindex.html`),
  SQLPG240: rule(
    "SQLPG240",
    "concurrently",
    "Create an index CONCURRENTLY",
    "CREATE INDEX CONCURRENTLY builds the index without blocking writes (SHARE UPDATE EXCLUSIVE), in two scans, and cannot run inside a transaction block; a failed build leaves an INVALID index to drop.",
    CREATE_INDEX,
  ),
  SQLPG241: rule(
    "SQLPG241",
    "concurrently",
    "Create an index without CONCURRENTLY",
    "CREATE INDEX on an existing table takes SHARE, which blocks every write to the table until the build ends. Declare it CONCURRENTLY.",
    CREATE_INDEX,
  ),
  SQLPG242: rule(
    "SQLPG242",
    "concurrently",
    "Drop an index",
    "DROP INDEX takes ACCESS EXCLUSIVE on the table; DROP INDEX CONCURRENTLY waits for running queries instead, and cannot run inside a transaction block.",
    `${DOCS}/sql-dropindex.html`,
  ),
  SQLPG243: rule(
    "SQLPG243",
    "concurrently",
    "Change an index",
    "An index's definition cannot be altered: it is dropped and created, both CONCURRENTLY to keep writes going (SQLPG240, SQLPG242).",
    CREATE_INDEX,
  ),
  SQLPG250: rule(
    "SQLPG250",
    "metadata",
    "Change a view's query, keeping its columns",
    "CREATE OR REPLACE VIEW replaces the query under ACCESS EXCLUSIVE on the view when the new query keeps the old columns, by name, in order, and only appends new ones.",
    `${DOCS}/sql-createview.html`,
  ),
  SQLPG251: rule(
    "SQLPG251",
    "expand",
    "Change a view's columns",
    "A view whose columns are removed, renamed or reordered cannot be replaced: it is dropped and created, and every view and reader on top of it with it.",
    `${DOCS}/sql-createview.html`,
  ),
  SQLPG252: rule(
    "SQLPG252",
    "rewrite",
    "Change a materialized view's query",
    "A materialized view's query cannot be altered: it is dropped and created, and its rows are computed again, with every view on top of it dropped too.",
    `${DOCS}/sql-creatematerializedview.html`,
  ),
  SQLPG253: rule("SQLPG253", "metadata", "Change a view's options", "ALTER VIEW ... SET (check_option, security_barrier, security_invoker) changes only the catalog.", `${DOCS}/sql-alterview.html`),
  SQLPG260: rule(
    "SQLPG260",
    "metadata",
    "Add an enum label",
    "ALTER TYPE ... ADD VALUE changes only the catalog; since 12 it can run in a transaction block, but the new label cannot be used in that transaction.",
    `${DOCS}/sql-altertype.html`,
  ),
  SQLPG261: rule(
    "SQLPG261",
    "expand",
    "Remove or reorder enum labels",
    "An enum label cannot be removed and labels cannot be reordered in place: a new type is created, columns are moved to it, and the old one is dropped.",
    `${DOCS}/sql-altertype.html`,
  ),
  SQLPG262: rule(
    "SQLPG262",
    "validate",
    "Add a domain constraint",
    "ALTER DOMAIN ADD CONSTRAINT (and SET NOT NULL) checks every column of the domain's type in every table; ADD CONSTRAINT ... NOT VALID skips existing rows and VALIDATE CONSTRAINT checks them later.",
    `${DOCS}/sql-alterdomain.html`,
  ),
  SQLPG263: rule("SQLPG263", "metadata", "Change a domain's default or drop its constraint", "ALTER DOMAIN SET DEFAULT, DROP NOT NULL and DROP CONSTRAINT change only the catalog.", `${DOCS}/sql-alterdomain.html`),
  SQLPG264: rule("SQLPG264", "expand", "Change a domain's data type", "A domain's underlying type cannot be altered: a new domain is created and columns are moved to it.", `${DOCS}/sql-alterdomain.html`),
  SQLPG265: rule("SQLPG265", "metadata", "Change a sequence's options", "ALTER SEQUENCE changes the sequence's own row; tables are not touched. A sequence's AS type bounds its values.", `${DOCS}/sql-altersequence.html`),
  SQLPG266: rule(
    "SQLPG266",
    "metadata",
    "Change an extension's version or schema",
    "ALTER EXTENSION UPDATE runs the extension's update script, which may itself alter objects; SET SCHEMA moves its objects.",
    `${DOCS}/sql-alterextension.html`,
  ),
  SQLPG267: rule("SQLPG267", "metadata", "Change a schema's owner", "ALTER SCHEMA ... OWNER TO changes only the catalog.", `${DOCS}/sql-alterschema.html`),
  SQLPG268: rule("SQLPG268", "expand", "Change an object's kind", "A view and a materialized view, or a table and either, are different kinds of object: the old one is dropped and the new one created.", `${DOCS}/sql-createview.html`),
  SQLPG280: rule(
    "SQLPG280",
    "metadata",
    "Replace a function's or procedure's definition",
    "CREATE OR REPLACE FUNCTION (or PROCEDURE) replaces the body and attributes in the catalog; it locks no table, and a call already running finishes with the old definition. The parameter types, the result and the input parameters' names have to stay the same.",
    `${DOCS}/sql-createfunction.html`,
  ),
  SQLPG281: rule(
    "SQLPG281",
    "metadata",
    "Drop and create a function or procedure",
    "CREATE OR REPLACE refuses a change of the result type, the output parameters, an input parameter's name, a removed parameter default or the routine's kind: the routine is dropped and created in one transaction. Nothing on the server depends on it (a view, a trigger, a column default would make the DROP fail).",
    `${DOCS}/sql-createfunction.html`,
  ),
  SQLPG282: rule(
    "SQLPG282",
    "expand",
    "Change a function's result or parameters while other objects depend on it",
    "DROP FUNCTION refuses while a view, a trigger, a column default or another routine depends on the function, and CREATE OR REPLACE cannot make this change. Create the new definition under a new name (or signature), move what depends on it, then drop the old.",
    `${DOCS}/sql-dropfunction.html`,
  ),
  SQLPG283: rule(
    "SQLPG283",
    "metadata",
    "Create a trigger on an existing table",
    "CREATE TRIGGER takes SHARE ROW EXCLUSIVE on its table: writes and other schema changes to the table wait until the transaction commits, but no row is read. The applier's lock_timeout bounds the wait behind long-running transactions.",
    `${DOCS}/sql-createtrigger.html`,
  ),
  SQLPG284: rule(
    "SQLPG284",
    "metadata",
    "Change a trigger",
    "CREATE OR REPLACE TRIGGER (14 and later) replaces the trigger under SHARE ROW EXCLUSIVE on its table. A constraint trigger has no OR REPLACE, and a trigger moved to another table is another trigger: each is dropped (ACCESS EXCLUSIVE, briefly) and created in one transaction.",
    `${DOCS}/sql-createtrigger.html`,
  ),
  SQLPG285: rule("SQLPG285", "drop", "Drop a trigger", "DROP TRIGGER takes ACCESS EXCLUSIVE on its table, briefly; no row is read or lost, and the table's writes no longer fire it.", `${DOCS}/sql-droptrigger.html`),
  SQLPG270: rule("SQLPG270", "drop", "Drop an object", "The object and, for a table, a materialized view or a sequence, its data are gone.", `${DOCS}/sql-droptable.html`),
} as const satisfies Record<string, PgClassifierRule>;

export type PgClassifierRuleId = keyof typeof PG_CLASSIFIER_RULES;
