import { describe, test, expect } from "vitest";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { discoverLintRules, discoverPostSynthChecks } from "./discover";

const thisDir = dirname(fileURLToPath(import.meta.url));

describe("discoverLintRules", () => {
  test("returns empty array for non-existent directory", () => {
    const rules = discoverLintRules("/nonexistent/path", import.meta.url);
    expect(rules).toEqual([]);
  });

  test("discovers rules from a real lexicon", () => {
    // Use the Helm lexicon's rules directory as a real test case
    const helmRulesDir = join(thisDir, "../../../../lexicons/helm/src/lint/rules");
    const rules = discoverLintRules(helmRulesDir, import.meta.url);
    expect(rules.length).toBeGreaterThan(0);
    // Each discovered rule should have the expected shape
    for (const rule of rules) {
      expect(typeof rule.id).toBe("string");
      expect(typeof rule.severity).toBe("string");
      expect(typeof rule.category).toBe("string");
      expect(typeof rule.check).toBe("function");
    }
  });

  test("sorts rules by id", () => {
    const helmRulesDir = join(thisDir, "../../../../lexicons/helm/src/lint/rules");
    const rules = discoverLintRules(helmRulesDir, import.meta.url);
    for (let i = 1; i < rules.length; i++) {
      expect(rules[i].id.localeCompare(rules[i - 1].id)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("discoverPostSynthChecks", () => {
  test("returns empty array for non-existent directory", () => {
    const checks = discoverPostSynthChecks("/nonexistent/path", import.meta.url);
    expect(checks).toEqual([]);
  });

  test("discovers checks from a real lexicon", () => {
    const helmPostSynthDir = join(thisDir, "../../../../lexicons/helm/src/lint/post-synth");
    const checks = discoverPostSynthChecks(helmPostSynthDir, import.meta.url);
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) {
      expect(typeof check.id).toBe("string");
      expect(typeof check.description).toBe("string");
      expect(typeof check.check).toBe("function");
    }
  });

  test("sorts checks by id", () => {
    const helmPostSynthDir = join(thisDir, "../../../../lexicons/helm/src/lint/post-synth");
    const checks = discoverPostSynthChecks(helmPostSynthDir, import.meta.url);
    for (let i = 1; i < checks.length; i++) {
      expect(checks[i].id.localeCompare(checks[i - 1].id)).toBeGreaterThanOrEqual(0);
    }
  });

  test("does not include lint rules", () => {
    // Post-synth checks should not pick up lint rules (which also have check())
    const helmRulesDir = join(thisDir, "../../../../lexicons/helm/src/lint/rules");
    const checks = discoverPostSynthChecks(helmRulesDir, import.meta.url);
    // Lint rules have severity, post-synth checks don't — so this should be empty
    expect(checks.length).toBe(0);
  });
});
