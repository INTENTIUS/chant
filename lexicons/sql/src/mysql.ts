/**
 * `@intentius/chant-lexicon-sql/mysql`: the MySQL dialect (#5449), for
 * MySQL 8.0 and Aurora MySQL 3.
 *
 * Everything here is spec-true to MySQL 8.0, not a database-agnostic model:
 * the statements are MySQL's own DDL, parsed at build time into entities,
 * the types and reserved words are the reference manual's
 * (`./generated/mysql.ts`), and names quote with backquotes as MySQL's do.
 */

export {
  database,
  table,
  view,
  literal,
  SqlLiteral,
  SqlTemplateError,
  MysqlObject,
  MYSQL_ENTITY_TYPES,
  isMysqlObject,
  isColumnRef,
  quoteIdent,
  type MysqlEntityType,
  type MysqlDatabase,
  type MysqlRelation,
  type MysqlTable,
  type MysqlView,
  type ColumnDef,
  type KeyPartDef,
  type PrimaryKeyDef,
  type IndexDef,
  type ForeignKeyDef,
  type CheckDef,
  type DatabaseProps,
  type TableProps,
  type ViewProps,
  type LineageEdge,
  type SqlSchema,
  type RowOf,
  type Column,
  type ColumnTraits,
  type AnyColumn,
  type UncheckedColumn,
  type KeyColumn,
  type NotNullColumn,
  type Named,
  type Unnamed,
} from "./mysql/entities";

export { MYSQL_CHANGE_CLASSES, MYSQL_CLASSIFIER_RULES, type MysqlChangeClass, type MysqlClassifierRuleId } from "./mysql/plan/rules";
export { classifyMysqlVersion, MYSQL_MAJORS, MYSQL_PINS, type MysqlServer } from "./spec/mysql-pin";
export * from "./generated/mysql";
