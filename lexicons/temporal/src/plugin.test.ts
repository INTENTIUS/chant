/**
 * Temporal plugin tests.
 */

import { describe, expect, it } from "vitest";
import { temporalPlugin } from "./plugin";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";

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

  it("postSynthChecks() returns 7 checks (TMP001, TMP002, TMP010, TMP011, TMP012, TMP013, TMP014)", () => {
    const checks = temporalPlugin.postSynthChecks?.();
    expect(Array.isArray(checks)).toBe(true);
    const ids = checks?.map((c) => c.id).sort();
    expect(ids).toEqual(["TMP001", "TMP002", "TMP010", "TMP011", "TMP012", "TMP013", "TMP014"]);
  });

  it("lintRules() returns 1 rule (TMP020)", () => {
    const rules = temporalPlugin.lintRules?.();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules?.map((r) => r.id)).toEqual(["TMP020"]);
  });

  it("completionProvider() returns Temporal resource completions", () => {
    const ctx: CompletionContext = {
      uri: "file:///t.ts",
      content: "const ns = new TemporalNamespace",
      position: { line: 0, character: 33 },
      wordAtCursor: "TemporalNamespace",
      linePrefix: "const ns = new TemporalNamespace",
    };
    const items = temporalPlugin.completionProvider?.(ctx);
    expect(items?.some((i) => i.label === "TemporalNamespace")).toBe(true);
  });

  it("hoverProvider() returns Temporal resource hover info", () => {
    const ctx: HoverContext = {
      uri: "file:///t.ts",
      content: "",
      position: { line: 0, character: 0 },
      word: "TemporalSchedule",
      lineText: "",
    };
    const info = temporalPlugin.hoverProvider?.(ctx);
    expect(info?.contents).toContain("Temporal::Schedule");
  });

  it("mcpTools() returns 1 diff tool", () => {
    const tools = temporalPlugin.mcpTools?.();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools?.length).toBe(1);
    expect(tools?.[0].name).toBe("temporal:diff");
  });

  it("mcpResources() returns at least 2 resources including resource-catalog", () => {
    const resources = temporalPlugin.mcpResources?.();
    expect(Array.isArray(resources)).toBe(true);
    expect((resources?.length ?? 0)).toBeGreaterThanOrEqual(2);
    const uris = resources?.map((r) => r.uri);
    expect(uris).toContain("temporal:resource-catalog");
  });

  it("skills() returns 2 skill entries", () => {
    const skills = temporalPlugin.skills?.();
    expect(Array.isArray(skills)).toBe(true);
    expect(skills?.length).toBe(2);
  });

  it("skills include chant-temporal and chant-temporal-ops (sprites moved to fly)", () => {
    const skills = temporalPlugin.skills?.() ?? [];
    const names = skills.map((s) => s.name);
    expect(names).toContain("chant-temporal");
    expect(names).toContain("chant-temporal-ops");
    // Sprites are a Fly product — the chant-fly-sprites skill lives in the fly lexicon.
    expect(names).not.toContain("chant-temporal-sprites");
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
