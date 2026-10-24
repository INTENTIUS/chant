import { describe, expect, test } from "vitest";
import { TYPE_FAMILIES } from "../generated/clickhouse";
import { numericParam, readType, typeTokens } from "../clickhouse/type-syntax";
import { mapType } from "./types";

/** [T-SQL name, arguments, ClickHouse type]: the maps that need no review. */
const MECHANICAL: Array<[string, Array<number | "max">, string]> = [
  ["nvarchar", [50], "String"],
  ["nvarchar", ["max"], "String"],
  ["varchar", [8], "String"],
  ["char", [2], "String"],
  ["nchar", [2], "String"],
  ["text", [], "String"],
  ["ntext", [], "String"],
  ["datetime2", [3], "DateTime64(3)"],
  ["datetime2", [], "DateTime64(7)"],
  ["bit", [], "Bool"],
  ["uniqueidentifier", [], "UUID"],
  ["decimal", [12, 4], "Decimal(12, 4)"],
  ["numeric", [10, 2], "Decimal(10, 2)"],
  ["decimal", [], "Decimal(18, 0)"],
  ["money", [], "Decimal(19, 4)"],
  ["smallmoney", [], "Decimal(10, 4)"],
  ["int", [], "Int32"],
  ["bigint", [], "Int64"],
  ["smallint", [], "Int16"],
  ["tinyint", [], "UInt8"],
  ["real", [], "Float32"],
  ["float", [], "Float64"],
  ["float", [24], "Float32"],
  ["float", [25], "Float64"],
  ["date", [], "Date32"],
  ["time", [3], "Time64(3)"],
  ["datetime", [], "DateTime64(3)"],
  ["smalldatetime", [], "DateTime64(0)"],
  ["varbinary", [16], "String"],
  ["image", [], "String"],
  ["json", [], "JSON"],
  ["sysname", [], "String"],
];

describe("mapType", () => {
  test.each(MECHANICAL)("%s(%j) is %s with no note", (name, args, expected) => {
    const m = mapType(name, args);
    expect(m).toMatchObject({ ok: true, type: expected });
    expect(m.ok && m.note).toBeFalsy();
  });

  test("a character type keeps its declared length for the review rules", () => {
    expect(mapType("nvarchar", [20])).toMatchObject({ maxLength: 20 });
    expect(mapType("nvarchar", ["max"])).not.toHaveProperty("maxLength");
  });

  test.each([
    ["datetimeoffset", [7], "DateTime64(7, 'UTC')", "offset"],
    ["xml", [], "String", "XML"],
    ["rowversion", [], "String", "counter"],
    ["timestamp", [], "String", "counter"],
    ["hierarchyid", [], "String", "hierarchy"],
    ["geography", [], "String", "spatial"],
    ["geometry", [], "String", "spatial"],
    ["vector", [3], "Array(Float32)", "3 dimensions"],
  ] as const)("%s is a judgment, with a note", (name, args, expected, evidence) => {
    const m = mapType(name, [...args]);
    expect(m).toMatchObject({ ok: true, type: expected });
    if (!m.ok) throw new Error("unreachable");
    expect(m.note?.message.length).toBeGreaterThan(0);
    expect(JSON.stringify(m.note).toLowerCase()).toContain(evidence.toLowerCase());
  });

  test.each(["sql_variant", "cursor", "table", "mytype"])("%s is refused with a reason", (name) => {
    const m = mapType(name, []);
    expect(m.ok).toBe(false);
    if (m.ok) throw new Error("unreachable");
    expect(m.reason).toContain(name);
  });
});

describe("every target type is in the pinned ClickHouse catalog", () => {
  const all = [...MECHANICAL.map(([n, a]) => mapType(n, a)), mapType("datetimeoffset", [7]), mapType("vector", [3]), mapType("xml", [])];

  test("each type's family exists in TYPE_FAMILIES, and its precision is in range", () => {
    for (const m of all) {
      if (!m.ok) throw new Error("unreachable");
      const t = readType(typeTokens(m.type)!)!;
      const family = t.words.map((w) => w.text).join(" ");
      expect(family in TYPE_FAMILIES, `${m.type}: ${family}`).toBe(true);
      const params = (t.params ?? []).map(numericParam);
      if (family === "DateTime64" || family === "Time64") expect(params[0]).toBeGreaterThanOrEqual(0), expect(params[0]).toBeLessThanOrEqual(9);
      if (family === "Decimal") {
        expect(params[0]).toBeGreaterThanOrEqual(1);
        expect(params[0]).toBeLessThanOrEqual(76);
        expect(params[1]).toBeLessThanOrEqual(params[0]!);
      }
    }
  });

  test("the largest SQL Server scale and precision fit: datetime2(7), decimal(38, s)", () => {
    expect(mapType("datetime2", [7])).toMatchObject({ type: "DateTime64(7)" });
    expect(mapType("decimal", [38, 38])).toMatchObject({ type: "Decimal(38, 38)" });
  });
});
