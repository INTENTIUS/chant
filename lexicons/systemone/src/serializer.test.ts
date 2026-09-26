import { describe, expect, it } from "vitest";
import { systemoneSerializer } from "./serializer";

describe("systemone serializer", () => {
  it("has the contract's two required members", () => {
    expect(systemoneSerializer.name).toBe("systemone");
    expect(systemoneSerializer.rulePrefix).toBe("SYS");
  });

  it("emits nothing: the lexicon declares no resources", () => {
    expect(systemoneSerializer.serialize(new Map())).toBe("");
  });
});
