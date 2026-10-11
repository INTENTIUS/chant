/**
 * What a ClickHouse column's value is in TypeScript, for `RowOf` (#3751): the
 * value a row has in ClickHouse's JSON formats (`JSONEachRow`, what the HTTP
 * clients read) with the server's default settings. 64-bit and wider
 * integers are quoted (`output_format_json_quote_64bit_integers`), so they
 * are strings; narrower integers, floats and decimals are numbers; dates,
 * times, UUIDs and addresses are their text; a named tuple is an object
 * (`output_format_json_named_tuples_as_objects`) and an unnamed one an array.
 * `Nullable(T)` adds `| null` and `LowCardinality(T)` is `T`.
 *
 * The table names every type family of the pinned server's catalog
 * (`TYPE_FAMILIES`, aliases resolved), and a test fails on one it does not,
 * so a family a new release adds is a decision rather than a silent
 * `unknown`.
 */

import type { ColumnTypeFamily } from "../generated/clickhouse-types";
import { familyOf } from "../lint/post-synth/clickhouse-type-check";
import { readType, typeTokens, type TypeParam } from "./type-syntax";
import { isTrivia } from "./tokens";

/** How a family's parameters make its row type: `inner` maps a parameter that is itself a type. */
type Composed = (params: readonly TypeParam[], inner: (type: string) => string) => string;

const NUMBER = "number";
const STRING = "string";
const UNKNOWN = "unknown";
const POINT = "[number, number]";

/** A union needs parentheses before `[]`. */
const element = (ts: string): string => (/[|&]/.test(ts) && !/^\{.*\}$/s.test(ts) ? `(${ts})` : ts);

/** An enum's labels as a union of string literals; its text when none read. */
const enumLabels: Composed = (params) => {
  const labels = params.flatMap((p) => {
    const first = p.tokens.find((t) => !isTrivia(t));
    return first?.kind === "string" ? [first.text.slice(1, -1).replace(/\\(.)/g, "$1").replace(/''/g, "'")] : [];
  });
  return labels.length > 0 ? labels.map((l) => JSON.stringify(l)).join(" | ") : STRING;
};

/** The TypeScript type of each type family's value, or how its parameters make it. */
export const CLICKHOUSE_ROW_TYPES: Readonly<Record<ColumnTypeFamily, string | Composed>> = {
  UInt8: NUMBER,
  UInt16: NUMBER,
  UInt32: NUMBER,
  Int8: NUMBER,
  Int16: NUMBER,
  Int32: NUMBER,
  Float32: NUMBER,
  Float64: NUMBER,
  BFloat16: NUMBER,
  Decimal: NUMBER,
  Decimal32: NUMBER,
  Decimal64: NUMBER,
  Decimal128: NUMBER,
  Decimal256: NUMBER,
  // Quoted in JSON, so text.
  UInt64: STRING,
  UInt128: STRING,
  UInt256: STRING,
  Int64: STRING,
  Int128: STRING,
  Int256: STRING,
  IntervalNanosecond: STRING,
  IntervalMicrosecond: STRING,
  IntervalMillisecond: STRING,
  IntervalSecond: STRING,
  IntervalMinute: STRING,
  IntervalHour: STRING,
  IntervalDay: STRING,
  IntervalWeek: STRING,
  IntervalMonth: STRING,
  IntervalQuarter: STRING,
  IntervalYear: STRING,
  Bool: "boolean",
  String: STRING,
  FixedString: STRING,
  UUID: STRING,
  IPv4: STRING,
  IPv6: STRING,
  Date: STRING,
  Date32: STRING,
  DateTime: STRING,
  DateTime32: STRING,
  DateTime64: STRING,
  Time: STRING,
  Time64: STRING,
  Enum: enumLabels,
  Enum8: enumLabels,
  Enum16: enumLabels,
  // Wrappers and containers.
  Nullable: (p, inner) => `${inner(p[0]?.text ?? "")} | null`,
  LowCardinality: (p, inner) => inner(p[0]?.text ?? ""),
  Array: (p, inner) => `${element(inner(p[0]?.text ?? ""))}[]`,
  Map: (p, inner) => `Record<string, ${inner(p[1]?.text ?? "")}>`,
  Tuple: (p, inner) => {
    const elements = p.map((x) => named(x));
    if (elements.length > 0 && elements.every((e) => e.name !== undefined)) {
      return `{ ${elements.map((e) => `${propertyName(e.name!)}: ${inner(e.type)}`).join("; ")} }`;
    }
    return `[${elements.map((e) => inner(e.type)).join(", ")}]`;
  },
  SimpleAggregateFunction: (p, inner) => inner(p[1]?.text ?? ""),
  AggregateFunction: UNKNOWN,
  Nested: UNKNOWN,
  // Self-describing: the application's own shape.
  JSON: UNKNOWN,
  Dynamic: UNKNOWN,
  Variant: UNKNOWN,
  QBit: UNKNOWN,
  Nothing: "null",
  // Geometry, as the JSON formats write it: points as pairs, nested in arrays.
  Point: POINT,
  Ring: `${POINT}[]`,
  LineString: `${POINT}[]`,
  Polygon: `${POINT}[][]`,
  MultiLineString: `${POINT}[][]`,
  MultiPoint: `${POINT}[]`,
  MultiPolygon: `${POINT}[][][]`,
  Geometry: UNKNOWN,
};

/** A tuple element: `a String` is named `a`, `String` is not. */
function named(param: TypeParam): { name?: string; type: string } {
  const syn = readType(param.tokens);
  if (!syn || syn.words.length < 2) return { type: param.text };
  if (familyOf(syn.words.map((w) => w.text).join(" "))) return { type: param.text };
  const first = syn.words[0]!;
  const rest = param.text.slice(param.text.indexOf(first.text) + first.text.length).trim();
  return { name: first.kind === "qident" ? first.text.slice(1, -1) : first.text, type: rest };
}

const propertyName = (name: string): string => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));

/** A type's row type, wrappers and all; `unknown` for a type this cannot read. */
export function clickhouseTsType(type: string): string {
  const tokens = typeTokens(type);
  const syn = tokens && readType(tokens);
  if (!syn) return UNKNOWN;
  const spec = familyOf(syn.words.map((w) => w.text).join(" "));
  const entry = spec ? (CLICKHOUSE_ROW_TYPES as Readonly<Record<string, string | Composed | undefined>>)[spec.canonical] : undefined;
  if (entry === undefined) return UNKNOWN;
  return typeof entry === "string" ? entry : entry(syn.params ?? [], clickhouseTsType);
}

/** A column's row type and whether it can be NULL: `Nullable(...)` at the top, under any `LowCardinality(...)`. */
export function clickhouseRowType(type: string): { ts: string; nullable: boolean } {
  let t = type.trim();
  let nullable = false;
  for (;;) {
    const m = /^(Nullable|LowCardinality)\s*\(([\s\S]*)\)$/i.exec(t);
    if (!m) break;
    if (m[1]!.toLowerCase() === "nullable") nullable = true;
    t = m[2]!.trim();
  }
  return { ts: clickhouseTsType(t), nullable };
}
