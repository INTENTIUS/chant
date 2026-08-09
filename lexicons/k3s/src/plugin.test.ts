import { describe, expect, it } from "vitest";
import { k3sPlugin } from "./plugin";
import { isLexiconPlugin } from "@intentius/chant/lexicon";

describe("k3s plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(k3sPlugin)).toBe(true);
  });

  it("has the correct name", () => {
    expect(k3sPlugin.name).toBe("k3s");
  });

  it("has a serializer", () => {
    expect(k3sPlugin.serializer).toBeDefined();
  });
});
