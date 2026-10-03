import { describe, expect, test } from "vitest";
import { carriesMarker, hasChantTrailerKey, isChantManaged, markerTrailer, readMarker, readTrailerPairs, stampedComment, stripMarker } from "./ownership";

describe("the comment trailer (#3208)", () => {
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

  test("carries extra pairs, encoded, after the marker's own", () => {
    const c = stampedComment("x", { stack: "s" }, { migration: "public.users", role: "new" });
    expect(c).toBe("x [chant managed-by=chant stack=s migration=public.users role=new]");
    expect(readTrailerPairs(c)?.get("migration")).toBe("public.users");
    expect(hasChantTrailerKey(c, ["migration"])).toBe(true);
    expect(hasChantTrailerKey(c, ["receipts"])).toBe(false);
    expect(() => markerTrailer(undefined, { "bad key": "v" })).toThrow(/not \[A-Za-z0-9._-\]\+/);
  });
});
