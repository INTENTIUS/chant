import { describe, expect, it } from "vitest";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import { cplnPlugin } from "./plugin";
import { cplnAuditCatalog } from "./lint/audit-catalog";
import { KINDS } from "./kinds";

describe("cpln plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(cplnPlugin)).toBe(true);
  });

  it("has the correct name and serializer", () => {
    expect(cplnPlugin.name).toBe("cpln");
    expect(cplnPlugin.serializer.name).toBe("cpln");
    expect(cplnPlugin.serializer.rulePrefix).toBe("CPL");
  });

  it("registers lint rules and post-synth checks", () => {
    expect(cplnPlugin.lintRules?.()?.length).toBeGreaterThan(0);
    expect(cplnPlugin.postSynthChecks?.()?.length).toBeGreaterThanOrEqual(15);
  });

  it("gives every rule an id under the declared prefix", () => {
    // Ids must not collide when lexicons load together, which is what the
    // prefix is for. A stray id here is invisible until two lexicons meet.
    const prefixes = [cplnPlugin.serializer.rulePrefix, ...(cplnPlugin.serializer.extraRulePrefixes ?? [])];
    const ids = [
      ...(cplnPlugin.lintRules?.() ?? []).map((rule) => rule.id),
      ...(cplnPlugin.postSynthChecks?.() ?? []).map((check) => check.id),
    ];

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(prefixes.some((prefix) => id.startsWith(prefix)), `${id} is outside ${prefixes.join("/")}`).toBe(true);
    }
  });

  it("has no duplicate rule ids", () => {
    const ids = [
      ...(cplnPlugin.lintRules?.() ?? []).map((rule) => rule.id),
      ...(cplnPlugin.postSynthChecks?.() ?? []).map((check) => check.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every registered check in the audit catalog", () => {
    // A check with no catalog entry contributes nothing to `chant audit`, and
    // does so silently — which is exactly the failure mode this asserts away.
    const ids = [
      ...(cplnPlugin.lintRules?.() ?? []).map((rule) => rule.id),
      ...(cplnPlugin.postSynthChecks?.() ?? []).map((check) => check.id),
    ];

    for (const id of ids) {
      expect(cplnAuditCatalog[id], `${id} has no audit catalog entry`).toBeDefined();
    }
  });

  it("has no audit catalog entry without a check", () => {
    const ids = new Set([
      ...(cplnPlugin.lintRules?.() ?? []).map((rule) => rule.id),
      ...(cplnPlugin.postSynthChecks?.() ?? []).map((check) => check.id),
    ]);

    for (const id of Object.keys(cplnAuditCatalog)) {
      expect(ids.has(id), `${id} is catalogued but not registered`).toBe(true);
    }
  });

  it("registers LSP providers", () => {
    // Registration is what `chant serve lsp` dispatches through — a file in
    // src/lsp/ that nothing registers is unreachable in an editor.
    expect(typeof cplnPlugin.completionProvider).toBe("function");
    expect(typeof cplnPlugin.hoverProvider).toBe("function");
  });

  it("registers docs, detection and init templates", () => {
    expect(typeof cplnPlugin.docs).toBe("function");
    expect(typeof cplnPlugin.detectTemplate).toBe("function");
    expect(typeof cplnPlugin.initTemplates).toBe("function");
  });

  it("ships at least three skills, each with content", () => {
    const skills = cplnPlugin.skills?.() ?? [];
    expect(skills.length).toBeGreaterThanOrEqual(3);
    for (const skill of skills) {
      expect(skill.content.length, `${skill.name} loaded empty`).toBeGreaterThan(0);
      expect(skill.description.length).toBeGreaterThan(0);
    }
  });

  it("ships at least three init templates that differ", () => {
    const names = ["default", "secrets", "stateful"];
    const sources = names.map((name) => cplnPlugin.initTemplates?.(name)?.src["infra.ts"] ?? "");
    for (const source of sources) expect(source.length).toBeGreaterThan(0);
    expect(new Set(sources).size).toBe(names.length);
  });

  it("namespaces MCP tools and resources under `cpln`", () => {
    for (const tool of cplnPlugin.mcpTools?.() ?? []) {
      expect(tool.name.startsWith("cpln:")).toBe(true);
    }
    for (const resource of cplnPlugin.mcpResources?.() ?? []) {
      expect(resource.uri.startsWith("cpln:")).toBe(true);
    }
  });

  it("declares an ownership channel whose read paths it implements", () => {
    const channel = cplnPlugin.ownershipChannel;
    expect(channel).toBeDefined();
    expect(channel!.keys.managedBy).toBe("chant.intentius.io/managed-by");
    expect(channel!.keys.stack).toBeTruthy();
    expect(channel!.keys.env).toBeTruthy();

    // Declaring a path the plugin cannot resolve a verdict on would be a lie
    // the completeness checker cannot catch.
    expect(channel!.reads).toContain("describeResources");
    expect(typeof cplnPlugin.describeResources).toBe("function");
    for (const path of channel!.reads) {
      if (path === "observeResourcesDeep") expect(cplnPlugin.observeResourcesDeep).toBeDefined();
      if (path === "exportResources") expect(cplnPlugin.exportResources).toBeDefined();
    }
  });

  it("declares reference-catalog identities for every modelled kind", () => {
    const identities = new Set(cplnPlugin.referenceCatalog?.identities.map((entry) => entry.kind));
    for (const kind of KINDS) {
      expect(identities.has(kind.typeName), `${kind.typeName} has no identity rule`).toBe(true);
    }
  });
});
