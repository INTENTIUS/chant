import { describe, expect, test } from "vitest";
import { isChantWorkingObject, isRebuildObject, stampedComment, stripMarkerFromStatement } from "./ownership";

describe("the comment marker on ClickHouse (#3208)", () => {
  test("comes off a printed statement, the whole clause when the comment was the marker alone", () => {
    expect(stripMarkerFromStatement("CREATE TABLE a.t\n(\n    `id` UInt64\n)\nENGINE = Log\nCOMMENT 'Raw [chant managed-by=chant stack=s]'")).toBe(
      "CREATE TABLE a.t\n(\n    `id` UInt64\n)\nENGINE = Log\nCOMMENT 'Raw'",
    );
    expect(stripMarkerFromStatement("CREATE VIEW a.v\n(\n    `id` UInt64\n)\nCOMMENT '[chant managed-by=chant]'\nAS SELECT id\nFROM a.t")).toBe(
      "CREATE VIEW a.v\n(\n    `id` UInt64\n)\nAS SELECT id\nFROM a.t",
    );
  });

  test("marks a rebuild's working objects and the receipts table as chant's own", () => {
    expect(isRebuildObject(stampedComment("", { stack: "s" }, { rebuild: "db.t", role: "new" }))).toBe(true);
    expect(isChantWorkingObject(stampedComment("", { stack: "s" }, { receipts: "effects" }))).toBe(true);
    expect(isChantWorkingObject(stampedComment("Raw", { stack: "s" }))).toBe(false);
    expect(isChantWorkingObject("Raw [chant managed-by=someone-else rebuild=db.t]")).toBe(false);
  });
});
