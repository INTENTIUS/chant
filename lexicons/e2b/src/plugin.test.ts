import { describe, expect, it } from "vitest";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import { e2bPlugin } from "./plugin";

describe("e2b plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(e2bPlugin)).toBe(true);
  });

  it("has the e2b name and serializer", () => {
    expect(e2bPlugin.name).toBe("e2b");
    expect(e2bPlugin.serializer.name).toBe("e2b");
    expect(e2bPlugin.serializer.rulePrefix).toBe("E2B");
  });

  it("ships lint rules and post-synth checks under the E2B prefix, every check catalogued", () => {
    expect((e2bPlugin.lintRules?.() ?? []).map((r) => r.id)).toEqual(["E2B001", "E2B002"]);
    const checks = (e2bPlugin.postSynthChecks?.() ?? []).map((c) => c.id);
    expect(checks).toEqual(["E2B011", "E2B012"]);
    for (const id of checks) expect(e2bPlugin.auditCatalog?.()[id]).toBeDefined();
  });

  it("keeps its op runtime and config namespace", () => {
    expect(e2bPlugin.opRuntime).toBeDefined();
    expect(e2bPlugin.configSchema?.safeParse({ profiles: { prod: { apiKey: { env: "E2B_API_KEY" }, template: "chant-steward" } }, defaultProfile: "prod" }).success).toBe(true);
  });

  it("registers completion, hover and docs", () => {
    expect(typeof e2bPlugin.completionProvider).toBe("function");
    expect(typeof e2bPlugin.hoverProvider).toBe("function");
    expect(typeof e2bPlugin.docs).toBe("function");
  });

  it("loads its skill with content", () => {
    const skills = e2bPlugin.skills?.() ?? [];
    expect(skills.map((s) => s.name)).toEqual(["chant-e2b-ops"]);
    expect(skills[0].content.length).toBeGreaterThan(500);
  });
});
