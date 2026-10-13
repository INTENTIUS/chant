/**
 * What a Postgres column's value is in TypeScript, for `RowOf` (#3751): the
 * value node-postgres (`pg`, the driver the lexicon itself uses) hands back
 * with its default type parsers. `bigint` and `numeric` are strings, since a
 * JavaScript number cannot hold every value; `integer`, `smallint`, `real`
 * and `double precision` are numbers; dates and timestamps are `Date`s;
 * `json` and `jsonb` are parsed, so their shape is the application's
 * (`unknown`); everything the driver does not parse is its text form.
 *
 * The table names every built-in type of every supported major's catalog
 * (`COLUMN_TYPES`), and a test fails on one it does not, so a type a new
 * catalog adds is a decision rather than a silent `unknown`.
 */

import type { TypeSqlName } from "../generated/postgres-types";

const NUMBER = "number";
const STRING = "string";
const DATE = "Date";

/** The TypeScript type of each built-in type's value, by its `format_type()` name. */
export const POSTGRES_ROW_TYPES: Readonly<Record<TypeSqlName, string>> = {
  // Numbers the driver parses; the 64-bit and arbitrary-precision ones stay text.
  smallint: NUMBER,
  integer: NUMBER,
  real: NUMBER,
  "double precision": NUMBER,
  oid: NUMBER,
  bigint: STRING,
  numeric: STRING,
  money: STRING,
  regclass: STRING,
  regcollation: STRING,
  regconfig: STRING,
  regdictionary: STRING,
  regnamespace: STRING,
  regoper: STRING,
  regoperator: STRING,
  regproc: STRING,
  regprocedure: STRING,
  regrole: STRING,
  regtype: STRING,
  boolean: "boolean",
  // Strings.
  text: STRING,
  "character varying": STRING,
  character: STRING,
  name: STRING,
  '"char"': STRING,
  uuid: STRING,
  xml: STRING,
  bit: STRING,
  "bit varying": STRING,
  cidr: STRING,
  inet: STRING,
  macaddr: STRING,
  macaddr8: STRING,
  tsvector: STRING,
  tsquery: STRING,
  jsonpath: STRING,
  pg_lsn: STRING,
  pg_snapshot: STRING,
  txid_snapshot: STRING,
  refcursor: STRING,
  aclitem: STRING,
  cid: STRING,
  tid: STRING,
  xid: STRING,
  xid8: STRING,
  int2vector: STRING,
  oidvector: STRING,
  gtsvector: STRING,
  pg_brin_bloom_summary: STRING,
  pg_brin_minmax_multi_summary: STRING,
  pg_dependencies: STRING,
  pg_mcv_list: STRING,
  pg_ndistinct: STRING,
  pg_node_tree: STRING,
  // Dates and times: the driver parses dates and timestamps, not times of day.
  date: DATE,
  "timestamp without time zone": DATE,
  "timestamp with time zone": DATE,
  "time without time zone": STRING,
  "time with time zone": STRING,
  interval: "{ years?: number; months?: number; days?: number; hours?: number; minutes?: number; seconds?: number; milliseconds?: number }",
  // Ranges and multiranges arrive as their text form.
  int4range: STRING,
  int8range: STRING,
  numrange: STRING,
  tsrange: STRING,
  tstzrange: STRING,
  daterange: STRING,
  int4multirange: STRING,
  int8multirange: STRING,
  nummultirange: STRING,
  tsmultirange: STRING,
  tstzmultirange: STRING,
  datemultirange: STRING,
  // Geometry: the driver parses a point and a circle.
  point: "{ x: number; y: number }",
  circle: "{ x: number; y: number; radius: number }",
  line: STRING,
  lseg: STRING,
  box: STRING,
  path: STRING,
  polygon: STRING,
  // Parsed, so the application's own shape.
  json: "unknown",
  jsonb: "unknown",
  bytea: "Uint8Array",
};
