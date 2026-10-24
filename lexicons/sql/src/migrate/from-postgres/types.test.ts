import { describe, expect, test } from "vitest";
import { TYPE_FAMILIES } from "../../generated/clickhouse";
import { numericParam, readType, typeTokens } from "../../clickhouse/type-syntax";
import { mapPostgresType, parseType } from "./types";

/** [Postgres type as written, ClickHouse type]: the maps that need no review. */
const MECHANICAL: Array<[string, string]> = [
  ["bigint", "Int64"],
  ["int8", "Int64"],
  ["integer", "Int32"],
  ["int", "Int32"],
  ["smallint", "Int16"],
  ["text", "String"],
  ["varchar(40)", "String"],
  ["character varying(255)", "String"],
  ["citext", "String"],
  ["bytea", "String"],
  ["numeric(12, 2)", "Decimal(12, 2)"],
  ["decimal(10)", "Decimal(10, 0)"],
  ["uuid", "UUID"],
  ["boolean", "Bool"],
  ["bool", "Bool"],
  ["jsonb", "JSON"],
  ["json", "JSON"],
  ["real", "Float32"],
  ["double precision", "Float64"],
  ["float(24)", "Float32"],
  ["float(53)", "Float64"],
  ["date", "Date32"],
  ["time", "Time64(6)"],
  ["timestamp", "DateTime64(6)"],
  ["timestamp(3) without time zone", "DateTime64(3)"],
  ["timestamptz", "DateTime64(6, 'UTC')"],
  ["timestamp with time zone", "DateTime64(6, 'UTC')"],
  ["timestamptz(3)", "DateTime64(3, 'UTC')"],
  ["oid", "UInt32"],
  ["pg_catalog.int4", "Int32"],
  ['"int8"', "Int64"],
];

describe("mapPostgresType", () => {
  test.each(MECHANICAL)("%s is %s with no note", (type, expected) => {
    const m = mapPostgresType(type);
    expect(m.type).toBe(expected);
    expect(m.note).toBeUndefined();
  });

  test("a character type keeps its declared length for the review rules", () => {
    expect(mapPostgresType("varchar(20)").maxLength).toBe(20);
    expect(mapPostgresType("text").maxLength).toBeUndefined();
  });

  test.each([
    ["numeric", "Decimal(38, 18)", "no precision"],
    ["numeric(100, 2)", "Decimal(76, 38)", "76 digits"],
    ["money", "Decimal(19, 2)", "lc_monetary"],
    ["char(8)", "String", "pads"],
    ["interval", "String", "Interval"],
    ["timetz", "String", "offset"],
    ["inet", "IPv6", "prefix"],
    ["xml", "String", "xml"],
    ["tsvector", "String", "tsvector"],
    ["mood", "String", "not a built-in type"],
    ["shop.status", "String", "not a built-in type"],
  ])("%s is a judgment: %s, with a note naming %s", (type, expected, evidence) => {
    const m = mapPostgresType(type);
    expect(m.type).toBe(expected);
    expect(JSON.stringify(m.note).toLowerCase()).toContain(evidence.toLowerCase());
  });

  test("serial types are integers with the serial flag", () => {
    expect(mapPostgresType("serial")).toMatchObject({ type: "Int32", serial: true });
    expect(mapPostgresType("bigserial")).toMatchObject({ type: "Int64", serial: true });
    expect(mapPostgresType("smallserial")).toMatchObject({ type: "Int16", serial: true });
  });

  test("an array is Array(T) with a note that it cannot be Nullable; a nested one nests", () => {
    for (const written of ["text[]", "text ARRAY", "text[3]"]) {
      const m = mapPostgresType(written);
      expect(m, written).toMatchObject({ type: "Array(String)", array: true });
      expect(JSON.stringify(m.note)).toContain("Nullable");
    }
    expect(mapPostgresType("integer[][]").type).toBe("Array(Array(Int32))");
    expect(mapPostgresType("timestamptz[]").type).toBe("Array(DateTime64(6, 'UTC'))");
  });
});

describe("parseType", () => {
  test("splits words, arguments and dimensions", () => {
    expect(parseType("Timestamp(3) With Time Zone")).toMatchObject({ base: "timestamp with time zone", args: [3], dims: 0 });
    expect(parseType("numeric(12, 2)[]")).toMatchObject({ base: "numeric", args: [12, 2], dims: 1 });
  });
});

describe("every target type is in the pinned ClickHouse catalog", () => {
  const written = [...MECHANICAL.map(([t]) => t), "numeric", "money", "inet", "text[]", "integer[][]", "timestamptz(6)", "timestamp(0)"];

  test("each type's family exists in TYPE_FAMILIES, and its precision is in range", () => {
    for (const w of written) {
      const m = mapPostgresType(w);
      const t = readType(typeTokens(m.type)!)!;
      const family = t.words.map((x) => x.text).join(" ");
      expect(family in TYPE_FAMILIES, `${w} -> ${m.type}: ${family}`).toBe(true);
      const params = (t.params ?? []).map(numericParam);
      if (family === "DateTime64" || family === "Time64") {
        expect(params[0]).toBeGreaterThanOrEqual(0);
        expect(params[0]).toBeLessThanOrEqual(9);
      }
      if (family === "Decimal") {
        expect(params[0]).toBeGreaterThanOrEqual(1);
        expect(params[0]).toBeLessThanOrEqual(76);
        expect(params[1]).toBeLessThanOrEqual(params[0]!);
      }
    }
  });
});
