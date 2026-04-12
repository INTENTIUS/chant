import { describe, test, expect } from "vitest";
import {
  defaultTags,
  isDefaultTags,
  DEFAULT_TAGS_MARKER,
} from "./default-tags";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";

describe("defaultTags", () => {
  test("returns object with correct markers", () => {
    const dt = defaultTags([{ key: "env", value: "prod" }]);
    expect(dt[DEFAULT_TAGS_MARKER]).toBe(true);
    expect(dt[DECLARABLE_MARKER]).toBe(true);
  });

  test("has lexicon azure", () => {
    const dt = defaultTags([{ key: "env", value: "prod" }]);
    expect(dt.lexicon).toBe("azure");
  });

  test("has correct entityType", () => {
    const dt = defaultTags([{ key: "env", value: "prod" }]);
    expect(dt.entityType).toBe("chant:azure:defaultTags");
  });

  test("tags are accessible", () => {
    const dt = defaultTags([
      { key: "env", value: "prod" },
      { key: "team", value: "backend" },
    ]);
    expect(dt.tags).toHaveLength(2);
    expect(dt.tags[0].key).toBe("env");
    expect(dt.tags[0].value).toBe("prod");
    expect(dt.tags[1].key).toBe("team");
    expect(dt.tags[1].value).toBe("backend");
  });

  test("empty tags allowed", () => {
    const dt = defaultTags([]);
    expect(dt.tags).toHaveLength(0);
  });
});

describe("isDefaultTags", () => {
  test("returns true for defaultTags result", () => {
    expect(isDefaultTags(defaultTags([{ key: "env", value: "prod" }]))).toBe(true);
  });

  test("returns false for null", () => {
    expect(isDefaultTags(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isDefaultTags(undefined)).toBe(false);
  });

  test("returns false for regular objects", () => {
    expect(isDefaultTags({ tags: [{ key: "env", value: "prod" }] })).toBe(false);
  });

  test("returns false for non-object values", () => {
    expect(isDefaultTags("string")).toBe(false);
    expect(isDefaultTags(42)).toBe(false);
    expect(isDefaultTags(true)).toBe(false);
  });
});
