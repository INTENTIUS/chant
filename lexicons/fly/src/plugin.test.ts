import { describe, expect, it } from "vitest";
import { flyPlugin } from "./plugin";
import { isLexiconPlugin } from "@intentius/chant/lexicon";

describe("fly plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(flyPlugin)).toBe(true);
  });

  it("has the correct name", () => {
    expect(flyPlugin.name).toBe("fly");
  });

  it("has a serializer", () => {
    expect(flyPlugin.serializer).toBeDefined();
  });
});
