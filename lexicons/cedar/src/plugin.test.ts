import { describe, expect, it } from "vitest";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import { cedarPlugin } from "./plugin";
import { cedarSerializer, CEDAR_POLICY_TYPE } from "./serializer";
import { AVP_OWNERSHIP_KEYS } from "./avp/ownership";

describe("cedar plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(cedarPlugin)).toBe(true);
  });

  it("is named after the lexicon", () => {
    expect(cedarPlugin.name).toBe("cedar");
  });

  it("exposes the cedar serializer", () => {
    expect(cedarPlugin.serializer).toBe(cedarSerializer);
    expect(cedarPlugin.serializer?.rulePrefix).toBe("CED");
  });

  it("registers the lifecycle methods core dispatches through", () => {
    for (const method of ["generate", "validate", "coverage", "package", "docs"] as const) {
      expect(typeof cedarPlugin[method], method).toBe("function");
    }
  });

  it("registers the LSP providers", () => {
    expect(typeof cedarPlugin.completionProvider).toBe("function");
    expect(typeof cedarPlugin.hoverProvider).toBe("function");
  });

  it("declares at least one lint rule, all under the CED prefix", () => {
    const rules = cedarPlugin.lintRules?.() ?? [];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.id.startsWith("CED"), rule.id).toBe(true);
    }
  });

  it("registers the agent-facing extensions", () => {
    for (const method of ["skills", "mcpTools", "mcpResources", "initTemplates"] as const) {
      expect(typeof cedarPlugin[method], method).toBe("function");
    }
  });

  it("ships three skills whose frontmatter matches their registered name", () => {
    const skills = cedarPlugin.skills?.() ?? [];
    expect(skills).toHaveLength(3);

    for (const skill of skills) {
      // An empty body means the loader could not read the file — the skill
      // registers, `chant init` copies nothing, and no test would notice.
      expect(skill.content.length, `${skill.name} has no content`).toBeGreaterThan(0);
      expect(skill.content).toContain(`skill: ${skill.name}`);
      expect(skill.content).toContain("user-invocable: true");
      expect(skill.description.length).toBeGreaterThan(0);
    }

    expect(skills.map((s) => s.name).sort()).toEqual([
      "chant-cedar-authoring",
      "chant-cedar-avp-embedding",
      "chant-cedar-meta-policy",
    ]);
  });

  it("contributes the conventional MCP pair plus the cedar-specific tool", () => {
    expect(cedarPlugin.mcpTools?.().map((t) => t.name)).toEqual(["cedar:diff", "coverage"]);
    expect(cedarPlugin.mcpResources?.().map((r) => r.uri)).toEqual(["cedar:resource-catalog"]);
  });

  it("scaffolds three distinct init templates", () => {
    const names = ["default", "avp-embedding", "gateway-policy-set"] as const;
    const sets = names.map((n) => cedarPlugin.initTemplates?.(n));

    for (const set of sets) {
      expect(set?.src["policies.ts"]).toContain("export const");
      expect(set?.root?.["schema.cedarschema"]).toContain("namespace ");
    }
    expect(new Set(sets.map((s) => s?.src["policies.ts"])).size).toBe(3);
  });

  // ── AVP lifecycle (#1652) ────────────────────────────────────

  it("registers the AVP lifecycle readers", () => {
    for (const method of ["describeResources", "ambientKinds", "observeAmbient", "exportResources"] as const) {
      expect(typeof cedarPlugin[method], method).toBe("function");
    }
  });

  it("declares an ownership channel with complete keys", () => {
    const channel = cedarPlugin.ownershipChannel;
    expect(channel).toBeDefined();
    expect(channel!.keys).toEqual(AVP_OWNERSHIP_KEYS);
    for (const key of ["managedBy", "stack", "env"] as const) {
      expect(typeof channel!.keys[key], key).toBe("string");
      expect(channel!.keys[key].length).toBeGreaterThan(0);
    }
  });

  it("declares a marker channel only on the paths it implements (chant #1348)", () => {
    const channel = cedarPlugin.ownershipChannel!;
    expect([...channel.reads].sort()).toEqual(["describeResources", "exportResources"]);
    for (const path of channel.reads) {
      expect(typeof cedarPlugin[path], path).toBe("function");
    }
    // Not declared, because it is not implemented — the whole point of the
    // per-path declaration is that a caller learns this before asking.
    expect(channel.reads).not.toContain("observeResourcesDeep");
    expect(cedarPlugin.observeResourcesDeep).toBeUndefined();
  });

  it("can enumerate the one kind it deploys", () => {
    expect(cedarPlugin.ambientKinds?.()).toEqual([CEDAR_POLICY_TYPE]);
  });
});
