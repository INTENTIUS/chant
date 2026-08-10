import { describe, expect, it } from "vitest";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import { cedarPlugin } from "./plugin";
import { cedarSerializer } from "./serializer";

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
});
