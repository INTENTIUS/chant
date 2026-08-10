import { describe, expect, it } from "vitest";
import { k3dPlugin } from "./plugin";
import { isLexiconPlugin } from "@intentius/chant/lexicon";

describe("k3d plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(k3dPlugin)).toBe(true);
  });

  it("has the correct name", () => {
    expect(k3dPlugin.name).toBe("k3d");
  });

  it("has a serializer", () => {
    expect(k3dPlugin.serializer).toBeDefined();
  });
});
