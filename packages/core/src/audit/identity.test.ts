import { describe, test, expect } from "vitest";
import { findingIdentities } from "./identity";

const f = (over: Partial<Parameters<typeof findingIdentities>[0][number]> = {}) => ({ checkId: "R1", file: "a.yaml", ...over });

describe("findingIdentities (#5106)", () => {
  test("is the same for the same inputs and differs per input", () => {
    const base = findingIdentities([f({ entity: "x", locator: "Deployment/containers[0]" })])[0];
    expect(findingIdentities([f({ entity: "x", locator: "Deployment/containers[0]" })])[0]).toBe(base);
    for (const other of [f({ entity: "y", locator: "Deployment/containers[0]" }), f({ entity: "x", locator: "Deployment/containers[1]" }), f({ entity: "x" }), f({ checkId: "R2", entity: "x", locator: "Deployment/containers[0]" }), f({ file: "b.yaml", entity: "x", locator: "Deployment/containers[0]" })]) {
      expect(findingIdentities([other])[0]).not.toBe(base);
    }
  });

  test("findings that agree on every input are told apart by their order", () => {
    const [a, b] = findingIdentities([f({ entity: "x" }), f({ entity: "x" })]);
    expect(a).not.toBe(b);
    expect(findingIdentities([f({ entity: "x" }), f({ entity: "x" })])).toEqual([a, b]);
  });

  test("a finding keeps its identity when findings of other keys come before it", () => {
    const [alone] = findingIdentities([f({ entity: "x" })]);
    const [, after] = findingIdentities([f({ entity: "other" }), f({ entity: "x" })]);
    expect(after).toBe(alone);
  });

  test("a secret is told apart by its fingerprint, not by line", () => {
    const [a, b] = findingIdentities([f({ fingerprint: "aaaa" }), f({ fingerprint: "bbbb" })]);
    expect(a).not.toBe(b);
  });
});
