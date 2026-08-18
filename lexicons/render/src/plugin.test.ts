import { describe, expect, it } from "vitest";
import { renderPlugin } from "./plugin";
import { isLexiconPlugin } from "@intentius/chant/lexicon";

describe("render plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(renderPlugin)).toBe(true);
  });

  it("has the correct name and serializer", () => {
    expect(renderPlugin.name).toBe("render");
    expect(renderPlugin.serializer.name).toBe("render");
    expect(renderPlugin.serializer.rulePrefix).toBe("REN");
  });

  it("ships lint rules and post-synth checks under the REN prefix", () => {
    const rules = renderPlugin.lintRules?.() ?? [];
    const checks = renderPlugin.postSynthChecks?.() ?? [];
    expect(rules.map((r) => r.id)).toEqual(["REN001", "REN002", "REN003"]);
    expect(checks.map((c) => c.id)).toEqual(["REN010", "REN011", "REN012"]);
    for (const id of checks.map((c) => c.id)) {
      expect(renderPlugin.auditCatalog?.()[id]).toBeDefined();
    }
  });

  it("declares its ownership channel on the read path it implements", () => {
    expect(renderPlugin.ownershipChannel?.reads).toEqual(["describeResources"]);
    expect(typeof renderPlugin.describeResources).toBe("function");
    expect(renderPlugin.ownershipChannel?.keys.managedBy).toBe("CHANT_MANAGED_BY");
  });

  it("loads its skills with content", () => {
    const skills = renderPlugin.skills?.() ?? [];
    expect(skills.map((s) => s.name)).toEqual(["chant-render", "chant-render-patterns"]);
    for (const s of skills) expect(s.content.length).toBeGreaterThan(500);
  });

  it("detects its own serializer plan and nothing else", () => {
    expect(
      renderPlugin.detectTemplate?.({
        web: { kind: "WebService", entityType: "Render::Services::WebService", endpoint: "/services", method: "POST", name: "web", body: {} },
      }),
    ).toBe(true);
    expect(renderPlugin.detectTemplate?.({ Resources: {} })).toBe(false);
    expect(renderPlugin.detectTemplate?.([])).toBe(false);
  });

  it("offers init templates that mention the package", () => {
    for (const t of [undefined, "database", "static"]) {
      const set = renderPlugin.initTemplates?.(t);
      expect(set?.src["infra.ts"]).toContain("@intentius/chant-lexicon-render");
    }
  });
});
