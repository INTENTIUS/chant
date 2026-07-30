import { describe, expect, it } from "vitest";
import { fountainPlugin } from "./plugin";
import { isLexiconPlugin } from "@intentius/chant/lexicon";

describe("fountain plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(fountainPlugin)).toBe(true);
  });

  it("has the correct name", () => {
    expect(fountainPlugin.name).toBe("fountain");
  });

  it("has a serializer", () => {
    expect(fountainPlugin.serializer).toBeDefined();
  });
});
