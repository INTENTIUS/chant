import { describe, test, expect } from "vitest";
import { forgejoLintRules, wrapGithubRule } from "./delegate-to-github";
import { githubPlugin } from "@intentius/chant-lexicon-github";

describe("forgejo lint rules — wrapped from github", () => {
  test("returns a non-empty rule set", () => {
    expect(Array.isArray(forgejoLintRules)).toBe(true);
    expect(forgejoLintRules.length).toBeGreaterThan(0);
  });

  test("one wrapped rule per github rule, under the WFJ- namespace", () => {
    const githubRules = githubPlugin.lintRules?.() ?? [];
    expect(forgejoLintRules).toHaveLength(githubRules.length);
    expect(forgejoLintRules.map((r) => r.id)).toEqual(githubRules.map((r) => `WFJ-${r.id}`));
  });

  test("does not collide with any github rule id", () => {
    const githubIds = new Set((githubPlugin.lintRules?.() ?? []).map((r) => r.id));
    for (const rule of forgejoLintRules) {
      expect(githubIds.has(rule.id)).toBe(false);
    }
  });

  test("includes WFJ-GHA001 (use typed action composites)", () => {
    const ids = forgejoLintRules.map((r) => r.id);
    expect(ids).toContain("WFJ-GHA001");
  });

  test("includes WFJ-GHA003 (no hardcoded secrets)", () => {
    const ids = forgejoLintRules.map((r) => r.id);
    expect(ids).toContain("WFJ-GHA003");
  });

  test("wrapGithubRule preserves check() behavior, only renaming id", () => {
    const [githubRule] = githubPlugin.lintRules?.() ?? [];
    const wrapped = wrapGithubRule(githubRule);
    expect(wrapped.check).toBe(githubRule.check);
    expect(wrapped.severity).toBe(githubRule.severity);
    expect(wrapped.category).toBe(githubRule.category);
    expect(wrapped.id).toBe(`WFJ-${githubRule.id}`);
  });
});
