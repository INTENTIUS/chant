import { describe, test, expect } from "vitest";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import { defaultTags, isDefaultTags, DEFAULT_TAGS_MARKER } from "./default-tags";

describe("defaultTags", () => {
  test("factory returns correct markers and tags", () => {
    const tags = defaultTags([
      { Key: "Env", Value: "prod" },
      { Key: "Team", Value: "platform" },
    ]);

    expect(tags[DEFAULT_TAGS_MARKER]).toBe(true);
    expect(tags[DECLARABLE_MARKER]).toBe(true);
    expect(tags.lexicon).toBe("aws");
    expect(tags.entityType).toBe("chant:aws:defaultTags");
    expect(tags.tags).toHaveLength(2);
    expect(tags.tags[0]).toEqual({ Key: "Env", Value: "prod" });
    expect(tags.tags[1]).toEqual({ Key: "Team", Value: "platform" });
  });

  test("factory accepts empty tags array", () => {
    const tags = defaultTags([]);
    expect(tags.tags).toHaveLength(0);
  });

  test("isDefaultTags returns true for DefaultTags", () => {
    const tags = defaultTags([{ Key: "k", Value: "v" }]);
    expect(isDefaultTags(tags)).toBe(true);
  });

  test("isDefaultTags returns false for non-DefaultTags", () => {
    expect(isDefaultTags(null)).toBe(false);
    expect(isDefaultTags(undefined)).toBe(false);
    expect(isDefaultTags({})).toBe(false);
    expect(isDefaultTags("string")).toBe(false);
    expect(isDefaultTags({ lexicon: "aws" })).toBe(false);
  });
});
