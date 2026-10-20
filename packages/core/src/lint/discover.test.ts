import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { discoverLintRules, discoverPostSynthChecks, listRuleFiles } from "./discover";

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

describe("rule modules compiled to JS (#3981)", () => {
  let dir: string;

  beforeAll(() => {
    // A compiled rules directory: ES modules in a "type": "module" package, each with its declarations beside it.
    dir = mkdtempSync(join(tmpdir(), "chant-discover-js-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(dir, "alpha.js"), `export const alpha = { id: "JS002", severity: "warning", category: "style", check: () => [] };\n`);
    writeFileSync(join(dir, "alpha.d.ts"), `export declare const alpha: unknown;\n`);
    writeFileSync(join(dir, "beta.js"), `export const beta = { id: "JS001", severity: "error", category: "security", check: () => [] };\n`);
    writeFileSync(join(dir, "beta.d.ts"), `export declare const beta: unknown;\n`);
    writeFileSync(join(dir, "gamma.js"), `export const gamma = { id: "JSP001", description: "a post-synth check", check: () => [] };\n`);
    writeFileSync(join(dir, "index.js"), `export * from "./alpha.js";\n`);
    writeFileSync(join(dir, "rule-helpers.js"), `export const helper = 1;\n`);
    writeFileSync(join(dir, "alpha.test.js"), `throw new Error("a test is not a rule");\n`);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("listRuleFiles lists .js modules and leaves out declarations, tests, helpers and the index", () => {
    expect(listRuleFiles(dir).sort()).toEqual(["alpha.js", "beta.js", "gamma.js"]);
  });

  test("a source module and its compiled twin list once, as the source", () => {
    const both = mkdtempSync(join(tmpdir(), "chant-discover-both-"));
    try {
      for (const f of ["one.ts", "one.js", "one.d.ts", "two.js"]) writeFileSync(join(both, f), "");
      expect(listRuleFiles(both).sort()).toEqual(["one.ts", "two.js"]);
    } finally {
      rmSync(both, { recursive: true, force: true });
    }
  });

  test("discoverLintRules loads compiled rules", () => {
    expect(discoverLintRules(dir, import.meta.url).map((r) => r.id)).toEqual(["JS001", "JS002"]);
  });

  test("discoverPostSynthChecks loads compiled checks", () => {
    expect(discoverPostSynthChecks(dir, import.meta.url).map((c) => c.id)).toEqual(["JSP001"]);
  });
});
