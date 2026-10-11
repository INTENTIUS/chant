/**
 * Column type parameters: the overlay half.
 *
 * `system.data_type_families` lists the families and their aliases. The
 * parameter grammar (`Decimal(P, S)`, `DateTime64(precision[, tz])`,
 * `Enum8('a' = 1)`) is in no system table. A family missing here takes no
 * parameters; generation fails when a key here is not a family at the pin.
 */

import type { ArgumentKind } from "./kinds";

export interface TypeParameter {
  name: string;
  kind: ArgumentKind | "enum-member" | "named-type";
  optional?: boolean;
  /** The parameter repeats (`Tuple(T, ...)`). */
  repeated?: boolean;
  range?: readonly [number, number];
}

const P = (name: string, kind: TypeParameter["kind"], extra: Partial<TypeParameter> = {}): TypeParameter => ({
  name,
  kind,
  ...extra,
});

const TZ = P("timezone", "string", { optional: true });

/**
 * The server takes and ignores a MySQL-style display width on an integer
 * (`INT(11)`, `UInt64(8)`), a precision and scale on a float (`DOUBLE(10, 2)`)
 * and a length on a string (`VARCHAR(255)`), so each is an optional parameter
 * here rather than a mistake.
 */
const WIDTH = [P("display_width", "number", { optional: true })];
const FLOAT = [P("precision", "number", { optional: true }), P("scale", "number", { optional: true })];
const INTEGERS = ["Int8", "Int16", "Int32", "Int64", "Int128", "Int256", "UInt8", "UInt16", "UInt32", "UInt64", "UInt128", "UInt256"];

export const TYPE_PARAMETERS: Record<string, readonly TypeParameter[]> = {
  ...Object.fromEntries(INTEGERS.map((name) => [name, WIDTH])),
  Float32: FLOAT,
  Float64: FLOAT,
  BFloat16: FLOAT,
  String: [P("length", "number", { optional: true })],
  /** A bare `Decimal` is `Decimal(10, 0)`. */
  Decimal: [P("precision", "number", { optional: true, range: [1, 76] }), P("scale", "number", { optional: true, range: [0, 76] })],
  Decimal32: [P("scale", "number", { range: [0, 9] })],
  Decimal64: [P("scale", "number", { range: [0, 18] })],
  Decimal128: [P("scale", "number", { range: [0, 38] })],
  Decimal256: [P("scale", "number", { range: [0, 76] })],
  DateTime: [TZ],
  DateTime32: [TZ],
  /** A bare `DateTime64` has precision 3. */
  DateTime64: [P("precision", "number", { optional: true, range: [0, 9] }), TZ],
  Time64: [P("precision", "number", { optional: true, range: [0, 9] })],
  FixedString: [P("length", "number", { range: [1, Number.MAX_SAFE_INTEGER] })],
  Enum: [P("member", "enum-member", { repeated: true })],
  Enum8: [P("member", "enum-member", { repeated: true })],
  Enum16: [P("member", "enum-member", { repeated: true })],
  Nullable: [P("type", "type")],
  LowCardinality: [P("type", "type")],
  Array: [P("type", "type")],
  Map: [P("key", "type"), P("value", "type")],
  Tuple: [P("element", "named-type", { repeated: true })],
  Nested: [P("field", "named-type", { repeated: true })],
  Variant: [P("type", "type", { repeated: true })],
  AggregateFunction: [P("function", "function"), P("argument", "type", { repeated: true })],
  SimpleAggregateFunction: [P("function", "function"), P("argument", "type")],
  JSON: [P("setting", "expression", { optional: true, repeated: true })],
  Dynamic: [P("max_types", "expression", { optional: true })],
  QBit: [P("element", "type"), P("dimension", "number")],
};

/** Families that wrap another type and pass its nullability and sort-key rules through. */
export const WRAPPER_TYPES: readonly string[] = ["LowCardinality"];
