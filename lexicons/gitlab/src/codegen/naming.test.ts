import { describe, test, expect } from "vitest";
import { gitlabShortName, type GitLabParseResult } from "./parse";
import { NamingStrategy } from "./naming";

/**
 * Chant's naming philosophy for GitLab: simple, flat names.
 * Every priorityName should be the short name from the GitLab::CI:: namespace.
 * No "CI" prefix should leak into class names.
 */

/** Build a minimal GitLabParseResult for a given typeName. */
function stubResult(typeName: string, isProperty?: boolean): GitLabParseResult {
  return {
    resource: {
      typeName,
      properties: [],
      attributes: [],
      deprecatedProperties: [],
    },
    propertyTypes: [],
    enums: [],
    isProperty,
  };
}

describe("naming spec fidelity", () => {
  const typeNames = [
    "GitLab::CI::Job",
    "GitLab::CI::Default",
    "GitLab::CI::Workflow",
    "GitLab::CI::Artifacts",
    "GitLab::CI::Cache",
    "GitLab::CI::Image",
    "GitLab::CI::Rule",
    "GitLab::CI::Retry",
    "GitLab::CI::AllowFailure",
    "GitLab::CI::Parallel",
    "GitLab::CI::Include",
    "GitLab::CI::Release",
    "GitLab::CI::Environment",
    "GitLab::CI::Trigger",
    "GitLab::CI::AutoCancel",
    "GitLab::CI::WorkflowRule",
    "GitLab::CI::Need",
    "GitLab::CI::Inherit",
  ];

  const results = typeNames.map((t) => stubResult(t));
  const strategy = new NamingStrategy(results);

  test("all priority names resolve to short name", () => {
    for (const typeName of typeNames) {
      const resolved = strategy.resolve(typeName);
      const shortName = gitlabShortName(typeName);
      expect(resolved).toBe(shortName);
    }
  });

  test("no priority name has CI prefix", () => {
    for (const typeName of typeNames) {
      const resolved = strategy.resolve(typeName)!;
      // "CI" as a prefix (e.g. "CIJob") would be wrong; "Cache" starting with "C" is fine
      expect(resolved.startsWith("CI")).toBe(false);
    }
  });

  test("no priority name has GitLab prefix", () => {
    for (const typeName of typeNames) {
      const resolved = strategy.resolve(typeName)!;
      expect(resolved.startsWith("GitLab")).toBe(false);
    }
  });

  test("all 18 priority names are mapped", () => {
    expect(typeNames).toHaveLength(18);
    for (const typeName of typeNames) {
      expect(strategy.resolve(typeName)).toBeDefined();
    }
  });
});

describe("property type naming", () => {
  test("resolves property entities correctly", () => {
    const results = [
      stubResult("GitLab::CI::Artifacts", true),
      stubResult("GitLab::CI::Cache", true),
    ];
    const strategy = new NamingStrategy(results);

    expect(strategy.resolve("GitLab::CI::Artifacts")).toBe("Artifacts");
    expect(strategy.resolve("GitLab::CI::Cache")).toBe("Cache");
  });
});
