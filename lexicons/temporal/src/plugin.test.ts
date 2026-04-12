/**
 * Temporal plugin tests.
 */

import { describe, expect, it } from "vitest";
import { temporalPlugin } from "./plugin";
import { isLexiconPlugin } from "@intentius/chant/lexicon";

describe("temporal plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(temporalPlugin)).toBe(true);
  });

  it("has the correct name", () => {
    expect(temporalPlugin.name).toBe("temporal");
  });

  it("has a serializer with name 'temporal'", () => {
    expect(temporalPlugin.serializer).toBeDefined();
    expect(temporalPlugin.serializer.name).toBe("temporal");
  });

  it("lintRules() returns 2 rules (TMP001, TMP002)", () => {
    const rules = temporalPlugin.lintRules?.();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules?.length).toBe(2);
    const ids = rules?.map((r) => r.id).sort();
    expect(ids).toEqual(["TMP001", "TMP002"]);
  });

  it("mcpTools() returns 1 diff tool", () => {
    const tools = temporalPlugin.mcpTools?.();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools?.length).toBe(1);
    expect(tools?.[0].name).toBe("diff");
  });

  it("mcpResources() returns at least 2 resources including resource-catalog", () => {
    const resources = temporalPlugin.mcpResources?.();
    expect(Array.isArray(resources)).toBe(true);
    expect((resources?.length ?? 0)).toBeGreaterThanOrEqual(2);
    const uris = resources?.map((r) => r.uri);
    expect(uris).toContain("resource-catalog");
  });

  it("skills() returns 2 skill entries", () => {
    const skills = temporalPlugin.skills?.();
    expect(Array.isArray(skills)).toBe(true);
    expect(skills?.length).toBe(2);
  });

  it("skills include chant-temporal and chant-temporal-ops", () => {
    const skills = temporalPlugin.skills?.() ?? [];
    const names = skills.map((s) => s.name);
    expect(names).toContain("chant-temporal");
    expect(names).toContain("chant-temporal-ops");
  });

  describe("initTemplates", () => {
    it("default template returns src with temporal.ts", () => {
      const result = temporalPlugin.initTemplates?.();
      expect(result).toBeDefined();
      expect(result?.src).toBeDefined();
      expect(result?.src?.["temporal.ts"]).toBeDefined();
    });

    it("default template includes TemporalServer and TemporalNamespace imports", () => {
      const result = temporalPlugin.initTemplates?.();
      const src = result?.src?.["temporal.ts"] as string;
      expect(src).toContain("TemporalServer");
      expect(src).toContain("TemporalNamespace");
    });

    it("'cloud' template includes TemporalNamespace and SearchAttribute (no server)", () => {
      const result = temporalPlugin.initTemplates?.("cloud");
      const src = result?.src?.["temporal.ts"] as string;
      expect(src).toContain("TemporalNamespace");
      expect(src).toContain("SearchAttribute");
      expect(src).not.toContain("TemporalServer");
    });

    it("'full' template includes all 4 resource types", () => {
      const result = temporalPlugin.initTemplates?.("full");
      const src = result?.src?.["temporal.ts"] as string;
      expect(src).toContain("TemporalServer");
      expect(src).toContain("TemporalNamespace");
      expect(src).toContain("SearchAttribute");
      expect(src).toContain("TemporalSchedule");
    });

    it("'full' template uses mode: \"full\"", () => {
      const result = temporalPlugin.initTemplates?.("full");
      const src = result?.src?.["temporal.ts"] as string;
      expect(src).toContain('"full"');
    });
  });
});
