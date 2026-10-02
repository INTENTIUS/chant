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

export const TYPE_PARAMETERS: Record<string, readonly TypeParameter[]> = {
  Decimal: [P("precision", "number", { range: [1, 76] }), P("scale", "number", { optional: true })],
  Decimal32: [P("scale", "number", { range: [0, 9] })],
  Decimal64: [P("scale", "number", { range: [0, 18] })],
  Decimal128: [P("scale", "number", { range: [0, 38] })],
  Decimal256: [P("scale", "number", { range: [0, 76] })],
  DateTime: [TZ],
  DateTime32: [TZ],
  DateTime64: [P("precision", "number", { range: [0, 9] }), TZ],
  Time64: [P("precision", "number", { range: [0, 9] })],
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
