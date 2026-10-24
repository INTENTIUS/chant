/**
 * The Postgres entities: `schema`, `table`, `index`, `view`, `sequence`,
 * `type` (enum, composite and range), `domain`, `extension`, `func`,
 * `procedure`, `aggregate`, `trigger`, `eventTrigger`, `collation`, `cast`,
 * `operatorClass`, `operatorFamily`, `foreignTable`, `textSearchConfiguration`,
 * `textSearchDictionary`, `policy`, `role` and `grant` tagged templates that parse their DDL at fold
 * time into one Declarable each (chant #3278, #3279, #3680, #3681, #3911).
 *
 * ```ts
 * import { schema, table, index } from "@intentius/chant-lexicon-sql/postgres";
 *
 * export const app = schema`CREATE SCHEMA app`;
 * export const users = table`
 *   CREATE TABLE ${app}.users (
 *     id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 *     email text NOT NULL UNIQUE
 *   );
 *   COMMENT ON TABLE ${app}.users IS 'One row per account'`;
 * export const usersEmail = index`CREATE INDEX users_email_idx ON ${users} (lower(${users.columns.email}))`;
 * ```
 *
 * The export name is the object's identity in chant; the name in the SQL is
 * its name in the database. An unquoted name folds to lower case, as Postgres
 * folds it, so `CREATE TABLE Users` is `users` and `.columns` is keyed by the
 * folded name.
 *
 * What an interpolation means is decided by its value, as for ClickHouse
 * (#3235):
 *
 * - a Postgres entity is a reference to that object and renders as its
 *   schema-qualified name; a schema renders as its name, so `${app}.users`
 *   reads `app.users`;
 * - `entity.columns.<name>` is a reference to one column, and renders as the
 *   column's name (write `u.${users.columns.id}` in a join);
 * - a sequence inside `nextval(...)`, `currval(...)` or `setval(...)`, and any
 *   object followed by `::regclass`, renders as a `regclass` literal:
 *   `DEFAULT nextval(${ticketSeq})` reads `nextval('app.ticket_seq'::regclass)`,
 *   which is also how the catalog prints it, and the table depends on the
 *   sequence;
 * - a string is SQL text, spliced into the statement before it is parsed;
 * - a number or bigint is a numeric literal, a boolean `true`/`false`, `null`
 *   is `NULL`;
 * - `literal(value)` is a quoted string literal (`'` doubled; a backslash is an
 *   ordinary character, since standard_conforming_strings is on).
 *
 * A function's or procedure's body is a string constant (`AS $$ ... $$`), kept
 * verbatim. An interpolation inside it renders as text (an object as its
 * schema-qualified name, a column reference as the column's name) and is
 * recorded as a reference, so the routine is created after what its body
 * names: `` func`... AS $$ SELECT count(*) FROM ${users} $$` ``.
 *
 * Postgres has no inline comment clause, so a template may follow its CREATE
 * with `COMMENT ON` statements for the same object, its columns and its
 * constraints. They fold into the entity's `comment`, each column's and each
 * constraint's, and stay in the DDL.
 */

import type { AttrRef } from "@intentius/chant/attrref";
import { setInterpolationFields } from "@intentius/chant/provenance";
import { isTrivia, POSTGRES_LEXICAL, SqlSyntaxError, untokenize, type Token } from "./tokens";
import { identValue, parseStatements, type ColumnNode, type CommentNode, type ConstraintNode, type DefElem, type GenericOption, type GrantNode, type NameNode, type RowSecurityNode, type Span, type StatementNode, type TextSearchMappingNode } from "./parser";
import { keywordCategory, quoteIdent } from "./keywords";
import { feed, lineage, spanText as text, splice as spliceWith, templateSyntaxError, unparsedClauses, type TemplateCtx, type TemplateDialect, type UnparsedClause } from "../core/interpolation";
import { SqlObject, isColumnRefOf, isSqlObjectOf, makeSqlEntity } from "../core/entity";
import type { LineageEdge } from "../core/references";
import { SqlLiteral, SqlTemplateError, describeValue as describe, stripUnset, templateParts } from "../core/template";
import { setTypedSlots, type ColumnsIn, type Named, type RowIn, type SlotsIn, type TypedSlot, type Unnamed } from "../core/typed";

export { SQL_LEXICON } from "../core/entity";
export type { LineageEdge } from "../core/references";
export type { UnparsedClause } from "../core/interpolation";
export { SqlLiteral, SqlTemplateError } from "../core/template";
export { quoteIdent } from "./keywords";
export type { AnyColumn, Column, ColumnTraits, KeyColumn, Named, NotNullColumn, UncheckedColumn, Unnamed } from "../core/typed";

export { POSTGRES_ENTITY_TYPES, type PostgresEntityType } from "./entity-types";
import { POSTGRES_ENTITY_TYPES, type PostgresEntityType } from "./entity-types";
import { isSecretOption } from "./secret-options";

// ── Values ─────────────────────────────────────────────────────────────

/** A column as declared. Expressions are the source text with interpolations rendered. */
export interface ColumnDef {
  name: string;
  /** Absent on a typed table (`OF type`) or a partition, whose columns take their type elsewhere. */
  type?: string;
  /** `NOT NULL` (true) or `NULL` (false), when written. */
  notNull?: boolean;
  /** The name given to the column's NOT NULL constraint. */
  notNullName?: string;
  default?: string;
  /** `GENERATED ALWAYS AS (expr) STORED | VIRTUAL`, or `GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY [(options)]`. */
  generated?: { kind: "stored" | "virtual" | "identity"; expr?: string; always: boolean; options?: string };
  collate?: string;
  compression?: string;
  storage?: string;
  /** A foreign table column's `OPTIONS (...)`: each option by its name to its string value. */
  options?: Record<string, string>;
  comment?: string;
}

/** Deferral attributes, on the constraints that take them. */
interface Deferral {
  deferrable?: boolean;
  initiallyDeferred?: boolean;
}

export interface KeyDef extends Deferral {
  name?: string;
  columns: string[];
  nullsNotDistinct?: boolean;
  include?: string;
  with?: string;
  comment?: string;
}

export interface CheckDef {
  name?: string;
  expr: string;
  noInherit?: boolean;
  notValid?: boolean;
  notEnforced?: boolean;
  comment?: string;
}

export interface ForeignKeyDef extends Deferral {
  name?: string;
  columns: string[];
  /** The referenced table: the entity when it is interpolated, else its name as written. */
  references: PostgresObject | string;
  /** The referenced table's SQL name, schema-qualified as written. */
  refTable: string;
  /** The referenced columns; empty means the referenced table's primary key. */
  refColumns: string[];
  match?: string;
  onDelete?: string;
  onUpdate?: string;
  notValid?: boolean;
  notEnforced?: boolean;
  comment?: string;
}

export interface ExclusionDef extends Deferral {
  name?: string;
  using?: string;
  /** The element list, `col WITH op, ...`, as written. */
  elements: string;
  where?: string;
  include?: string;
  with?: string;
  comment?: string;
}

interface CommonProps {
  /** The object's name in the database, folded as Postgres folds it. */
  name: string;
  /** The schema the DDL qualifies it with. */
  schema?: string;
  comment?: string;
  /** The statements as they will be sent: the author's text, interpolations rendered. */
  ddl: string;
  /** The template's raw parts, as written, for a source round trip. */
  source: { strings: string[] };
  /**
   * Clauses chant's parser does not know (#3872), kept in `ddl` as written
   * and left to the catalog checks and the server. Absent when there are none.
   */
  unparsed?: UnparsedClause[];
}

export interface SchemaProps extends Omit<CommonProps, "schema"> {
  ifNotExists?: boolean;
  authorization?: string;
}

export interface TableProps extends CommonProps {
  persistence?: "temporary" | "unlogged";
  ifNotExists?: boolean;
  /** `PARTITION OF parent`: the entity when interpolated, else its name. */
  partitionOf?: PostgresObject | string;
  partitionBound?: string;
  /** `OF type`: the entity when interpolated, else its name. */
  ofType?: PostgresObject | string;
  columns: ColumnDef[];
  primaryKey?: KeyDef;
  uniques: KeyDef[];
  checks: CheckDef[];
  foreignKeys: ForeignKeyDef[];
  exclusions: ExclusionDef[];
  /** `LIKE source [options]` clauses, as written. */
  like: string[];
  inherits: Array<PostgresObject | string>;
  partitionBy?: string;
  using?: string;
  /** Storage parameters, as written: `(fillfactor = 70)`. */
  with?: string;
  onCommit?: string;
  tablespace?: string;
  /** `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` after the CREATE (true), or `DISABLE` (false). */
  rowSecurity?: boolean;
  /** `ALTER TABLE ... FORCE ROW LEVEL SECURITY` after the CREATE (true), or `NO FORCE` (false): the owner is subject to the policies too. */
  forceRowSecurity?: boolean;
}

export interface IndexProps extends CommonProps {
  /** The indexed table: the entity when interpolated, else its name. */
  table: PostgresObject | string;
  /** The indexed table's SQL name. */
  tableName: string;
  unique?: boolean;
  /** `CREATE INDEX CONCURRENTLY`: the classifier and the applier read it, since it refuses a transaction block. */
  concurrently?: boolean;
  ifNotExists?: boolean;
  only?: boolean;
  /** The access method (`btree`, `gin`, ...), when written. */
  method?: string;
  elements: Array<{ expr: string; column?: string }>;
  include?: string;
  nullsNotDistinct?: boolean;
  with?: string;
  tablespace?: string;
  where?: string;
}

export interface ViewProps extends CommonProps {
  orReplace?: boolean;
  recursive?: boolean;
  temporary?: boolean;
  ifNotExists?: boolean;
  /** The declared column list; empty when the view names its outputs in its query. */
  columns: string[];
  with?: string;
  using?: string;
  tablespace?: string;
  query: string;
  checkOption?: string;
  /** `WITH DATA` (true) or `WITH NO DATA` (false), for a materialized view. */
  withData?: boolean;
  /** The objects the query reads, as references. */
  reads: PostgresObject[];
  /** Per output column of the top-level select list, the columns it reads. */
  lineage: LineageEdge[];
  /** `COMMENT ON COLUMN` for the view's outputs. */
  columnComments?: Record<string, string>;
}

export interface SequenceProps extends CommonProps {
  persistence?: "temporary" | "unlogged";
  ifNotExists?: boolean;
  /** `AS type`: the sequence's data type. */
  dataType?: string;
  increment?: string;
  /** A value, or `null` for `NO MINVALUE`. */
  minValue?: string | null;
  maxValue?: string | null;
  start?: string;
  cache?: string;
  /** `CYCLE` (true) or `NO CYCLE` (false), when written. */
  cycle?: boolean;
  /** `OWNED BY table.column`, or `NONE`. */
  ownedBy?: string;
}

export interface EnumProps extends CommonProps {
  labels: string[];
}

/** A composite type's attribute, as written. */
export interface CompositeAttributeDef {
  name: string;
  type: string;
  collate?: string;
}

export interface CompositeTypeProps extends CommonProps {
  attributes: CompositeAttributeDef[];
}

export interface RangeTypeProps extends CommonProps {
  /** `SUBTYPE`: the element type. */
  subtype: string;
  subtypeOpclass?: string;
  collation?: string;
  /** `CANONICAL`: the function that canonicalizes a value (a C function). */
  canonical?: string;
  subtypeDiff?: string;
  /** `MULTIRANGE_TYPE_NAME`: the multirange type's name, when it is not the one Postgres derives. */
  multirangeTypeName?: string;
}

/** One argument of an aggregate, as written. */
export interface AggregateArgDef {
  /** `in` when not written. */
  mode: "in" | "variadic";
  name?: string;
  type: string;
}

export interface AggregateProps extends CommonProps {
  orReplace?: boolean;
  /** The arguments; empty for `(*)`. An ordered-set aggregate's direct arguments. */
  args: AggregateArgDef[];
  /** An ordered-set aggregate's aggregated arguments (`ORDER BY ...`). */
  orderBy?: AggregateArgDef[];
  /**
   * The definition: each option by its name, folded (`sfunc`, `stype`,
   * `initcond`), to its value as written; an option given without a value
   * (`HYPOTHETICAL`, `FINALFUNC_EXTRA`) to `true`.
   */
  options: Record<string, string>;
}

export interface CollationProps extends CommonProps {
  ifNotExists?: boolean;
  /** Each option by its name, folded (`provider`, `locale`, `deterministic`), to its value as written. */
  options: Record<string, string>;
}

export interface CastProps extends Omit<CommonProps, "schema"> {
  /** `(source AS target)`: a cast is named by its two types and lives in no schema. */
  name: string;
  /** The source type as written. */
  sourceType: string;
  /** The target type as written. */
  targetType: string;
  /** `WITH FUNCTION` (`function`), `WITHOUT FUNCTION` (`binary`) or `WITH INOUT` (`inout`). */
  method: "function" | "binary" | "inout";
  /** The cast function: the entity when interpolated, else its name. */
  function?: PostgresObject | string;
  /** The cast function's SQL name. */
  functionName?: string;
  /** The cast function's parameter types, when written. */
  functionArgs?: string;
  /** `explicit` (the default), `AS ASSIGNMENT` or `AS IMPLICIT`. */
  context: "explicit" | "assignment" | "implicit";
}

export interface EventTriggerProps extends Omit<CommonProps, "schema"> {
  /** `ddl_command_start`, `ddl_command_end`, `sql_drop`, `table_rewrite` or `login`. */
  event: string;
  /** `WHEN TAG IN (...)`: the command tags it fires for; every one when absent. */
  tags?: string[];
  /** The function it executes: the entity when interpolated, else its name. */
  function: PostgresObject | string;
  functionName: string;
}

export interface OperatorProps extends CommonProps {
  /** `LEFTARG`, as written; absent for a prefix operator. */
  leftArg?: string;
  /** `RIGHTARG`, as written; absent for a postfix operator (removed in 14, so for none the server still holds). */
  rightArg?: string;
  /**
   * The rest of the definition by option name, folded (`function`,
   * `commutator`, `restrict`), to its value as written; `hashes` and `merges`
   * to `true`. `procedure`, the old spelling, is `function`.
   */
  options: Record<string, string>;
}

/** One member of an operator class, as written. */
export type OperatorClassItemDef =
  | {
      kind: "operator";
      number: string;
      /** The operator, `schema.symbol` or a bare symbol. */
      operator: string;
      /** `(left, right)` as written, parentheses excluded; absent when both are the class's type. */
      types?: string;
      /** `FOR ORDER BY`'s btree operator family; absent for `FOR SEARCH`, the default. */
      orderBy?: string;
    }
  | { kind: "function"; number: string; types?: string; function: string; args: string }
  | { kind: "storage"; type: string };

/** `CREATE OPERATOR CLASS`: the operators and support functions an index access method uses for a data type. */
export interface OperatorClassProps extends CommonProps {
  default?: boolean;
  /** `FOR TYPE`, as written. Not `type`: a serialized object has that key for its entity type. */
  dataType: string;
  /** `USING`: the index access method, folded. */
  method: string;
  /** `FAMILY`, as written; absent when the class is in a family of its own name. */
  family?: string;
  items: OperatorClassItemDef[];
}

/** `CREATE OPERATOR FAMILY`: a set of operator classes that work together; members arrive with the classes. */
export interface OperatorFamilyProps extends CommonProps {
  /** `USING`: the index access method, folded. */
  method: string;
}

/** `CREATE FOREIGN TABLE`: a table whose rows are on a foreign server. */
export interface ForeignTableProps extends CommonProps {
  ifNotExists?: boolean;
  columns: ColumnDef[];
  checks: CheckDef[];
  /** `SERVER`: the foreign server's SQL name. */
  serverName: string;
  /** `OPTIONS (...)`: each option by its name to its string value. */
  options: Record<string, string>;
}

/** `CREATE TEXT SEARCH DICTIONARY`: a template with its options. */
export interface TextSearchDictionaryProps extends CommonProps {
  /** `TEMPLATE`, as written. */
  template: string;
  /** The template's options by name, folded, to their value as written. */
  options: Record<string, string>;
}

/** One `ADD MAPPING FOR tokens WITH dictionaries` of a text search configuration. */
export interface TextSearchMappingDef {
  /** The token types, folded. */
  tokens: string[];
  /** The dictionaries in the order they are consulted, as written. */
  dictionaries: string[];
}

/** `CREATE TEXT SEARCH CONFIGURATION`: a parser and what each token type it finds is mapped to. */
export interface TextSearchConfigurationProps extends CommonProps {
  /** `PARSER`, as written. */
  parser: string;
  mappings: TextSearchMappingDef[];
}

/** `CREATE STATISTICS`: extended statistics on columns or expressions of one table. */
export interface StatisticsProps extends CommonProps {
  ifNotExists?: boolean;
  /** `ndistinct`, `dependencies`, `mcv`, folded; absent when the server computes all three. */
  kinds?: string[];
  /** Each column or expression, as written. */
  targets: string[];
  /** The table: the entity when interpolated, else its name. */
  table: PostgresObject | string;
  /** The table's SQL name. */
  tableName: string;
}

export interface ForeignDataWrapperProps extends Omit<CommonProps, "schema"> {
  /** The handler function: the entity when interpolated, else its name. */
  handler?: PostgresObject | string;
  handlerName?: string;
  /** `NO HANDLER`, written out. */
  noHandler?: boolean;
  validator?: PostgresObject | string;
  validatorName?: string;
  noValidator?: boolean;
  /** `OPTIONS (...)`: each option by its name to its string value. */
  options: Record<string, string>;
}

export interface ForeignServerProps extends Omit<CommonProps, "schema"> {
  ifNotExists?: boolean;
  serverType?: string;
  version?: string;
  /** The wrapper: the entity when interpolated, else its name. */
  wrapper: PostgresObject | string;
  wrapperName: string;
  options: Record<string, string>;
}

/** A table of a publication, with the column list and row filter it is published with. */
export interface PublicationTableDef {
  /** The table: the entity when interpolated, else its name. */
  table: PostgresObject | string;
  tableName: string;
  columns?: string[];
  /** The row filter, as written with its parentheses. */
  where?: string;
}

export interface PublicationProps extends Omit<CommonProps, "schema"> {
  allTables?: boolean;
  tables: PublicationTableDef[];
  /** `TABLES IN SCHEMA`: the schema's SQL name, an interpolated schema by its name. */
  schemas: string[];
  /** `WITH (...)`: each option by its name to its value as written. */
  options: Record<string, string>;
}

export interface DomainProps extends CommonProps {
  /** The underlying data type. */
  dataType: string;
  collate?: string;
  default?: string;
  notNull?: boolean;
  checks: CheckDef[];
}

export interface ExtensionProps extends Omit<CommonProps, "schema"> {
  /** `WITH SCHEMA`: the schema the extension's objects are created in. */
  schema?: string;
  version?: string;
  cascade?: boolean;
  ifNotExists?: boolean;
}

/** One parameter of a function or procedure, as written. */
export interface RoutineArgDef {
  /** `in` when not written. */
  mode: "in" | "out" | "inout" | "variadic";
  name?: string;
  type: string;
  default?: string;
}

export interface RoutineProps extends CommonProps {
  orReplace?: boolean;
  args: RoutineArgDef[];
  /** `RETURNS type`, `SETOF` included (`setof app.users`). */
  returns?: string;
  /** `RETURNS TABLE (...)`'s columns. */
  returnsTable?: Array<{ name: string; type: string }>;
  language?: string;
  volatility?: "immutable" | "stable" | "volatile";
  /** `STRICT` / `RETURNS NULL ON NULL INPUT` (true) or `CALLED ON NULL INPUT` (false). */
  strict?: boolean;
  /** `SECURITY DEFINER` (true) or `SECURITY INVOKER` (false). */
  securityDefiner?: boolean;
  leakproof?: boolean;
  parallel?: "unsafe" | "restricted" | "safe";
  cost?: string;
  rows?: string;
  support?: string;
  window?: boolean;
  /** `TRANSFORM FOR TYPE ...`, as written. */
  transform?: string;
  /** `SET name = value` clauses: each parameter, folded, to its value as written. */
  set?: Record<string, string>;
  /** The definition: the string constant's value, verbatim. */
  body: string;
  /** A C function's link symbol (`AS 'obj_file', 'link_symbol'`). */
  link?: string;
  /** The objects the body interpolates. */
  reads: PostgresObject[];
}

/** `func` declares a function; `procedure` a procedure, which has no result and none of a function's planner attributes. */
export type FunctionProps = RoutineProps;
export type ProcedureProps = Omit<RoutineProps, "returns" | "returnsTable" | "volatility" | "strict" | "leakproof" | "parallel" | "cost" | "rows" | "support" | "window">;

export interface TriggerProps extends CommonProps {
  orReplace?: boolean;
  /** `CREATE CONSTRAINT TRIGGER`. */
  constraint?: boolean;
  timing: "before" | "after" | "instead of";
  /** The events, each `insert`, `update`, `delete` or `truncate`; an `update` may name its columns. */
  events: Array<{ event: "insert" | "update" | "delete" | "truncate"; columns?: string[] }>;
  /** The table or view: the entity when interpolated, else its name. */
  table: PostgresObject | string;
  /** The table's SQL name. */
  tableName: string;
  /** A constraint trigger's `FROM` table's SQL name. */
  from?: string;
  deferrable?: boolean;
  initiallyDeferred?: boolean;
  /** `REFERENCING OLD TABLE AS ...` / `NEW TABLE AS ...`. */
  referencing?: { old?: string; new?: string };
  /** `FOR EACH ROW` or `FOR EACH STATEMENT` (the default). */
  forEach: "row" | "statement";
  /** The `WHEN` condition, parentheses excluded. */
  when?: string;
  /** The function it executes: the entity when interpolated, else its name. */
  function: PostgresObject | string;
  /** The function's SQL name. */
  functionName: string;
  /** The arguments, as written. */
  args: string[];
}

export interface PolicyProps extends CommonProps {
  /** The table: the entity when interpolated, else its name. */
  table: PostgresObject | string;
  tableName: string;
  /** `AS PERMISSIVE` (the default) or `AS RESTRICTIVE`. */
  permissive: boolean;
  command: "all" | "select" | "insert" | "update" | "delete";
  /** The roles it applies to; `public` when it names none. */
  roles: string[];
  /** `USING (...)`, parentheses excluded. */
  using?: string;
  /** `WITH CHECK (...)`, parentheses excluded. */
  check?: string;
}

export interface RoleProps extends Omit<CommonProps, "schema"> {
  /** The options written, each by its key word, lower case (`login`, `noinherit`). */
  options: string[];
  /** `CONNECTION LIMIT n`. */
  connectionLimit?: string;
}

/** A privilege as written: `select`, `update` on some columns, `all`. */
export interface PrivilegeDef {
  privilege: string;
  columns?: string[];
}

export interface GrantProps {
  /** A grant's or revoke's name, which no catalog holds: what it grants on what to whom. */
  name: string;
  action: "grant" | "revoke";
  /** `REVOKE GRANT OPTION FOR`: only the right to grant on is revoked. */
  grantOptionFor?: boolean;
  privileges: PrivilegeDef[];
  /** The kind of object. */
  on: "table" | "sequence" | "schema" | "function" | "procedure" | "routine";
  /** The objects: each the entity when interpolated, else its name. */
  objects: Array<PostgresObject | string>;
  /** The objects' SQL names; a routine's with its parameter types when they are written or interpolated. */
  objectNames: string[];
  /** Role names; `public` for PUBLIC. */
  grantees: string[];
  withGrantOption?: boolean;
  ddl: string;
  source: { strings: string[] };
}

export interface DefaultPrivilegesProps {
  name: string;
  action: "grant" | "revoke";
  grantOptionFor?: boolean;
  /** `FOR ROLE`: the roles whose new objects it applies to; the role that applies it when not written. */
  forRoles?: string[];
  /** `IN SCHEMA`: the schemas; every schema when not written. */
  inSchemas?: string[];
  privileges: string[];
  on: "tables" | "sequences" | "functions" | "types" | "schemas";
  grantees: string[];
  withGrantOption?: boolean;
  ddl: string;
  source: { strings: string[] };
}

/**
 * A string as a quoted Postgres string literal: `'` doubled, a backslash left
 * as written (standard_conforming_strings is on). An interpolated plain string
 * is SQL text; wrap it in `literal()` when it is a value.
 */
export function literal(value: string | number | boolean | null): SqlLiteral {
  if (value === null) return new SqlLiteral("NULL");
  if (typeof value !== "string") return new SqlLiteral(String(value));
  return new SqlLiteral(`'${value.replace(/'/g, "''")}'`);
}

// ── Entities ───────────────────────────────────────────────────────────

/** The members a Postgres entity has besides its props (the shared core's {@link SqlObject}). */
export abstract class PostgresObject extends SqlObject {
  declare readonly entityType: PostgresEntityType;
  /** The name the object is referred to by in SQL: `name`, or `schema.name`, quoted where Postgres needs it. */
  declare readonly sqlName: string;
}

/**
 * A schema. `N` is its name when its tag was given one
 * (`` schema<"shop">`CREATE SCHEMA shop` ``), which is how a composite placed
 * in it knows its members' qualified names (chant#3787).
 */
export interface PostgresSchema<N extends string = string> extends PostgresObject, Named<N> {
  readonly entityType: "Postgres::Schema";
  readonly props: SchemaProps;
}

/**
 * Every Postgres table and view the project declares, keyed by its qualified
 * name (`shop.orders`). Empty here; the `sql-types.d.ts` that `chant sql
 * types` writes augments it, and a tag given the name as its type argument
 * reads its columns from there.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmented by the generated declarations
export interface SqlSchema {}

/**
 * A table or a view: something with columns that SQL can reference. `N` is
 * its qualified name when its tag was given one (`` table<"shop.orders">`...` ``):
 * its columns are then the generated declarations' entry for that name.
 */
export interface PostgresRelation<N extends string = string> extends PostgresObject, Named<N> {
  /** One reference per column, by its folded name: `${users.columns.email}`. */
  readonly columns: ColumnsIn<SqlSchema, N>;
}

export interface PostgresTable<N extends string = string> extends PostgresRelation<N> {
  readonly entityType: "Postgres::Table";
  readonly props: TableProps;
}

export interface PostgresView<N extends string = string> extends PostgresRelation<N> {
  readonly entityType: "Postgres::View" | "Postgres::MaterializedView";
  readonly props: ViewProps;
}

export interface PostgresIndex extends PostgresObject {
  readonly entityType: "Postgres::Index";
  readonly props: IndexProps;
}

export interface PostgresSequence extends PostgresObject {
  readonly entityType: "Postgres::Sequence";
  readonly props: SequenceProps;
}

export interface PostgresEnum extends PostgresObject {
  readonly entityType: "Postgres::Enum";
  readonly props: EnumProps;
}

export interface PostgresCompositeType extends PostgresObject {
  readonly entityType: "Postgres::CompositeType";
  readonly props: CompositeTypeProps;
}

export interface PostgresRangeType extends PostgresObject {
  readonly entityType: "Postgres::RangeType";
  readonly props: RangeTypeProps;
}

/** What the `type` tag declares: an enum, a composite or a range type. */
export type PostgresType = PostgresEnum | PostgresCompositeType | PostgresRangeType;

export interface PostgresDomain extends PostgresObject {
  readonly entityType: "Postgres::Domain";
  readonly props: DomainProps;
}

export interface PostgresAggregate extends PostgresObject {
  readonly entityType: "Postgres::Aggregate";
  readonly props: AggregateProps;
}

export interface PostgresCollation extends PostgresObject {
  readonly entityType: "Postgres::Collation";
  readonly props: CollationProps;
}

export interface PostgresCast extends PostgresObject {
  readonly entityType: "Postgres::Cast";
  readonly props: CastProps;
}

export interface PostgresEventTrigger extends PostgresObject {
  readonly entityType: "Postgres::EventTrigger";
  readonly props: EventTriggerProps;
}

export interface PostgresOperator extends PostgresObject {
  readonly entityType: "Postgres::Operator";
  readonly props: OperatorProps;
}

export interface PostgresOperatorClass extends PostgresObject {
  readonly entityType: "Postgres::OperatorClass";
  readonly props: OperatorClassProps;
}

export interface PostgresOperatorFamily extends PostgresObject {
  readonly entityType: "Postgres::OperatorFamily";
  readonly props: OperatorFamilyProps;
}

export interface PostgresForeignTable extends PostgresObject {
  readonly entityType: "Postgres::ForeignTable";
  readonly props: ForeignTableProps;
}

export interface PostgresTextSearchDictionary extends PostgresObject {
  readonly entityType: "Postgres::TextSearchDictionary";
  readonly props: TextSearchDictionaryProps;
}

export interface PostgresTextSearchConfiguration extends PostgresObject {
  readonly entityType: "Postgres::TextSearchConfiguration";
  readonly props: TextSearchConfigurationProps;
}

export interface PostgresStatistics extends PostgresObject {
  readonly entityType: "Postgres::Statistics";
  readonly props: StatisticsProps;
}

export interface PostgresForeignDataWrapper extends PostgresObject {
  readonly entityType: "Postgres::ForeignDataWrapper";
  readonly props: ForeignDataWrapperProps;
}

export interface PostgresForeignServer extends PostgresObject {
  readonly entityType: "Postgres::ForeignServer";
  readonly props: ForeignServerProps;
}

export interface PostgresPublication extends PostgresObject {
  readonly entityType: "Postgres::Publication";
  readonly props: PublicationProps;
}

export interface PostgresExtension extends PostgresObject {
  readonly entityType: "Postgres::Extension";
  readonly props: ExtensionProps;
}

export interface PostgresFunction extends PostgresObject {
  readonly entityType: "Postgres::Function";
  readonly props: FunctionProps;
}

export interface PostgresProcedure extends PostgresObject {
  readonly entityType: "Postgres::Procedure";
  readonly props: ProcedureProps;
}

export interface PostgresTrigger extends PostgresObject {
  readonly entityType: "Postgres::Trigger";
  readonly props: TriggerProps;
}

export interface PostgresPolicy extends PostgresObject {
  readonly entityType: "Postgres::Policy";
  readonly props: PolicyProps;
}

export interface PostgresRole extends PostgresObject {
  readonly entityType: "Postgres::Role";
  readonly props: RoleProps;
}

export interface PostgresGrant extends PostgresObject {
  readonly entityType: "Postgres::Grant" | "Postgres::DefaultPrivileges";
  readonly props: GrantProps | DefaultPrivilegesProps;
}

/**
 * A declared table's or view's row, for application code: `RowOf<typeof orders>`
 * for a declaration given its name, or `RowOf<"shop.users">` by name, which
 * also covers an object only a `.sql` file declares.
 */
export type RowOf<T extends keyof SqlSchema | Named<keyof SqlSchema & string>> = RowIn<SqlSchema, T>;

export function isPostgresObject(value: unknown): value is PostgresObject {
  return isSqlObjectOf(value, "Postgres::");
}

/** A column reference: an AttrRef whose parent is a Postgres table or view. */
export function isColumnRef(value: unknown): value is AttrRef {
  return isColumnRefOf(value, isPostgresObject);
}

// ── Rendering interpolations ───────────────────────────────────────────

function renderReference(value: unknown): string {
  if (isPostgresObject(value)) return value.sqlName;
  if (isColumnRef(value)) return quoteIdent(value.attribute);
  throw new TypeError(`not a reference: ${describe(value)}`);
}

/** A name as a `regclass` literal's text: `'app.ticket_seq'`. */
const regclassText = (sqlName: string): string => `'${sqlName.replace(/'/g, "''")}'`;

/** Functions whose first argument is a `regclass`, written as a string (`nextval('s')`). */
const REGCLASS_FUNCTIONS = ["NEXTVAL", "CURRVAL", "SETVAL"];

/**
 * Interpolations that stand where Postgres wants a `regclass` literal: the
 * first argument of `nextval`, `currval` or `setval`, rendered
 * `'name'::regclass`; and an object followed by `::regclass`, rendered
 * `'name'`. By value index.
 */
function regclassPositions(tokens: readonly Token[], values: readonly unknown[]): Map<number, "call" | "cast"> {
  const out = new Map<number, "call" | "cast">();
  const sig = tokens.filter((t) => !isTrivia(t));
  sig.forEach((t, k) => {
    if (t.kind !== "ref" || !isPostgresObject(values[t.part])) return;
    const prev = sig[k - 1];
    const fn = sig[k - 2];
    const next = sig[k + 1];
    if (
      prev?.kind === "punct" && prev.text === "(" &&
      fn?.kind === "ident" && REGCLASS_FUNCTIONS.includes(fn.text.toUpperCase()) &&
      next?.kind === "punct" && (next.text === ")" || next.text === ",")
    ) {
      out.set(t.part, "call");
    } else if (next?.kind === "op" && next.text === "::" && sig[k + 2]?.kind === "ident" && sig[k + 2]!.text.toLowerCase() === "regclass") {
      out.set(t.part, "cast");
    }
  });
  return out;
}

/**
 * The output name Postgres gives a select-list item with no alias
 * (`FigureColname` in the parser): a column's name, a function's name, a
 * cast's operand's name, `case` for a CASE, else `?column?`.
 */
function outputOf(items: readonly Token[], valueOf: (t: Token) => unknown): string | undefined {
  const sig = items.filter((t) => !isTrivia(t));
  if (sig.length === 0) return undefined;
  // `x::type` names its output after `x`.
  const cast = sig.findIndex((t) => t.kind === "op" && t.text === "::");
  const head = cast > 0 ? sig.slice(0, cast) : sig;
  const name = (t: Token): string | undefined => {
    if (t.kind === "ident" || t.kind === "qident") return identValue(t);
    const v = valueOf(t);
    return isColumnRef(v) ? v.attribute : undefined;
  };
  const first = head[0]!;
  const last = head[head.length - 1]!;
  // A column, bare or qualified: `x`, `t.x`, `${t.columns.x}`, `t.${t.columns.x}`.
  if (head.length === 1 || (head.length === 3 && head[1]!.kind === "punct" && head[1]!.text === ".")) {
    const n = name(last);
    if (n !== undefined) return n;
  }
  if (first.kind === "ident" && first.text.toUpperCase() === "CASE") return "case";
  if (first.kind === "ident" && head[1]?.kind === "punct" && head[1].text === "(") return identValue(first);
  return "?column?";
}

/** Postgres as the shared template machinery reads it (`../core/interpolation.ts`). */
export const POSTGRES_TEMPLATES: TemplateDialect = {
  lexical: POSTGRES_LEXICAL,
  isObject: isPostgresObject,
  isColumnRef,
  renderReference,
  identValue: (t) => identValue(t),
  unnamedOutput: () => "?column?",
  lineage: {
    aliasWithoutAs: true,
    keyword: (t) => {
      const k = keywordCategory(t.text);
      return k === undefined ? undefined : k === "R" ? "reserved" : "keyword";
    },
    distinctOn: true,
    qualifiedRefs: true,
    outputOf,
  },
};

// ── Building ───────────────────────────────────────────────────────────

type Ctx = TemplateCtx;

export type PostgresTag =
  | "schema"
  | "table"
  | "index"
  | "view"
  | "sequence"
  | "type"
  | "domain"
  | "extension"
  | "func"
  | "procedure"
  | "aggregate"
  | "trigger"
  | "eventTrigger"
  | "operator"
  | "operatorClass"
  | "operatorFamily"
  | "foreignTable"
  | "textSearchConfiguration"
  | "textSearchDictionary"
  | "statistics"
  | "foreignDataWrapper"
  | "foreignServer"
  | "publication"
  | "collation"
  | "cast"
  | "policy"
  | "role"
  | "grant";

/** The statements each tag holds. */
export const STATEMENTS_OF: Record<PostgresTag, readonly StatementNode["statement"][]> = {
  schema: ["schema"],
  table: ["table"],
  index: ["index"],
  view: ["view"],
  sequence: ["sequence"],
  type: ["enum", "composite", "range"],
  domain: ["domain"],
  extension: ["extension"],
  func: ["function"],
  procedure: ["procedure"],
  aggregate: ["aggregate"],
  trigger: ["trigger"],
  eventTrigger: ["eventTrigger"],
  operator: ["operator"],
  operatorClass: ["operatorClass"],
  operatorFamily: ["operatorFamily"],
  foreignTable: ["foreignTable"],
  textSearchConfiguration: ["textSearchConfiguration"],
  textSearchDictionary: ["textSearchDictionary"],
  statistics: ["statistics"],
  foreignDataWrapper: ["foreignDataWrapper"],
  foreignServer: ["foreignServer"],
  publication: ["publication"],
  collation: ["collation"],
  cast: ["cast"],
  policy: ["policy"],
  role: ["role"],
  grant: ["grant"],
};

const TAG_OF: Record<StatementNode["statement"], PostgresTag | undefined> = {
  schema: "schema",
  table: "table",
  index: "index",
  view: "view",
  sequence: "sequence",
  enum: "type",
  composite: "type",
  range: "type",
  domain: "domain",
  extension: "extension",
  function: "func",
  procedure: "procedure",
  aggregate: "aggregate",
  trigger: "trigger",
  eventTrigger: "eventTrigger",
  operator: "operator",
  operatorClass: "operatorClass",
  operatorFamily: "operatorFamily",
  foreignTable: "foreignTable",
  textSearchConfiguration: "textSearchConfiguration",
  textSearchDictionary: "textSearchDictionary",
  textSearchMapping: undefined,
  statistics: "statistics",
  foreignDataWrapper: "foreignDataWrapper",
  foreignServer: "foreignServer",
  publication: "publication",
  collation: "collation",
  cast: "cast",
  policy: "policy",
  role: "role",
  grant: "grant",
  rowSecurity: undefined,
  comment: undefined,
};

/** What each statement kind is called in a message. */
export const STATEMENT_NAMES: Record<StatementNode["statement"], string> = {
  schema: "CREATE SCHEMA",
  table: "CREATE TABLE",
  index: "CREATE INDEX",
  view: "CREATE VIEW",
  sequence: "CREATE SEQUENCE",
  enum: "CREATE TYPE",
  composite: "CREATE TYPE",
  range: "CREATE TYPE",
  domain: "CREATE DOMAIN",
  extension: "CREATE EXTENSION",
  function: "CREATE FUNCTION",
  procedure: "CREATE PROCEDURE",
  aggregate: "CREATE AGGREGATE",
  trigger: "CREATE TRIGGER",
  eventTrigger: "CREATE EVENT TRIGGER",
  operator: "CREATE OPERATOR",
  operatorClass: "CREATE OPERATOR CLASS",
  operatorFamily: "CREATE OPERATOR FAMILY",
  foreignTable: "CREATE FOREIGN TABLE",
  textSearchConfiguration: "CREATE TEXT SEARCH CONFIGURATION",
  textSearchDictionary: "CREATE TEXT SEARCH DICTIONARY",
  textSearchMapping: "ALTER TEXT SEARCH CONFIGURATION",
  statistics: "CREATE STATISTICS",
  foreignDataWrapper: "CREATE FOREIGN DATA WRAPPER",
  foreignServer: "CREATE SERVER",
  publication: "CREATE PUBLICATION",
  collation: "CREATE COLLATION",
  cast: "CREATE CAST",
  policy: "CREATE POLICY",
  role: "CREATE ROLE",
  grant: "GRANT",
  rowSecurity: "ALTER TABLE",
  comment: "COMMENT ON",
};

/** Props without their unset fields and empty optional lists, so props hold only what the DDL says. */
const strip = <T extends object>(o: T, keep: readonly string[] = []): T =>
  Object.fromEntries(
    Object.entries(stripUnset(o)).filter(([k, v]) => keep.includes(k) || !(Array.isArray(v) && v.length === 0)),
  ) as T;

const req = (s: string | undefined): string => s ?? "";

/** A string constant's value: `'...'`, `E'...'`, `$tag$...$tag$`. */
export function stringValue(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  let m = /^'(.*)'$/s.exec(s);
  if (m) return m[1]!.replace(/''/g, "'");
  m = /^[Ee]'(.*)'$/s.exec(s);
  if (m) return m[1]!.replace(/''/g, "'").replace(/\\(.)/gs, (_, c: string) => ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" })[c] ?? c);
  m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$(.*)\$\1\$$/s.exec(s);
  if (m) return m[2];
  return s;
}

/** A definition list's values, by option name: each value as written, interpolations rendered; an option with no value is `true`. */
function definitionValues(ctx: Ctx, elems: readonly DefElem[], path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of elems) out[e.name] = e.value ? req(text(ctx, e.value, path)) : "true";
  return out;
}

/** A database-wide object's name (a wrapper, a server, a publication): one piece, or an interpolated object's name. */
function databaseObjectName(ctx: Ctx, n: NameNode): string {
  feed(ctx, n.span, "name");
  return n.pieces[0] || identValue(req(text(ctx, n.span)));
}

/** An `OPTIONS (...)` list's values by option name, each a string constant's value. */
function genericOptionValues(tag: PostgresTag, ctx: Ctx, options: readonly GenericOption[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of options) {
    if (isSecretOption(o.name)) {
      throw new SqlTemplateError(tag, `the option ${o.name} holds a credential, which the environment supplies (a user mapping, or its secret store); a declaration never carries one`, 0, 0);
    }
    out[o.name] = req(stringValue(text(ctx, o.value, "options")));
  }
  return out;
}

/** A qualified name's schema and name. An interpolated schema names the schema; an interpolated object gives both. */
function qualified(ctx: Ctx, n: NameNode): { schema?: string; name: string } {
  const pieces: string[] = [];
  const splices: Array<number | undefined> = [];
  for (const t of ctx.tokens.slice(n.span.from, n.span.to)) {
    if (isTrivia(t) || (t.kind === "punct" && t.text === ".")) continue;
    if (t.kind === "ref") {
      const v = ctx.values[t.part];
      if (isPostgresObject(v)) {
        const p = v.props as { schema?: string; name: string };
        if (v.entityType !== POSTGRES_ENTITY_TYPES.schema && v.entityType !== POSTGRES_ENTITY_TYPES.extension && p.schema) {
          pieces.push(p.schema);
          splices.push(undefined);
        }
        pieces.push(p.name);
        splices.push(undefined);
      } else {
        pieces.push(renderReference(v));
        splices.push(undefined);
      }
    } else {
      pieces.push(identValue(t));
      splices.push(t.splice);
    }
  }
  const last = pieces.length - 1;
  splices.forEach((splice, i) => {
    if (splice !== undefined) ctx.fed[splice]!.add(i === last ? "name" : "schema");
  });
  return pieces.length >= 2 ? { schema: pieces[pieces.length - 2], name: pieces[pieces.length - 1]! } : { name: pieces[0] ?? "" };
}

const sqlNameOf = (q: { schema?: string; name: string }): string => (q.schema ? `${quoteIdent(q.schema)}.${quoteIdent(q.name)}` : quoteIdent(q.name));

/** The object a name refers to: the entity when the whole name is one interpolation, else its SQL name. */
function target(ctx: Ctx, n: NameNode): PostgresObject | string {
  const sig = ctx.tokens.slice(n.span.from, n.span.to).filter((t) => !isTrivia(t));
  if (sig.length === 1 && sig[0]!.kind === "ref") {
    const v = ctx.values[sig[0]!.part];
    if (isPostgresObject(v)) return v;
  }
  return sqlNameOf(qualified(ctx, n));
}

/** The SQL name of what a name refers to. */
const targetName = (ctx: Ctx, n: NameNode): string => {
  const t = target(ctx, n);
  return typeof t === "string" ? t : t.sqlName;
};

/** The name of a column in a key or reference list; an interpolated column reference gives its attribute. */
function columnName(ctx: Ctx, c: { name: string; span: Span }): string {
  if (c.name) return c.name;
  const t = ctx.tokens[c.span.from];
  const v = t?.kind === "ref" ? ctx.values[t.part] : undefined;
  return isColumnRef(v) ? v.attribute : req(text(ctx, c.span));
}

function columnDef(ctx: Ctx, c: ColumnNode, tag: PostgresTag = "table"): ColumnDef {
  for (const span of [c.nameSpan, c.type, c.default, c.collate, c.compression, c.storage, c.generated?.expr, c.generated?.options]) feed(ctx, span, "columns");
  const def: ColumnDef = { name: columnName(ctx, { name: c.name, span: c.nameSpan }) };
  const set = <K extends keyof ColumnDef>(k: K, v: ColumnDef[K] | undefined) => {
    if (v !== undefined) def[k] = v;
  };
  set("type", text(ctx, c.type));
  set("notNull", c.notNull);
  set("notNullName", c.notNullName);
  set("default", text(ctx, c.default));
  if (c.generated) {
    def.generated = stripUnset({
      kind: c.generated.kind,
      expr: text(ctx, c.generated.expr),
      always: c.generated.always,
      options: text(ctx, c.generated.options),
    });
    // `always` false is meaningful for an identity column (BY DEFAULT).
    def.generated.always = c.generated.always;
  }
  set("collate", text(ctx, c.collate));
  set("compression", text(ctx, c.compression));
  set("storage", text(ctx, c.storage));
  if (c.options && c.options.length > 0) def.options = genericOptionValues(tag, ctx, c.options);
  return def;
}

function deferral(c: ConstraintNode): Deferral {
  return stripUnset({ deferrable: c.deferrable, initiallyDeferred: c.initiallyDeferred });
}

function keyDef(ctx: Ctx, c: ConstraintNode, columns: string[], path: string): KeyDef {
  return strip(
    {
      name: c.name,
      columns,
      nullsNotDistinct: c.nullsNotDistinct,
      include: text(ctx, c.include, path),
      with: text(ctx, c.with, path),
      ...deferral(c),
    },
    ["columns"],
  );
}

function checkDef(ctx: Ctx, c: ConstraintNode): CheckDef {
  return stripUnset({
    name: c.name,
    expr: req(text(ctx, c.expr, "checks")),
    noInherit: c.noInherit,
    notValid: c.notValid,
    notEnforced: c.notEnforced,
  });
}

function foreignKeyDef(ctx: Ctx, c: ConstraintNode, columns: string[]): ForeignKeyDef {
  const r = c.references!;
  feed(ctx, r.table.span, "foreignKeys");
  for (const x of r.columns) feed(ctx, x.span, "foreignKeys");
  return strip(
    {
      name: c.name,
      columns,
      references: target(ctx, r.table),
      refTable: targetName(ctx, r.table),
      refColumns: r.columns.map((x) => columnName(ctx, x)),
      match: r.match,
      onDelete: text(ctx, r.onDelete),
      onUpdate: text(ctx, r.onUpdate),
      notValid: c.notValid,
      notEnforced: c.notEnforced,
      ...deferral(c),
    },
    ["columns", "refColumns"],
  );
}

/**
 * The `${}` in a foreign key's referenced column list that each name one
 * column, paired with the referencing column at the same position (#3751).
 * `chant sql types` types each as a column comparing like that one.
 */
function referenceSlots(ctx: Ctx, c: ConstraintNode, columns: readonly string[]): TypedSlot[] {
  const out: TypedSlot[] = [];
  c.references!.columns.forEach((x, n) => {
    const column = columns[n];
    if (x.name || column === undefined) return;
    const sig = ctx.tokens.slice(x.span.from, x.span.to).filter((t) => !isTrivia(t));
    const t = sig[0];
    if (sig.length === 1 && t?.kind === "ref" && isColumnRef(ctx.values[t.part])) out.push({ index: t.part, kind: "references", column });
  });
  return out;
}

function exclusionDef(ctx: Ctx, c: ConstraintNode): ExclusionDef {
  return stripUnset({
    name: c.name,
    using: c.using,
    elements: req(text(ctx, c.expr, "exclusions")),
    where: text(ctx, c.where, "exclusions"),
    include: text(ctx, c.include, "exclusions"),
    with: text(ctx, c.with, "exclusions"),
    ...deferral(c),
  });
}

interface Commentable {
  comment?: string;
}

/**
 * Fold the COMMENT ON statements after the CREATE into the object they name:
 * the object itself, one of its columns, or one of its named constraints.
 * Anything else is refused, since a template declares one object.
 */
function applyComments(
  tag: PostgresTag,
  ctx: Ctx,
  comments: readonly CommentNode[],
  self: { schema?: string; name: string },
  objectTypes: readonly string[],
  parts: { columns?: Map<string, Commentable>; constraints?: Map<string, Commentable>; columnComments?: Record<string, string> } = {},
  using?: string,
): string | undefined {
  let comment: string | undefined;
  const isSelf = (q: { schema?: string; name: string }) => q.name === self.name && (q.schema === undefined || self.schema === undefined || q.schema === self.schema);
  const refuse = (c: CommentNode, why: string): never => {
    throw new SqlTemplateError(tag, `COMMENT ON ${c.objectType} ${c.target.pieces.filter(Boolean).join(".") || "${...}"} ${why}`, 0, 0);
  };
  for (const c of comments) {
    const value = c.text ? stringValue(text(ctx, c.text, "comment")) : undefined;
    if (c.objectType === "COLUMN") {
      // `table.column` or `schema.table.column`: the last piece is the column, the rest its relation.
      const all = ctx.tokens.slice(c.target.span.from, c.target.span.to).filter((t) => !isTrivia(t) && !(t.kind === "punct" && t.text === "."));
      const last = all[all.length - 1];
      const col = last === undefined ? "" : last.kind === "ref" ? columnName(ctx, { name: "", span: { from: c.target.span.to - 1, to: c.target.span.to, refs: [] } }) : identValue(last);
      if (all.length < 2) refuse(c, "needs the relation: COMMENT ON COLUMN table.column");
      const owner = qualified(ctx, { pieces: c.target.pieces.slice(0, -1), span: { from: c.target.span.from, to: lastDot(ctx, c.target.span), refs: c.target.span.refs } });
      if (!isSelf(owner)) refuse(c, `is not a column of ${sqlNameOf(self)}`);
      if (parts.columnComments) {
        if (value !== undefined) parts.columnComments[col] = value;
        continue;
      }
      const column = parts.columns?.get(col);
      if (!column) refuse(c, `names no column of ${sqlNameOf(self)}`);
      if (value !== undefined) column!.comment = value;
      else delete column!.comment;
    } else if (c.objectType === "CONSTRAINT") {
      if (!c.on || !isSelf(qualified(ctx, c.on))) refuse(c, `is not on ${sqlNameOf(self)}`);
      const name = qualified(ctx, c.target).name;
      const constraint = parts.constraints?.get(name);
      if (!constraint) refuse(c, `names no constraint of ${sqlNameOf(self)}; a constraint commented on needs CONSTRAINT ${name} in the definition`);
      if (value !== undefined) constraint!.comment = value;
    } else {
      if (!objectTypes.includes(c.objectType)) refuse(c, `does not comment on the ${tag} this template declares`);
      if (c.objectType === "CAST") {
        // `COMMENT ON CAST (source AS target)`: the two types, as the CREATE CAST writes them.
        const loose = (x: string) => x.toLowerCase().replace(/\s+/g, " ").replace(/\s*([(),.])\s*/g, "$1");
        const named = `(${req(text(ctx, c.cast!.source))} AS ${req(text(ctx, c.cast!.target))})`;
        if (loose(named) !== loose(self.name)) refuse(c, `names another cast than ${self.name}`);
      } else if (c.objectType === "TRIGGER" || c.objectType === "POLICY") {
        // `COMMENT ON TRIGGER name ON table`: the name is the trigger's, the table its own.
        if (qualified(ctx, c.target).name !== self.name || !c.on || !isSelf({ ...qualified(ctx, c.on), name: self.name })) refuse(c, `names another ${c.objectType.toLowerCase()} than ${self.name}`);
      } else if (!isSelf(qualified(ctx, c.target))) refuse(c, `names another object than ${sqlNameOf(self)}`);
      // An operator class or family is named by its index method too.
      if (using !== undefined && c.using !== using) refuse(c, `names another index method than ${using}`);
      comment = value;
    }
  }
  return comment;
}

/** The token index of the last `.` in a span, so `a.b.c` without its last piece is `a.b`. */
function lastDot(ctx: Ctx, span: Span): number {
  for (let i = span.to - 1; i >= span.from; i--) {
    const t = ctx.tokens[i]!;
    if (t.kind === "punct" && t.text === ".") return i;
  }
  return span.from;
}

/**
 * The first statement after the CREATE that its template may not hold: a
 * template is one object, then COMMENT ON statements for it; a table's may
 * also turn row-level security on or off (`ALTER TABLE ... ENABLE ROW LEVEL
 * SECURITY`), as `pg_dump` prints it. A grant is one statement.
 */
export function followOnStray(tag: PostgresTag, rest: readonly StatementNode[]): StatementNode | undefined {
  if (tag === "grant") return rest[0];
  return rest.find((n) => n.statement !== "comment" && !(tag === "table" && n.statement === "rowSecurity") && !(tag === "textSearchConfiguration" && n.statement === "textSearchMapping"));
}

/**
 * The interpolations that sit inside a string constant (a routine's
 * `AS $$ ... $$` body), rendered into the text around them: a string
 * constant is one token, so the template is joined there before it is
 * tokenized. Returns the joined parts and values, the original index of each
 * value kept, and the objects the inlined interpolations name.
 */
function inlineQuoted(parts: readonly string[], values: readonly unknown[]): { parts: string[]; values: unknown[]; original: number[]; inlined: number[]; refs: unknown[] } {
  // The lexical state at the end of each part: inside a '...' string, a $tag$ string, or neither.
  type State = { kind: "none" } | { kind: "single"; escapes: boolean } | { kind: "dollar"; tag: string } | { kind: "dquote" } | { kind: "line" } | { kind: "block"; depth: number };
  let state: State = { kind: "none" };
  const insideAt: Array<"single" | "dollar" | undefined> = [];
  parts.forEach((src, part) => {
    for (let i = 0; i < src.length; i++) {
      const c = src[i]!;
      const rest = src.slice(i);
      switch (state.kind) {
        case "none": {
          if (c === "'") state = { kind: "single", escapes: /[Ee]$/.test(src.slice(0, i)) && !/[A-Za-z0-9_$][Ee]$/.test(src.slice(0, i)) };
          else if (c === '"') state = { kind: "dquote" };
          else if (rest.startsWith("--")) state = { kind: "line" };
          else if (rest.startsWith("/*")) {
            state = { kind: "block", depth: 1 };
            i++;
          } else if (c === "$" && !/[A-Za-z0-9_$]$/.test(src.slice(0, i))) {
            const m = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(rest);
            if (m) {
              state = { kind: "dollar", tag: m[0] };
              i += m[0].length - 1;
            }
          }
          break;
        }
        case "single":
          if (state.escapes && c === "\\") i++;
          else if (c === "'") {
            if (src[i + 1] === "'") i++;
            else state = { kind: "none" };
          }
          break;
        case "dquote":
          if (c === '"') {
            if (src[i + 1] === '"') i++;
            else state = { kind: "none" };
          }
          break;
        case "dollar":
          if (rest.startsWith(state.tag)) {
            i += state.tag.length - 1;
            state = { kind: "none" };
          }
          break;
        case "line":
          if (c === "\n") state = { kind: "none" };
          break;
        case "block":
          if (rest.startsWith("/*")) {
            state.depth++;
            i++;
          } else if (rest.startsWith("*/")) {
            i++;
            state = state.depth === 1 ? { kind: "none" } : { kind: "block", depth: state.depth - 1 };
          }
          break;
      }
    }
    if (part < parts.length - 1) insideAt.push(state.kind === "single" ? "single" : state.kind === "dollar" ? "dollar" : undefined);
  });
  if (!insideAt.some(Boolean)) return { parts: [...parts], values: [...values], original: values.map((_, i) => i), inlined: [], refs: [] };
  const out: string[] = [parts[0]!];
  const outValues: unknown[] = [];
  const original: number[] = [];
  const inlined: number[] = [];
  const refs: unknown[] = [];
  values.forEach((v, i) => {
    if (!insideAt[i]) {
      outValues.push(v);
      original.push(i);
      out.push(parts[i + 1]!);
      return;
    }
    let text: string;
    if (isPostgresObject(v) || isColumnRef(v)) {
      text = renderReference(v);
      refs.push(v);
    } else if (v instanceof SqlLiteral) text = v.sql;
    else if (v === null) text = "NULL";
    else if (typeof v === "string" || typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") text = String(v);
    else throw new SqlTemplateError("func", `the interpolation inside the body is ${describe(v)}; a body takes an object, a column reference, a string or a number`, i, parts[i]!.length);
    // Inside a '...' string a quote is doubled.
    out[out.length - 1] += (insideAt[i] === "single" ? text.replace(/'/g, "''") : text) + parts[i + 1]!;
    inlined.push(i);
  });
  return { parts: out, values: outValues, original, inlined, refs };
}

/** A role named where one is granted to: an interpolated role entity gives its name. */
function roleName(ctx: Ctx, r: { name: string; span: Span }): string {
  if (r.name) return r.name;
  const t = ctx.tokens[r.span.from];
  const v = t?.kind === "ref" ? ctx.values[t.part] : undefined;
  if (isPostgresObject(v)) return (v.props as { name: string }).name;
  return identValue(req(text(ctx, r.span)));
}

/** A GRANT's, REVOKE's or ALTER DEFAULT PRIVILEGES's props. */
function grantProps(ctx: Ctx, node: GrantNode, ddl: string, source: { strings: string[] }): GrantProps | DefaultPrivilegesProps {
  const action = node.revoke ? "revoke" : "grant";
  const grantees = node.grantees.map((g) => roleName(ctx, g));
  if (node.defaults) {
    if (node.privileges.some((p) => p.columns.length > 0)) throw new SqlTemplateError("grant", "default privileges are on whole objects; a column list is for a grant on one table", 0, 0);
    const on = (node.on === "ROUTINES" ? "functions" : node.on.toLowerCase()) as DefaultPrivilegesProps["on"];
    const forRoles = node.forRoles?.map((r) => roleName(ctx, r));
    const inSchemas = node.inSchemas?.map((s) => columnName(ctx, s));
    if (on === "schemas" && inSchemas) throw new SqlTemplateError("grant", "default privileges on schemas cannot be limited to a schema (IN SCHEMA)", 0, 0);
    const privileges = node.privileges.map((p) => p.privilege.toLowerCase());
    return stripUnset({
      name: `default privileges ${action === "grant" ? "grant" : "revoke"} ${privileges.join(", ")} on ${on}${inSchemas ? ` in ${inSchemas.join(", ")}` : ""}${forRoles ? ` for ${forRoles.join(", ")}` : ""} ${action === "grant" ? "to" : "from"} ${grantees.join(", ")}`,
      action,
      grantOptionFor: node.grantOptionFor || undefined,
      forRoles,
      inSchemas,
      privileges,
      on,
      grantees,
      withGrantOption: node.withGrantOption || undefined,
      ddl,
      source,
    }) as DefaultPrivilegesProps;
  }
  const on = (node.on === "TABLE" ? "table" : node.on.toLowerCase()) as GrantProps["on"];
  const routine = on === "function" || on === "procedure" || on === "routine";
  const objects: Array<PostgresObject | string> = [];
  const objectNames: string[] = [];
  for (const o of node.objects) {
    const t = target(ctx, o.name);
    objects.push(t);
    let sqlName = typeof t === "string" ? t : on === "schema" ? (t.props as { name: string }).name : t.sqlName;
    if (routine) {
      if (o.args) sqlName += `(${req(text(ctx, o.args, "objects")) ?? ""})`;
      else if (typeof t !== "string" && (t.entityType === POSTGRES_ENTITY_TYPES.function || t.entityType === POSTGRES_ENTITY_TYPES.procedure)) {
        // An interpolated routine is named by its own parameter types.
        sqlName += `(${routineArgTypes(t.props as RoutineProps)})`;
      } else throw new SqlTemplateError("grant", `${sqlName}: name the parameter types (${sqlName}(...)), or interpolate the routine, since overloads share a name`, 0, 0);
    }
    objectNames.push(sqlName);
  }
  const privileges = node.privileges.map((p) => stripUnset({ privilege: p.privilege.toLowerCase(), columns: p.columns.length > 0 ? p.columns.map((c) => columnName(ctx, c)) : undefined }) as PrivilegeDef);
  if (on !== "table" && privileges.some((p) => p.columns)) throw new SqlTemplateError("grant", "a column list is for privileges on a table", 0, 0);
  const verb = action === "grant" ? "to" : "from";
  return stripUnset({
    name: `${action} ${privileges.map((p) => `${p.privilege}${p.columns ? `(${p.columns.join(", ")})` : ""}`).join(", ")} on ${on} ${objectNames.join(", ")} ${verb} ${grantees.join(", ")}`,
    action,
    grantOptionFor: node.grantOptionFor || undefined,
    privileges,
    on,
    objects,
    objectNames,
    grantees,
    withGrantOption: node.withGrantOption || undefined,
    ddl,
    source,
  }) as GrantProps;
}

/** A routine's parameter types, as `GRANT ... ON FUNCTION f(...)` names it: the `OUT` ones left out. */
const routineArgTypes = (props: RoutineProps): string => props.args.filter((a) => a.mode !== "out").map((a) => a.type).join(", ");

/** The interpolated functions and procedures not followed by their own `(...)`: the ones a grant's statement writes with the parameter types (#3707). */
function bareRoutineSplices(tokens: readonly Token[], values: readonly unknown[]): Set<number> {
  const out = new Set<number>();
  tokens.forEach((t, k) => {
    if (t.kind !== "ref") return;
    const v = values[t.part];
    if (!isPostgresObject(v) || (v.entityType !== POSTGRES_ENTITY_TYPES.function && v.entityType !== POSTGRES_ENTITY_TYPES.procedure)) return;
    const next = tokens.slice(k + 1).find((x) => !isTrivia(x));
    if (!(next?.kind === "punct" && next.text === "(")) out.add(t.part);
  });
  return out;
}

function build(tag: PostgresTag, strings: TemplateStringsArray | readonly string[], rawValues: readonly unknown[]): PostgresObject {
  const rawParts = templateParts(strings);
  const routine = tag === "func" || tag === "procedure";
  const joined = routine ? inlineQuoted(rawParts, rawValues) : undefined;
  const parts = joined ? joined.parts : rawParts;
  const values = joined ? joined.values : rawValues;
  const tokens = spliceWith(POSTGRES_TEMPLATES, tag, parts, values);
  let nodes: StatementNode[];
  try {
    nodes = parseStatements(tokens);
  } catch (err) {
    if (!(err instanceof SqlSyntaxError)) throw err;
    throw templateSyntaxError(tag, parts, err);
  }
  const [node, ...rest] = nodes as [StatementNode, ...StatementNode[]];
  if (!STATEMENTS_OF[tag].includes(node.statement)) {
    const holds = STATEMENT_NAMES[node.statement];
    const use = TAG_OF[node.statement];
    throw new SqlTemplateError(
      tag,
      use
        ? `holds a ${holds}; use the ${use} tag`
        : node.statement === "rowSecurity"
          ? "holds an ALTER TABLE ... ROW LEVEL SECURITY before any CREATE; it goes after the table's CREATE TABLE, in the table's template"
          : `holds a ${holds} before any CREATE; a COMMENT ON goes after the CREATE it comments on`,
      0,
      0,
    );
  }
  const stray = followOnStray(tag, rest);
  if (stray) {
    throw new SqlTemplateError(
      tag,
      `holds a second statement (${STATEMENT_NAMES[stray.statement]}); a template declares one object, followed only by COMMENT ON statements for it${tag === "table" ? " and ALTER TABLE ... ROW LEVEL SECURITY" : tag === "textSearchConfiguration" ? " and ALTER TEXT SEARCH CONFIGURATION ... ADD MAPPING" : ""}`,
      0,
      0,
    );
  }
  const comments = rest.filter((n): n is CommentNode => n.statement === "comment");
  const rowSecurity = rest.filter((n): n is RowSecurityNode => n.statement === "rowSecurity");

  const positions = regclassPositions(tokens, values);
  const bareRoutines = tag === "grant" ? bareRoutineSplices(tokens, values) : new Set<number>();
  const render = (v: unknown, i?: number): string => {
    const at = i === undefined ? undefined : positions.get(i);
    if (at && isPostgresObject(v)) return at === "call" ? `${regclassText(v.sqlName)}::regclass` : regclassText(v.sqlName);
    // #3707: a routine a grant interpolates is written with its parameter types, so the statement names it on its own.
    if (i !== undefined && bareRoutines.has(i) && isPostgresObject(v)) return `${renderReference(v)}(${routineArgTypes(v.props as RoutineProps)})`;
    return renderReference(v);
  };
  const ctx: Ctx = { d: { ...POSTGRES_TEMPLATES, renderReference: render }, tokens, values, fed: values.map(() => new Set<string>()) };
  for (const t of tokens) if (t.splice !== undefined) ctx.fed[t.splice]!.add("ddl");
  const ddl = untokenize(tokens, (i) => render(values[i], i)).trim().replace(/;\s*$/, "");
  const source = { strings: rawParts };
  const dependsOn = [...new Set([...values, ...(joined?.refs ?? [])].filter((v) => isPostgresObject(v) || isColumnRef(v)))];
  const slots: TypedSlot[] = [];
  const unparsed = unparsedClauses(ctx, nodes.flatMap((n) => ("unknown" in n && n.unknown ? n.unknown : [])));
  const make = <T extends PostgresObject>(type: PostgresEntityType, q: { schema?: string; name: string }, props: object, columnNames?: readonly string[], sqlName = sqlNameOf(q)): T => {
    if (unparsed) (props as { unparsed?: UnparsedClause[] }).unparsed = unparsed;
    const entity = makeSqlEntity(PostgresObject.prototype as PostgresObject, type, sqlName, props, columnNames, dependsOn) as T;
    const fed = ctx.fed.map((paths) => [...paths].sort());
    if (!joined) setInterpolationFields(entity, fed);
    else {
      // Back to the template's own interpolations: one inlined into the body feeds the body.
      const byOriginal: string[][] = rawValues.map(() => ["body", "ddl"]);
      joined.original.forEach((orig, i) => (byOriginal[orig] = fed[i]!));
      setInterpolationFields(entity, byOriginal);
    }
    setTypedSlots(entity, slots);
    return entity;
  };

  switch (node.statement) {
    case "schema": {
      const q = node.name ? qualified(ctx, node.name) : { name: identValue(req(text(ctx, node.authorization))) };
      if (q.schema !== undefined) throw new SqlTemplateError(tag, `a schema name is not qualified (${sqlNameOf(q)})`, 0, 0);
      const comment = applyComments(tag, ctx, comments, q, ["SCHEMA"]);
      const props: SchemaProps = stripUnset({ name: q.name, ifNotExists: node.ifNotExists, authorization: text(ctx, node.authorization, "authorization"), comment, ddl, source });
      return make(POSTGRES_ENTITY_TYPES.schema, q, props);
    }
    case "extension": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, { name: q.name }, ["EXTENSION"]);
      const schemaRef = node.schema ? text(ctx, node.schema, "schema") : undefined;
      const props: ExtensionProps = stripUnset({
        name: q.name,
        schema: schemaRef === undefined ? undefined : identValue(schemaRef),
        version: stringValue(text(ctx, node.version, "version")),
        cascade: node.cascade,
        ifNotExists: node.ifNotExists,
        comment,
        ddl,
        source,
      });
      return make(POSTGRES_ENTITY_TYPES.extension, { name: q.name }, props);
    }
    case "enum": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q, ["TYPE"]);
      const props: EnumProps = stripUnset({ ...q, labels: node.labels.map((l) => req(stringValue(text(ctx, l, "labels")))), comment, ddl, source });
      return make(POSTGRES_ENTITY_TYPES.enum, q, props);
    }
    case "composite": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q, ["TYPE"]);
      const attributes = node.attributes.map((a) => {
        feed(ctx, a.nameSpan, "attributes");
        return stripUnset({ name: columnName(ctx, { name: a.name, span: a.nameSpan }), type: req(text(ctx, a.type, "attributes")), collate: text(ctx, a.collate, "attributes") }) as CompositeAttributeDef;
      });
      const props: CompositeTypeProps = strip({ ...q, attributes, comment, ddl, source }, ["attributes"]);
      return make(POSTGRES_ENTITY_TYPES.composite, q, props);
    }
    case "range": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q, ["TYPE"]);
      const opt = definitionValues(ctx, node.options, "options");
      const props: RangeTypeProps = stripUnset({
        ...q,
        subtype: req(opt.subtype),
        subtypeOpclass: opt.subtype_opclass,
        collation: opt.collation,
        canonical: opt.canonical,
        subtypeDiff: opt.subtype_diff,
        multirangeTypeName: opt.multirange_type_name,
        comment,
        ddl,
        source,
      });
      return make(POSTGRES_ENTITY_TYPES.range, q, props);
    }
    case "aggregate": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q, ["AGGREGATE"]);
      const arg = (a: (typeof node.args)[number]): AggregateArgDef => stripUnset({ mode: (a.mode?.toLowerCase() ?? "in") as AggregateArgDef["mode"], name: a.name, type: req(text(ctx, a.type, "args")) });
      const props: AggregateProps = strip(
        {
          ...q,
          orReplace: node.orReplace || undefined,
          args: node.args.map(arg),
          orderBy: node.orderBy?.map(arg),
          options: definitionValues(ctx, node.options, "options"),
          comment,
          ddl,
          source,
        },
        ["args"],
      );
      return make(POSTGRES_ENTITY_TYPES.aggregate, q, props);
    }
    case "collation": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q, ["COLLATION"]);
      const props: CollationProps = stripUnset({ ...q, ifNotExists: node.ifNotExists || undefined, options: definitionValues(ctx, node.options, "options"), comment, ddl, source });
      return make(POSTGRES_ENTITY_TYPES.collation, q, props);
    }
    case "cast": {
      const sourceType = req(text(ctx, node.source, "sourceType"));
      const targetType = req(text(ctx, node.target, "targetType"));
      const name = `(${sourceType} AS ${targetType})`;
      const comment = applyComments(tag, ctx, comments, { name }, ["CAST"]);
      const props: CastProps = stripUnset({
        name,
        sourceType,
        targetType,
        method: node.method,
        function: node.function ? target(ctx, node.function) : undefined,
        functionName: node.function ? targetName(ctx, node.function) : undefined,
        functionArgs: node.functionArgs ? text(ctx, node.functionArgs, "functionArgs") : undefined,
        context: node.context,
        comment,
        ddl,
        source,
      });
      return make(POSTGRES_ENTITY_TYPES.cast, { name }, props, undefined, name);
    }
    case "eventTrigger": {
      const name = node.name.pieces[0] || identValue(req(text(ctx, node.name.span)));
      feed(ctx, node.name.span, "name");
      const comment = applyComments(tag, ctx, comments, { name }, ["EVENT TRIGGER"]);
      const tags = node.filters.flatMap((f) => f.values.map((v) => req(stringValue(text(ctx, v, "tags")))));
      const props: EventTriggerProps = strip(
        {
          name,
          event: node.event.name || identValue(req(text(ctx, node.event.span, "event"))),
          tags: tags.length > 0 ? tags : undefined,
          function: target(ctx, node.function),
          functionName: targetName(ctx, node.function),
          comment,
          ddl,
          source,
        },
        [],
      );
      return make(POSTGRES_ENTITY_TYPES.eventTrigger, { name }, props);
    }
    case "operator": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q, ["OPERATOR"]);
      const opt = definitionValues(ctx, node.options, "options");
      const { leftarg, rightarg, procedure, ...rest } = opt;
      const props: OperatorProps = stripUnset({ ...q, leftArg: leftarg, rightArg: rightarg, options: { ...rest, function: opt.function ?? procedure }, comment, ddl, source });
      // The symbol is unquoted wherever the operator is named: `app.===`.
      return make(POSTGRES_ENTITY_TYPES.operator, q, props, undefined, q.schema ? `${quoteIdent(q.schema)}.${q.name}` : q.name);
    }
    case "operatorClass": {
      const q = qualified(ctx, node.name);
      if (node.method === "") throw new SqlTemplateError(tag, "the index method is written out, not interpolated", 0, 0);
      const comment = applyComments(tag, ctx, comments, q, ["OPERATOR CLASS"], {}, node.method);
      const items = node.items.map((i): OperatorClassItemDef => {
        if (i.kind === "storage") return { kind: "storage", type: req(text(ctx, i.type, "items")) };
        if (i.kind === "function") {
          feed(ctx, i.function.span, "items");
          return stripUnset({ kind: "function", number: req(text(ctx, i.number, "items")), types: text(ctx, i.types, "items"), function: targetName(ctx, i.function), args: text(ctx, i.args, "items") ?? "" }) as OperatorClassItemDef;
        }
        return stripUnset({
          kind: "operator",
          number: req(text(ctx, i.number, "items")),
          operator: req(text(ctx, i.operator.span, "items")),
          types: text(ctx, i.types, "items"),
          orderBy: i.orderBy ? targetName(ctx, i.orderBy) : undefined,
        }) as OperatorClassItemDef;
      });
      const props: OperatorClassProps = stripUnset({
        ...q,
        default: node.default || undefined,
        dataType: req(text(ctx, node.type, "dataType")),
        method: node.method,
        family: node.family ? targetName(ctx, node.family) : undefined,
        items,
        comment,
        ddl,
        source,
      });
      return make(POSTGRES_ENTITY_TYPES.operatorClass, q, props);
    }
    case "operatorFamily": {
      const q = qualified(ctx, node.name);
      if (node.method === "") throw new SqlTemplateError(tag, "the index method is written out, not interpolated", 0, 0);
      const comment = applyComments(tag, ctx, comments, q, ["OPERATOR FAMILY"], {}, node.method);
      const props: OperatorFamilyProps = stripUnset({ ...q, method: node.method, comment, ddl, source });
      return make(POSTGRES_ENTITY_TYPES.operatorFamily, q, props);
    }
    case "foreignTable": {
      const q = qualified(ctx, node.name);
      const columns = node.columns.map((c) => columnDef(ctx, c, tag));
      const checks: CheckDef[] = [];
      const file = (c: ConstraintNode, cols: string[]) => {
        if (c.kind === "CHECK") checks.push(checkDef(ctx, c));
        else if (c.kind === "NOT NULL") {
          const col = columns.find((x) => x.name === cols[0]);
          if (!col) throw new SqlTemplateError(tag, `NOT NULL ${cols[0]} names no column of ${sqlNameOf(q)}`, 0, 0);
          col.notNull = true;
          if (c.name) col.notNullName = c.name;
        }
      };
      node.columns.forEach((c, i) => c.constraints.forEach((k) => file(k, [columns[i]!.name])));
      node.constraints.forEach((k) => file(k, k.columns.map((x) => columnName(ctx, x))));
      const named = new Map<string, Commentable>();
      for (const c of checks) if (c.name) named.set(c.name, c);
      const comment = applyComments(tag, ctx, comments, q, ["FOREIGN TABLE"], { columns: new Map(columns.map((c) => [c.name, c])), constraints: named });
      const props: ForeignTableProps = strip(
        {
          ...q,
          ifNotExists: node.ifNotExists || undefined,
          columns,
          checks,
          serverName: databaseObjectName(ctx, node.server),
          options: genericOptionValues(tag, ctx, node.options),
          comment,
          ddl,
          source,
        },
        ["columns", "checks", "options"],
      );
      return make(POSTGRES_ENTITY_TYPES.foreignTable, q, props, columns.map((c) => c.name));
    }
    case "textSearchDictionary": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q, ["TEXT SEARCH DICTIONARY"]);
      const { template, ...options } = definitionValues(ctx, node.options, "options");
      const props: TextSearchDictionaryProps = strip({ ...q, template: req(template), options, comment, ddl, source }, ["options"]);
      return make(POSTGRES_ENTITY_TYPES.textSearchDictionary, q, props);
    }
    case "textSearchConfiguration": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q, ["TEXT SEARCH CONFIGURATION"]);
      const opt = definitionValues(ctx, node.options, "options");
      const seen = new Set<string>();
      const mappings = rest
        .filter((n): n is TextSearchMappingNode => n.statement === "textSearchMapping")
        .map((m): TextSearchMappingDef => {
          feed(ctx, m.name.span, "mappings");
          const t = qualified(ctx, m.name);
          if (t.name !== q.name || (t.schema !== undefined && q.schema !== undefined && t.schema !== q.schema)) {
            throw new SqlTemplateError(tag, `ADD MAPPING names another configuration (${sqlNameOf(t)}) than ${sqlNameOf(q)}`, 0, 0);
          }
          const tokens = m.tokens.map((x) => x.name || identValue(req(text(ctx, x.span, "mappings"))));
          for (const tok of tokens) {
            if (seen.has(tok)) throw new SqlTemplateError(tag, `the token type ${tok} is mapped twice in ${sqlNameOf(q)}`, 0, 0);
            seen.add(tok);
          }
          for (const d of m.dictionaries) feed(ctx, d.span, "mappings");
          return { tokens, dictionaries: m.dictionaries.map((d) => sqlNameOf(qualified(ctx, d))) };
        });
      const props: TextSearchConfigurationProps = strip({ ...q, parser: req(opt.parser), mappings, comment, ddl, source }, ["mappings"]);
      return make(POSTGRES_ENTITY_TYPES.textSearchConfiguration, q, props);
    }
    case "textSearchMapping":
      // Only a configuration's follow-on statement (`followOnStray`); first in a template it is refused above.
      throw new SqlTemplateError(tag, "holds an ALTER TEXT SEARCH CONFIGURATION before any CREATE", 0, 0);
    case "statistics": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q, ["STATISTICS"]);
      const props: StatisticsProps = strip(
        {
          ...q,
          ifNotExists: node.ifNotExists || undefined,
          kinds: node.kinds.length > 0 ? node.kinds : undefined,
          targets: node.targets.map((t) => req(text(ctx, t, "targets"))),
          table: target(ctx, node.table),
          tableName: sqlNameOf(qualified(ctx, node.table)),
          comment,
          ddl,
          source,
        },
        ["targets"],
      );
      return make(POSTGRES_ENTITY_TYPES.statistics, q, props);
    }
    case "foreignDataWrapper": {
      const name = databaseObjectName(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, { name }, ["FOREIGN DATA WRAPPER"]);
      const props: ForeignDataWrapperProps = strip(
        {
          name,
          handler: node.handler ? target(ctx, node.handler) : undefined,
          handlerName: node.handler ? targetName(ctx, node.handler) : undefined,
          noHandler: node.handler === null ? true : undefined,
          validator: node.validator ? target(ctx, node.validator) : undefined,
          validatorName: node.validator ? targetName(ctx, node.validator) : undefined,
          noValidator: node.validator === null ? true : undefined,
          options: genericOptionValues(tag, ctx, node.options),
          comment,
          ddl,
          source,
        },
        ["options"],
      );
      return make(POSTGRES_ENTITY_TYPES.foreignDataWrapper, { name }, props);
    }
    case "foreignServer": {
      const name = databaseObjectName(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, { name }, ["SERVER"]);
      const props: ForeignServerProps = strip(
        {
          name,
          ifNotExists: node.ifNotExists || undefined,
          serverType: node.type ? stringValue(text(ctx, node.type, "serverType")) : undefined,
          version: node.version ? stringValue(text(ctx, node.version, "version")) : undefined,
          wrapper: target(ctx, node.wrapper),
          wrapperName: targetName(ctx, node.wrapper),
          options: genericOptionValues(tag, ctx, node.options),
          comment,
          ddl,
          source,
        },
        ["options"],
      );
      return make(POSTGRES_ENTITY_TYPES.foreignServer, { name }, props);
    }
    case "publication": {
      const name = databaseObjectName(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, { name }, ["PUBLICATION"]);
      const tables = node.items.flatMap((i) =>
        i.kind !== "table"
          ? []
          : [
              stripUnset({
                table: target(ctx, i.table),
                tableName: sqlNameOf(qualified(ctx, i.table)),
                columns: i.columns?.map((c) => columnName(ctx, { name: c.name, span: c.span })),
                where: text(ctx, i.where, "tables"),
              }) as PublicationTableDef,
            ],
      );
      const schemas = node.items.flatMap((i) => (i.kind === "schema" ? [qualified(ctx, i.schema).name] : []));
      const props: PublicationProps = strip(
        { name, allTables: node.allTables || undefined, tables, schemas, options: definitionValues(ctx, node.options, "options"), comment, ddl, source },
        ["tables", "schemas", "options"],
      );
      return make(POSTGRES_ENTITY_TYPES.publication, { name }, props);
    }
    case "domain": {
      const q = qualified(ctx, node.name);
      const checks = node.checks.map((c) => stripUnset({ name: c.name, expr: req(text(ctx, c.expr, "checks")), notValid: c.notValid }) as CheckDef);
      const constraints = new Map<string, Commentable>(checks.filter((c) => c.name !== undefined).map((c) => [c.name!, c]));
      const comment = applyComments(tag, ctx, comments.map((c) => (c.objectType === "DOMAIN CONSTRAINT" ? { ...c, objectType: "CONSTRAINT" } : c)), q, ["DOMAIN", "TYPE"], { constraints });
      const props: DomainProps = strip(
        {
          ...q,
          dataType: req(text(ctx, node.type, "dataType")),
          collate: text(ctx, node.collate, "collate"),
          default: text(ctx, node.default, "default"),
          notNull: node.notNull,
          checks,
          comment,
          ddl,
          source,
        },
        ["checks"],
      );
      return make(POSTGRES_ENTITY_TYPES.domain, q, props);
    }
    case "sequence": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q, ["SEQUENCE"]);
      const opt: Partial<SequenceProps> = {};
      for (const o of node.options) {
        const v = text(ctx, o.value, "options");
        switch (o.option) {
          case "AS":
            opt.dataType = v;
            break;
          case "INCREMENT":
            opt.increment = v;
            break;
          case "MINVALUE":
            opt.minValue = v;
            break;
          case "MAXVALUE":
            opt.maxValue = v;
            break;
          case "NO MINVALUE":
            opt.minValue = null;
            break;
          case "NO MAXVALUE":
            opt.maxValue = null;
            break;
          case "START":
            opt.start = v;
            break;
          case "CACHE":
            opt.cache = v;
            break;
          case "CYCLE":
            opt.cycle = true;
            break;
          case "NO CYCLE":
            opt.cycle = false;
            break;
          case "OWNED BY":
            opt.ownedBy = v;
            break;
          case "LOGGED":
          case "UNLOGGED":
            break;
        }
      }
      const props: SequenceProps = { ...stripUnset({ ...q, persistence: node.persistence, ifNotExists: node.ifNotExists }), ...opt, ...stripUnset({ comment, ddl, source }) } as SequenceProps;
      if (opt.cycle === false) props.cycle = false;
      return make(POSTGRES_ENTITY_TYPES.sequence, q, props);
    }
    case "table": {
      const q = qualified(ctx, node.name);
      const columns = node.columns.map((c) => columnDef(ctx, c));
      let primaryKey: KeyDef | undefined;
      const uniques: KeyDef[] = [];
      const checks: CheckDef[] = [];
      const foreignKeys: ForeignKeyDef[] = [];
      const exclusions: ExclusionDef[] = [];
      const file = (c: ConstraintNode, cols: string[]) => {
        if (c.kind === "FOREIGN KEY") {
          foreignKeys.push(foreignKeyDef(ctx, c, cols));
          slots.push(...referenceSlots(ctx, c, cols));
        }
        else if (c.kind === "PRIMARY KEY") {
          if (primaryKey) throw new SqlTemplateError(tag, `${sqlNameOf(q)} declares more than one primary key`, 0, 0);
          primaryKey = keyDef(ctx, c, cols, "primaryKey");
        } else if (c.kind === "UNIQUE") uniques.push(keyDef(ctx, c, cols, "uniques"));
        else if (c.kind === "CHECK") checks.push(checkDef(ctx, c));
        else if (c.kind === "EXCLUDE") exclusions.push(exclusionDef(ctx, c));
        else if (c.kind === "NOT NULL") {
          const col = columns.find((x) => x.name === cols[0]);
          if (!col) throw new SqlTemplateError(tag, `NOT NULL ${cols[0]} names no column of ${sqlNameOf(q)}`, 0, 0);
          col.notNull = true;
          if (c.name) col.notNullName = c.name;
        }
      };
      node.columns.forEach((c, i) => c.constraints.forEach((k) => file(k, [columns[i]!.name])));
      node.constraints.forEach((k) => {
        // Text spliced into a key's column list feeds the key's columns.
        const path = k.kind === "PRIMARY KEY" ? "primaryKey.columns" : k.kind === "UNIQUE" ? "uniques" : k.kind === "FOREIGN KEY" ? "foreignKeys" : undefined;
        if (path) for (const x of k.columns) feed(ctx, x.span, path);
        file(k, k.columns.map((x) => columnName(ctx, x)));
      });
      const named = new Map<string, Commentable>();
      for (const c of [primaryKey, ...uniques, ...checks, ...foreignKeys, ...exclusions]) if (c?.name) named.set(c.name, c);
      const comment = applyComments(tag, ctx, comments, q, ["TABLE"], { columns: new Map(columns.map((c) => [c.name, c])), constraints: named });
      let rls: boolean | undefined;
      let force: boolean | undefined;
      for (const r of rowSecurity) {
        const t = qualified(ctx, r.table);
        if (t.name !== q.name || (t.schema !== undefined && q.schema !== undefined && t.schema !== q.schema)) {
          throw new SqlTemplateError(tag, `ALTER TABLE ${sqlNameOf(t)} ... ROW LEVEL SECURITY names another table than ${sqlNameOf(q)}`, 0, 0);
        }
        if (r.action === "ENABLE" || r.action === "DISABLE") rls = r.action === "ENABLE";
        else force = r.action === "FORCE";
      }
      const props: TableProps = strip(
        {
          ...q,
          persistence: node.persistence,
          ifNotExists: node.ifNotExists,
          partitionOf: node.partitionOf ? target(ctx, node.partitionOf) : undefined,
          partitionBound: text(ctx, node.partitionBound, "partitionBound"),
          ofType: node.ofType ? target(ctx, node.ofType) : undefined,
          columns,
          primaryKey,
          uniques,
          checks,
          foreignKeys,
          exclusions,
          like: node.like.map((l) => req(text(ctx, l, "like"))),
          inherits: (node.inherits ?? []).map((n) => target(ctx, n)),
          partitionBy: text(ctx, node.partitionBy, "partitionBy"),
          using: text(ctx, node.using, "using"),
          with: text(ctx, node.with, "with"),
          onCommit: text(ctx, node.onCommit),
          tablespace: text(ctx, node.tablespace, "tablespace"),
          rowSecurity: rls,
          forceRowSecurity: force,
          comment,
          ddl,
          source,
        },
        ["columns", "uniques", "checks", "foreignKeys", "exclusions", "like", "inherits"],
      );
      if (rls === false) props.rowSecurity = false;
      if (force === false) props.forceRowSecurity = false;
      return make(POSTGRES_ENTITY_TYPES.table, q, props, columns.map((c) => c.name));
    }
    case "index": {
      if (!node.name) {
        throw new SqlTemplateError(tag, "an index needs a name: the name is its identity on the server, and an unnamed index gets a generated one", 0, 0);
      }
      const tableTarget = target(ctx, node.table);
      const tq = qualified(ctx, node.table);
      const name = node.name.pieces[0] || identValue(req(text(ctx, node.name.span)));
      feed(ctx, node.name.span, "name");
      // An index lives in its table's schema.
      const q = { schema: tq.schema, name };
      const comment = applyComments(tag, ctx, comments, q, ["INDEX"]);
      const props: IndexProps = strip(
        {
          ...q,
          table: tableTarget,
          tableName: sqlNameOf(tq),
          unique: node.unique,
          concurrently: node.concurrently,
          ifNotExists: node.ifNotExists,
          only: node.only,
          method: node.using,
          elements: node.elements.map((e) => {
            const sig = tokens.slice(e.span.from, e.span.to).filter((t) => !isTrivia(t));
            const ref = sig[0]?.kind === "ref" ? values[sig[0].part] : undefined;
            const byRef = isColumnRef(ref) && sig.slice(1).every((t) => t.kind === "ident" || t.kind === "qident") ? ref.attribute : undefined;
            return stripUnset({ expr: req(text(ctx, e.span, "elements")), column: e.column ?? byRef });
          }),
          include: text(ctx, node.include, "include"),
          nullsNotDistinct: node.nullsNotDistinct,
          with: text(ctx, node.with, "with"),
          tablespace: text(ctx, node.tablespace, "tablespace"),
          where: text(ctx, node.where, "where"),
          comment,
          ddl,
          source,
        },
        ["elements"],
      );
      if (node.nullsNotDistinct === false) props.nullsNotDistinct = false;
      return make(POSTGRES_ENTITY_TYPES.index, q, props);
    }
    case "view": {
      const q = qualified(ctx, node.name);
      const lin = lineage<PostgresObject>(ctx, node.query);
      const declared = node.columnNames.map((c) => columnName(ctx, c));
      // A declared column list renames the outputs, by position.
      const edges: LineageEdge[] = lin.edges.map((e, i) => ({ ...e, output: declared[i] ?? e.output }));
      const outputs = declared.length > 0 ? declared : edges.map((e) => e.output);
      const columnComments: Record<string, string> = {};
      const comment = applyComments(tag, ctx, comments, q, node.materialized ? ["MATERIALIZED VIEW"] : ["VIEW"], { columnComments });
      const props: ViewProps = strip(
        {
          ...q,
          orReplace: node.orReplace,
          recursive: node.recursive,
          temporary: node.temporary,
          ifNotExists: node.ifNotExists,
          columns: declared,
          with: text(ctx, node.with, "with"),
          using: text(ctx, node.using, "using"),
          tablespace: text(ctx, node.tablespace, "tablespace"),
          query: req(text(ctx, node.query, "query")),
          checkOption: text(ctx, node.checkOption, "checkOption"),
          withData: node.withData,
          reads: lin.reads,
          lineage: edges,
          columnComments: Object.keys(columnComments).length > 0 ? columnComments : undefined,
          comment,
          ddl,
          source,
        },
        ["columns", "reads", "lineage"],
      );
      if (node.withData === false) props.withData = false;
      feed(ctx, node.query, "lineage");
      return make(node.materialized ? POSTGRES_ENTITY_TYPES.materializedView : POSTGRES_ENTITY_TYPES.view, q, props, outputs);
    }
    case "function":
    case "procedure": {
      const q = qualified(ctx, node.name);
      const comment = applyComments(tag, ctx, comments, q, node.statement === "function" ? ["FUNCTION", "ROUTINE"] : ["PROCEDURE", "ROUTINE"]);
      const flag = (o: string) => node.options.find((x) => x.option === o)?.flag;
      const value = (o: string, path: string) => {
        const x = node.options.find((y) => y.option === o);
        return x?.value ? text(ctx, x.value, path) : undefined;
      };
      const set: Record<string, string> = {};
      for (const s of node.set) set[s.name] = req(text(ctx, s.value, "set"));
      const [def, link] = node.body.map((b) => stringValue(text(ctx, b, "body")));
      const lang = text(ctx, node.language, "language");
      const props: RoutineProps = strip(
        {
          ...q,
          orReplace: node.orReplace || undefined,
          args: node.args.map((a) =>
            stripUnset({
              mode: (a.mode?.toLowerCase() ?? "in") as RoutineArgDef["mode"],
              name: a.name,
              type: req(text(ctx, a.type, "args")),
              default: text(ctx, a.default, "args"),
            }),
          ),
          returns: node.returns ? `${node.returns.setof ? "SETOF " : ""}${req(text(ctx, node.returns.type, "returns"))}` : undefined,
          returnsTable: node.returnsTable?.map((c) => ({ name: c.name, type: req(text(ctx, c.type, "returns")) })),
          language: lang === undefined ? undefined : lang.startsWith("'") ? stringValue(lang) : identValue(lang),
          volatility: value("VOLATILITY", "volatility")?.toLowerCase() as RoutineProps["volatility"],
          strict: flag("STRICT"),
          securityDefiner: flag("SECURITY"),
          leakproof: flag("LEAKPROOF"),
          parallel: value("PARALLEL", "parallel")?.toLowerCase() as RoutineProps["parallel"],
          cost: value("COST", "cost"),
          rows: value("ROWS", "rows"),
          support: value("SUPPORT", "support"),
          window: flag("WINDOW"),
          transform: value("TRANSFORM", "transform"),
          set: Object.keys(set).length > 0 ? set : undefined,
          body: req(def),
          link,
          reads: (joined?.refs ?? []).filter((v): v is PostgresObject => isPostgresObject(v)),
          comment,
          ddl,
          source,
        },
        ["args", "reads"],
      );
      for (const k of ["strict", "securityDefiner", "leakproof"] as const) if (flag(k === "securityDefiner" ? "SECURITY" : k.toUpperCase()) === false) props[k] = false;
      return make(node.statement === "function" ? POSTGRES_ENTITY_TYPES.function : POSTGRES_ENTITY_TYPES.procedure, q, props);
    }
    case "trigger": {
      const tq = qualified(ctx, node.table);
      const name = node.name.pieces[0] || identValue(req(text(ctx, node.name.span)));
      feed(ctx, node.name.span, "name");
      // A trigger is its table's: it is named in the table's schema.
      const q = { schema: tq.schema, name };
      const comment = applyComments(tag, ctx, comments, q, ["TRIGGER"]);
      const referencing: { old?: string; new?: string } = {};
      for (const r of node.referencing) referencing[r.which === "OLD" ? "old" : "new"] = r.name;
      const props: TriggerProps = strip(
        {
          ...q,
          orReplace: node.orReplace || undefined,
          constraint: node.constraint || undefined,
          timing: node.timing.toLowerCase() as TriggerProps["timing"],
          events: node.events.map((e) => {
            for (const c of e.columns) feed(ctx, c.span, "events");
            const columns = e.columns.map((c) => columnName(ctx, c));
            return { event: e.event.toLowerCase() as TriggerProps["events"][number]["event"], ...(columns.length > 0 ? { columns } : {}) };
          }),
          table: target(ctx, node.table),
          tableName: sqlNameOf(tq),
          from: node.from ? targetName(ctx, node.from) : undefined,
          deferrable: node.deferrable,
          initiallyDeferred: node.initiallyDeferred,
          referencing: Object.keys(referencing).length > 0 ? referencing : undefined,
          forEach: (node.forEach ?? "STATEMENT").toLowerCase() as TriggerProps["forEach"],
          when: text(ctx, node.when, "when"),
          function: target(ctx, node.function),
          functionName: targetName(ctx, node.function),
          args: node.args.map((a) => req(text(ctx, a, "args"))),
          comment,
          ddl,
          source,
        },
        ["events", "args"],
      );
      return make(POSTGRES_ENTITY_TYPES.trigger, q, props);
    }
    case "policy": {
      const tq = qualified(ctx, node.table);
      const name = node.name.pieces[0] || identValue(req(text(ctx, node.name.span)));
      feed(ctx, node.name.span, "name");
      // A policy is its table's, named in the table's schema.
      const q = { schema: tq.schema, name };
      const comment = applyComments(tag, ctx, comments, q, ["POLICY"]);
      const props: PolicyProps = stripUnset({
        ...q,
        table: target(ctx, node.table),
        tableName: sqlNameOf(tq),
        permissive: node.permissive !== false,
        command: (node.command ?? "ALL").toLowerCase() as PolicyProps["command"],
        roles: node.roles.length > 0 ? node.roles.map((r) => roleName(ctx, r)) : ["public"],
        using: text(ctx, node.using, "using"),
        check: text(ctx, node.check, "check"),
        comment,
        ddl,
        source,
      });
      // AS RESTRICTIVE is a false that means something.
      props.permissive = node.permissive !== false;
      return make(POSTGRES_ENTITY_TYPES.policy, q, props);
    }
    case "role": {
      const name = node.name.pieces[0] || identValue(req(text(ctx, node.name.span)));
      feed(ctx, node.name.span, "name");
      const comment = applyComments(tag, ctx, comments, { name }, ["ROLE"]);
      const value = (o: string) => {
        const x = node.options.find((y) => y.option === o);
        return x?.value ? text(ctx, x.value, "options") : undefined;
      };
      const props: RoleProps = stripUnset({
        name,
        options: node.options.filter((o) => o.value === undefined).map((o) => o.option.toLowerCase()),
        connectionLimit: value("CONNECTION LIMIT"),
        comment,
        ddl,
        source,
      });
      return make(POSTGRES_ENTITY_TYPES.role, { name }, props);
    }
    case "grant":
      return make(node.defaults ? POSTGRES_ENTITY_TYPES.defaultPrivileges : POSTGRES_ENTITY_TYPES.grant, { name: "" }, grantProps(ctx, node, ddl, source));
    case "rowSecurity":
      throw new SqlTemplateError(tag, "an ALTER TABLE ... ROW LEVEL SECURITY goes after the table's CREATE TABLE, in the table's template", 0, 0);
    case "comment":
      throw new SqlTemplateError(tag, "a COMMENT ON goes after the CREATE it comments on", 0, 0);
  }
}

/**
 * `` schema`CREATE SCHEMA ...` ``: one Postgres schema, parsed at build time.
 * Given its name as the type argument (`` schema<"shop">`...` ``), a composite
 * placed in it types its members' columns (chant#3787).
 */
export function schema<const N extends string = Unnamed>(strings: TemplateStringsArray, ...values: unknown[]): PostgresSchema<N> {
  return build("schema", strings, values) as PostgresSchema<N>;
}

/**
 * `` table`CREATE TABLE ...` ``: one Postgres table with its columns and
 * constraints, parsed at build time. Given its qualified name as the type
 * argument (`` table<"shop.orders">`...` ``), its columns are the ones
 * `chant sql types` declared for that name.
 */
export function table<const N extends string = Unnamed>(strings: TemplateStringsArray, ...values: SlotsIn<SqlSchema, N>): PostgresTable<N> {
  return build("table", strings, values) as PostgresTable<N>;
}

/** `` index`CREATE [UNIQUE] INDEX [CONCURRENTLY] name ON ...` ``: one named index. */
export function index(strings: TemplateStringsArray, ...values: unknown[]): PostgresIndex {
  return build("index", strings, values) as PostgresIndex;
}

/**
 * `` view`CREATE [MATERIALIZED] VIEW ...` ``: one view or materialized view,
 * with what it reads and its column lineage. Takes its qualified name as the
 * type argument, as {@link table} does.
 */
export function view<const N extends string = Unnamed>(strings: TemplateStringsArray, ...values: SlotsIn<SqlSchema, N>): PostgresView<N> {
  return build("view", strings, values) as PostgresView<N>;
}

/** `` sequence`CREATE SEQUENCE ...` ``: one sequence. Reference it as `nextval(${seq})`. */
export function sequence(strings: TemplateStringsArray, ...values: unknown[]): PostgresSequence {
  return build("sequence", strings, values) as PostgresSequence;
}

/**
 * `` type`CREATE TYPE name AS ENUM (...)` ``: one enum type; `AS (attribute
 * type, ...)` a composite type, `AS RANGE (SUBTYPE = ...)` a range type (and
 * its multirange type, which Postgres creates with it).
 */
export function type(strings: TemplateStringsArray, ...values: unknown[]): PostgresType {
  return build("type", strings, values) as PostgresType;
}

/** `` domain`CREATE DOMAIN ...` ``: one domain. */
export function domain(strings: TemplateStringsArray, ...values: unknown[]): PostgresDomain {
  return build("domain", strings, values) as PostgresDomain;
}

/** `` extension`CREATE EXTENSION ...` ``: one extension. */
export function extension(strings: TemplateStringsArray, ...values: unknown[]): PostgresExtension {
  return build("extension", strings, values) as PostgresExtension;
}

/**
 * `` func`CREATE [OR REPLACE] FUNCTION name(args) RETURNS ... LANGUAGE ... AS $$ ... $$` ``:
 * one function, its body a string kept verbatim. (`function` is a JavaScript
 * key word, hence `func`.)
 */
export function func(strings: TemplateStringsArray, ...values: unknown[]): PostgresFunction {
  return build("func", strings, values) as PostgresFunction;
}

/** `` procedure`CREATE [OR REPLACE] PROCEDURE name(args) LANGUAGE ... AS $$ ... $$` ``: one procedure. */
export function procedure(strings: TemplateStringsArray, ...values: unknown[]): PostgresProcedure {
  return build("procedure", strings, values) as PostgresProcedure;
}

/**
 * `` aggregate`CREATE [OR REPLACE] AGGREGATE name(argtype, ...) (SFUNC = ..., STYPE = ...)` ``:
 * one aggregate, identified, as a function is, by its argument types.
 */
export function aggregate(strings: TemplateStringsArray, ...values: unknown[]): PostgresAggregate {
  return build("aggregate", strings, values) as PostgresAggregate;
}

/** `` collation`CREATE COLLATION name (provider = icu, locale = '...')` ``: one collation. */
export function collation(strings: TemplateStringsArray, ...values: unknown[]): PostgresCollation {
  return build("collation", strings, values) as PostgresCollation;
}

/**
 * `` cast`CREATE CAST (source AS target) WITH FUNCTION ${fn}(source) [AS ASSIGNMENT | AS IMPLICIT]` ``:
 * one cast, named by its two types. Creating one takes owning the source or
 * the target type.
 */
export function cast(strings: TemplateStringsArray, ...values: unknown[]): PostgresCast {
  return build("cast", strings, values) as PostgresCast;
}

/**
 * `` eventTrigger`CREATE EVENT TRIGGER name ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION ${fn}()` ``:
 * one event trigger, the database's (no schema). Creating one takes a superuser.
 */
export function eventTrigger(strings: TemplateStringsArray, ...values: unknown[]): PostgresEventTrigger {
  return build("eventTrigger", strings, values) as PostgresEventTrigger;
}

/**
 * `` operator`CREATE OPERATOR app.=== (FUNCTION = ${fn}, LEFTARG = int, RIGHTARG = int)` ``:
 * one operator, identified by its name and operand types, as a function is by
 * its name and parameter types.
 */
export function operator(strings: TemplateStringsArray, ...values: unknown[]): PostgresOperator {
  return build("operator", strings, values) as PostgresOperator;
}

/**
 * `` operatorClass`CREATE OPERATOR CLASS app.ops DEFAULT FOR TYPE int USING btree AS OPERATOR 1 <, FUNCTION 1 ${cmp}(int, int)` ``:
 * one operator class, identified by its name and index method. Creating one takes a superuser.
 */
export function operatorClass(strings: TemplateStringsArray, ...values: unknown[]): PostgresOperatorClass {
  return build("operatorClass", strings, values) as PostgresOperatorClass;
}

/**
 * `` operatorFamily`CREATE OPERATOR FAMILY app.ops USING btree` ``: one operator
 * family, identified by its name and index method. Its members come with the
 * operator classes that name it. Creating one takes a superuser.
 */
export function operatorFamily(strings: TemplateStringsArray, ...values: unknown[]): PostgresOperatorFamily {
  return build("operatorFamily", strings, values) as PostgresOperatorFamily;
}

/**
 * `` foreignTable`CREATE FOREIGN TABLE app.remote_orders (id int, total numeric) SERVER ${remote} OPTIONS (table_name 'orders')` ``:
 * one foreign table. It has its own tag, not `table`, because it is another
 * kind of relation: another CREATE and ALTER, no key, index, partitioning or
 * storage clauses, and a server it cannot move off.
 */
export function foreignTable(strings: TemplateStringsArray, ...values: unknown[]): PostgresForeignTable {
  return build("foreignTable", strings, values) as PostgresForeignTable;
}

/**
 * `` textSearchDictionary`CREATE TEXT SEARCH DICTIONARY app.english_stop (TEMPLATE = snowball, Language = english, StopWords = english)` ``:
 * one text search dictionary: a template and its options.
 */
export function textSearchDictionary(strings: TemplateStringsArray, ...values: unknown[]): PostgresTextSearchDictionary {
  return build("textSearchDictionary", strings, values) as PostgresTextSearchDictionary;
}

/**
 * `` textSearchConfiguration`CREATE TEXT SEARCH CONFIGURATION app.english2 (PARSER = default); ALTER TEXT SEARCH CONFIGURATION app.english2 ADD MAPPING FOR asciiword WITH ${dict}` ``:
 * one text search configuration: a parser, and the dictionaries each token
 * type it finds is looked up in.
 */
export function textSearchConfiguration(strings: TemplateStringsArray, ...values: unknown[]): PostgresTextSearchConfiguration {
  return build("textSearchConfiguration", strings, values) as PostgresTextSearchConfiguration;
}

/**
 * `` statistics`CREATE STATISTICS name (ndistinct, dependencies) ON a, b FROM ${table}` ``:
 * extended statistics on columns or expressions of one table.
 */
export function statistics(strings: TemplateStringsArray, ...values: unknown[]): PostgresStatistics {
  return build("statistics", strings, values) as PostgresStatistics;
}

/**
 * `` foreignDataWrapper`CREATE FOREIGN DATA WRAPPER name HANDLER ${fn} OPTIONS (...)` ``:
 * one foreign data wrapper, the database's (no schema). Creating one takes a superuser.
 */
export function foreignDataWrapper(strings: TemplateStringsArray, ...values: unknown[]): PostgresForeignDataWrapper {
  return build("foreignDataWrapper", strings, values) as PostgresForeignDataWrapper;
}

/**
 * `` foreignServer`CREATE SERVER name FOREIGN DATA WRAPPER ${fdw} OPTIONS (host 'db.internal')` ``:
 * one foreign server, the database's. Its user mappings carry credentials and are
 * not declared; an option that holds a secret is the environment's to supply.
 */
export function foreignServer(strings: TemplateStringsArray, ...values: unknown[]): PostgresForeignServer {
  return build("foreignServer", strings, values) as PostgresForeignServer;
}

/**
 * `` publication`CREATE PUBLICATION name FOR TABLE ${t} WITH (publish = 'insert')` ``:
 * one logical-replication publication, the database's.
 */
export function publication(strings: TemplateStringsArray, ...values: unknown[]): PostgresPublication {
  return build("publication", strings, values) as PostgresPublication;
}

/** `` trigger`CREATE [OR REPLACE] [CONSTRAINT] TRIGGER name ... ON ${table} ... EXECUTE FUNCTION ${fn}()` ``: one trigger on its table. */
export function trigger(strings: TemplateStringsArray, ...values: unknown[]): PostgresTrigger {
  return build("trigger", strings, values) as PostgresTrigger;
}

/** `` policy`CREATE POLICY name ON ${table} ... USING (...)` ``: one row-level security policy on its table. */
export function policy(strings: TemplateStringsArray, ...values: unknown[]): PostgresPolicy {
  return build("policy", strings, values) as PostgresPolicy;
}

/**
 * `` role`CREATE ROLE name [WITH] options` ``: a role the schema needs, created
 * when it is missing. A password and memberships are the environment's and are
 * refused; a role the environment provisions is named as text where it is
 * granted to, never declared.
 */
export function role(strings: TemplateStringsArray, ...values: unknown[]): PostgresRole {
  return build("role", strings, values) as PostgresRole;
}

/**
 * `` grant`GRANT ... ON ... TO ...` ``, `REVOKE ... FROM ...`, or
 * `ALTER DEFAULT PRIVILEGES ... GRANT|REVOKE ...`: privileges on schemas,
 * tables, columns, sequences and routines, applied where the profile manages
 * access (`sql.profiles.<env>.access`).
 */
export function grant(strings: TemplateStringsArray, ...values: unknown[]): PostgresGrant {
  return build("grant", strings, values) as PostgresGrant;
}
