import { describe, expect, it } from "bun:test";
import { slurmPlugin } from "./plugin";
import { isLexiconPlugin } from "@intentius/chant/lexicon";

describe("slurm plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(slurmPlugin)).toBe(true);
  });

  it("has the correct name", () => {
    expect(slurmPlugin.name).toBe("slurm");
  });

  it("has a serializer", () => {
    expect(slurmPlugin.serializer).toBeDefined();
  });
});
