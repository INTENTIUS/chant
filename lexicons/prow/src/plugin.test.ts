import { describe, expect, it } from "vitest";
import { prowPlugin } from "./plugin";
import { isLexiconPlugin } from "@intentius/chant/lexicon";

describe("prow plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(prowPlugin)).toBe(true);
  });

  it("has the correct name", () => {
    expect(prowPlugin.name).toBe("prow");
  });

  it("has a serializer", () => {
    expect(prowPlugin.serializer).toBeDefined();
  });
});
