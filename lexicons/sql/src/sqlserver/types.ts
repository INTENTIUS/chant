/**
 * The T-SQL to ClickHouse type map.
 *
 * Source types and their ranges, precisions and defaults are from Microsoft's
 * data type reference
 * (https://learn.microsoft.com/en-us/sql/t-sql/data-types/data-types-transact-sql)
 * and the page of each type under it: `float(n)` is `real` for n in 1..24 and
 * the 8-byte type for 25..53 with a default of 53; `decimal(p,s)` defaults to
 * (18,0) with p up to 38; `datetime2` and `time` take a scale of 0 to 7 with
 * a default of 7; `money` is a 64-bit integer with four decimals and
 * `smallmoney` a 32-bit one; `rowversion` (`timestamp`) is an 8-byte counter.
 *
 * Target types are ClickHouse types of the pinned server (see
 * `../spec/pin.ts`). `types.test.ts` checks every family this file writes
 * against `TYPE_FAMILIES` in the generated catalog and every precision against
 * the `DateTime64`, `Time64` and `Decimal` ranges, so a pin move that drops a
 * type fails there.
 *
 * A type either maps with no judgment (`note` absent) or carries a `note`
 * naming what the map could not keep. A type this file does not know
 * (`sql_variant`, a user-defined alias type) is refused by name.
 */

export interface MappedType {
  ok: true;
  /** The ClickHouse type, before `Nullable`. */
  type: string;
  /** The declared maximum length of a character or binary type, when it has one. */
  maxLength?: number;
  /** Present when the map is a judgment: what was lost or chosen. */
  note?: { message: string; evidence: string[] };
}

export interface RefusedType {
  ok: false;
  reason: string;
}

export type TypeMapping = MappedType | RefusedType;

type Arg = number | "max";

const num = (args: readonly Arg[], i: number): number | undefined => (typeof args[i] === "number" ? (args[i] as number) : undefined);

/** Map a column type. `name` is lower-case, `args` the parenthesised arguments. */
export function mapType(name: string, args: readonly Arg[]): TypeMapping {
  switch (name) {
    case "tinyint":
      return { ok: true, type: "UInt8" };
    case "smallint":
      return { ok: true, type: "Int16" };
    case "int":
    case "integer":
      return { ok: true, type: "Int32" };
    case "bigint":
      return { ok: true, type: "Int64" };
    case "bit":
      return { ok: true, type: "Bool" };
    case "decimal":
    case "numeric":
    case "dec": {
      const p = num(args, 0) ?? 18;
      const s = num(args, 1) ?? 0;
      return { ok: true, type: `Decimal(${String(p)}, ${String(s)})` };
    }
    case "money":
      return { ok: true, type: "Decimal(19, 4)" };
    case "smallmoney":
      return { ok: true, type: "Decimal(10, 4)" };
    case "real":
      return { ok: true, type: "Float32" };
    case "float": {
      const n = num(args, 0) ?? 53;
      return { ok: true, type: n <= 24 ? "Float32" : "Float64" };
    }
    case "date":
      return { ok: true, type: "Date32" };
    case "time":
      return { ok: true, type: `Time64(${String(num(args, 0) ?? 7)})` };
    case "datetime2":
      return { ok: true, type: `DateTime64(${String(num(args, 0) ?? 7)})` };
    case "datetime":
      return { ok: true, type: "DateTime64(3)" };
    case "smalldatetime":
      return { ok: true, type: "DateTime64(0)" };
    case "datetimeoffset": {
      const p = num(args, 0) ?? 7;
      return {
        ok: true,
        type: `DateTime64(${String(p)}, 'UTC')`,
        note: {
          message: "datetimeoffset is read as a UTC DateTime64; the stored offset is not kept.",
          evidence: ["datetimeoffset stores a time zone offset (-14:00 to +14:00) with each value; a ClickHouse DateTime64 holds an instant and one column time zone", "values must be converted to UTC when loaded"],
        },
      };
    }
    case "char":
    case "varchar":
    case "nchar":
    case "nvarchar":
    case "text":
    case "ntext":
    case "sysname": {
      const max = name === "sysname" ? 128 : typeof args[0] === "number" ? args[0] : undefined;
      return { ok: true, type: "String", ...(max !== undefined ? { maxLength: max } : {}) };
    }
    case "binary":
    case "varbinary":
    case "image": {
      const max = typeof args[0] === "number" ? args[0] : undefined;
      return { ok: true, type: "String", ...(max !== undefined ? { maxLength: max } : {}) };
    }
    case "uniqueidentifier":
      return { ok: true, type: "UUID" };
    case "json":
      return { ok: true, type: "JSON" };
    case "xml":
      return {
        ok: true,
        type: "String",
        note: { message: "xml is read as String; ClickHouse has no XML type.", evidence: ["the xml type validates and indexes documents; a String does neither"] },
      };
    case "rowversion":
    case "timestamp":
      return {
        ok: true,
        type: "String",
        note: {
          message: `${name} is read as String; its 8 bytes are an opaque counter.`,
          evidence: ["rowversion is a database-wide counter that SQL Server writes on each row change, not a date or time", "a String keeps the bytes; a UInt64 version column has to be loaded from the source"],
        },
      };
    case "hierarchyid":
      return { ok: true, type: "String", note: { message: "hierarchyid is read as String; ClickHouse has no hierarchy type.", evidence: ["the binary form is kept as bytes; hierarchy methods (GetAncestor, IsDescendantOf) have no ClickHouse equivalent"] } };
    case "geography":
    case "geometry":
      return { ok: true, type: "String", note: { message: `${name} is read as String; the spatial value is not converted.`, evidence: ["a spatial value needs a conversion (well-known text or binary) at load time", "ClickHouse has Point, Ring and Polygon types, which fit only some shapes"] } };
    case "vector": {
      const dims = num(args, 0);
      return {
        ok: true,
        type: "Array(Float32)",
        note: { message: "vector is read as Array(Float32).", evidence: [dims !== undefined ? `declared with ${String(dims)} dimensions, which an Array does not enforce` : "the dimension count is not enforced by an Array"] },
      };
    }
    case "sql_variant":
      return { ok: false, reason: "sql_variant holds values of any type, and no single ClickHouse type matches it" };
    case "cursor":
    case "table":
      return { ok: false, reason: `${name} is not a type a stored column can have` };
    default:
      return { ok: false, reason: `the type ${name} is not a system type; user-defined alias types are not read` };
  }
}
