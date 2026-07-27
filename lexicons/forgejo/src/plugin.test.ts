/**
 * Forgejo plugin tests.
 */

import { describe, expect, it } from "vitest";
import { forgejoPlugin } from "./plugin";
import { githubPlugin } from "@intentius/chant-lexicon-github";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import type { CompletionContext, HoverContext } from "@intentius/chant/lsp/types";

describe("forgejo plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(forgejoPlugin)).toBe(true);
  });

  it("has the correct name", () => {
    expect(forgejoPlugin.name).toBe("forgejo");
  });

  it("has a serializer (name 'github' — serializes reused github entities)", () => {
    expect(forgejoPlugin.serializer).toBeDefined();
    expect(forgejoPlugin.serializer.name).toBe("github");
  });

  it("postSynthChecks() returns the WFJ checks", () => {
    const checks = forgejoPlugin.postSynthChecks?.();
    expect(Array.isArray(checks)).toBe(true);
    const ids = checks?.map((c) => c.id).sort();
    expect(ids).toEqual(["WFJ010", "WFJ011"]);
  });

  it("lintRules() wraps github's lint rules under a WFJ- namespace (no id collision)", () => {
    const rules = forgejoPlugin.lintRules?.() ?? [];
    const githubRules = githubPlugin.lintRules?.() ?? [];
    expect(rules.length).toBe(githubRules.length);
    expect(rules.map((r) => r.id)).toEqual(githubRules.map((r) => `WFJ-${r.id}`));
    // Same check() behavior — only the id changes, so forgejo and github can
    // load together (e.g. `chant audit`) without loadPlugins' cross-lexicon
    // rule-id conflict check rejecting the pair.
    expect(rules.map((r) => r.check)).toEqual(githubRules.map((r) => r.check));
  });

  it("completionProvider() delegates to github's completions", () => {
    const ctx: CompletionContext = {
      uri: "file:///t.ts",
      content: "const j = new Job",
      position: { line: 0, character: 18 },
      wordAtCursor: "Job",
      linePrefix: "const j = new Job",
    };
    const items = forgejoPlugin.completionProvider?.(ctx);
    expect(items?.some((i) => i.label === "Job")).toBe(true);
  });

  it("hoverProvider() delegates to github's hover info", () => {
    const ctx: HoverContext = {
      uri: "file:///t.ts",
      content: "",
      position: { line: 0, character: 0 },
      word: "Job",
      lineText: "",
    };
    const info = forgejoPlugin.hoverProvider?.(ctx);
    expect(info?.contents).toContain("GitHub::Actions::Job");
  });

  it("detectTemplate() recognizes github-actions-shaped data", () => {
    expect(forgejoPlugin.detectTemplate?.({ on: {}, jobs: {} })).toBe(true);
    expect(forgejoPlugin.detectTemplate?.({ build: { "runs-on": "ubuntu-latest" } })).toBe(true);
    expect(forgejoPlugin.detectTemplate?.({})).toBe(false);
    expect(forgejoPlugin.detectTemplate?.(null)).toBe(false);
  });

  it("migrationSource('github') detects a github workflow and rejects unrelated content", () => {
    const src = forgejoPlugin.migrationSource?.("github");
    expect(src).toBeDefined();
    expect(src?.detect("on:\n  push: {}\njobs:\n  build:\n    runs-on: ubuntu-latest\n")).toBe(true);
    expect(src?.detect("just some text")).toBe(false);
  });

  it("migrationSource() returns undefined for an unknown source", () => {
    expect(forgejoPlugin.migrationSource?.("gitlab")).toBeUndefined();
  });

  it("mcpTools() includes the diff tool and context tools", () => {
    const tools = forgejoPlugin.mcpTools?.();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools?.some((t) => t.name === "forgejo:diff")).toBe(true);
    expect(tools!.length).toBeGreaterThan(1);
  });

  it("skills() returns chant-forgejo", () => {
    const skills = forgejoPlugin.skills?.();
    expect(skills?.map((s) => s.name)).toContain("chant-forgejo");
  });

  describe("initTemplates", () => {
    it("default template returns src with pipeline.ts", () => {
      const result = forgejoPlugin.initTemplates?.();
      expect(result?.src?.["pipeline.ts"]).toBeDefined();
      expect(result?.src?.["pipeline.ts"]).toContain("@intentius/chant-lexicon-forgejo");
    });

    it("'docker-build' template returns a docker build workflow", () => {
      const result = forgejoPlugin.initTemplates?.("docker-build");
      const src = result?.src?.["pipeline.ts"] as string;
      expect(src).toContain("Docker Build");
      expect(src).toContain("docker build");
    });
  });
});
