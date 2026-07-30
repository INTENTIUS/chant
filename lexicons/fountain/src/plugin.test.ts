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

  it("namespaces its MCP tool so it can load beside other lexicons", () => {
    const tools = fountainPlugin.mcpTools?.() ?? [];
    expect(tools.map((t) => t.name)).toEqual(["fountain:diff"]);
  });

  it("serves the resource catalog over MCP", async () => {
    const resources = fountainPlugin.mcpResources?.() ?? [];
    expect(resources.map((r) => r.uri)).toEqual(["fountain:resource-catalog"]);

    const catalog = JSON.parse(await resources[0].handler()) as Array<{
      className: string;
      kind: string;
    }>;
    const resourceKinds = catalog.filter((e) => e.kind === "resource").map((e) => e.className);
    expect(resourceKinds.sort()).toEqual(["Agent", "Environment", "Vault"]);
  });

  it("exposes every post-synth check and lint rule", () => {
    expect(fountainPlugin.lintRules?.()).toHaveLength(1);
    expect(fountainPlugin.postSynthChecks?.()).toHaveLength(8);
  });

  it("carries audit metadata for every rule it ships", () => {
    const catalog = fountainPlugin.auditCatalog?.() ?? {};
    const ruleIds = [
      ...(fountainPlugin.lintRules?.() ?? []).map((r) => r.id),
      ...(fountainPlugin.postSynthChecks?.() ?? []).map((c) => c.id),
    ];

    expect(ruleIds.sort()).toEqual(Object.keys(catalog).sort());
  });

  it("marks its checks entity-based so audit does not claim they fire on YAML", () => {
    const catalog = fountainPlugin.auditCatalog?.() ?? {};
    // Every fountain check reads ctx.entities, so none can fire against
    // standalone fountain YAML. Flipping one to true would misreport it.
    expect(Object.values(catalog).every((m) => m.yamlBased === false)).toBe(true);
  });

  it("scaffolds a closed sandbox by default", () => {
    const def = fountainPlugin.initTemplates?.()?.src["fountain.ts"] ?? "";
    expect(def).toContain("ConciergeStack");

    const open = fountainPlugin.initTemplates?.("open")?.src["fountain.ts"] ?? "";
    expect(open).toContain("networking_type");
    expect(open).not.toContain("ConciergeStack");
  });

  it("loads all three skills", () => {
    expect(fountainPlugin.skills?.().map((s) => s.name).sort()).toEqual([
      "chant-fountain",
      "chant-fountain-locked-sandboxes",
      "chant-fountain-secrets",
    ]);
  });
});
