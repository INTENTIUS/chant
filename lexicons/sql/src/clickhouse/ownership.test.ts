import { describe, expect, test } from "vitest";
import { carriesMarker, isChantManaged, markerTrailer, readMarker, stampedComment, stripMarker, stripMarkerFromStatement } from "./ownership";

describe("the comment marker (#3208)", () => {
  test("is appended to the declared comment, never in place of it", () => {
    expect(stampedComment("Raw events", { stack: "shop", env: "prod" })).toBe("Raw events [chant managed-by=chant stack=shop env=prod]");
    expect(stampedComment(undefined, undefined)).toBe("[chant managed-by=chant]");
    expect(stampedComment("Raw events [chant managed-by=chant stack=old]", { stack: "shop" })).toBe("Raw events [chant managed-by=chant stack=shop]");
  });

  test("reads back, and strips to the declared comment", () => {
    const c = stampedComment("a [b] c", { stack: "my shop", env: "prod]" });
    expect(readMarker(c)).toEqual({ managedBy: "chant", stack: "my shop", env: "prod]" });
    expect(stripMarker(c)).toBe("a [b] c");
    expect(isChantManaged(c)).toBe(true);
    expect(isChantManaged("a [b] c")).toBe(false);
    expect(markerTrailer({ stack: "it's" })).not.toContain("'");
  });

  test("matches this project's stack and env exactly", () => {
    const c = stampedComment("", { stack: "shop", env: "prod" });
    expect(carriesMarker(c, { stack: "shop", env: "prod" })).toBe(true);
    expect(carriesMarker(c, { stack: "shop" })).toBe(false);
    expect(carriesMarker(c, { stack: "other", env: "prod" })).toBe(false);
    expect(carriesMarker("Raw events", { stack: "shop", env: "prod" })).toBe(false);
  });

  test("comes off a printed statement, the whole clause when the comment was the marker alone", () => {
    expect(stripMarkerFromStatement("CREATE TABLE a.t\n(\n    `id` UInt64\n)\nENGINE = Log\nCOMMENT 'Raw [chant managed-by=chant stack=s]'")).toBe(
      "CREATE TABLE a.t\n(\n    `id` UInt64\n)\nENGINE = Log\nCOMMENT 'Raw'",
    );
    expect(stripMarkerFromStatement("CREATE VIEW a.v\n(\n    `id` UInt64\n)\nCOMMENT '[chant managed-by=chant]'\nAS SELECT id\nFROM a.t")).toBe(
      "CREATE VIEW a.v\n(\n    `id` UInt64\n)\nAS SELECT id\nFROM a.t",
    );
  });
});
