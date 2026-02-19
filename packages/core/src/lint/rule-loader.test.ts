import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { loadLocalRules } from "./rule-loader";

const TEST_DIR = join(import.meta.dir, "__test_rules_fixture__");
const RULES_DIR = join(TEST_DIR, ".chant", "rules");

beforeAll(() => {
  mkdirSync(RULES_DIR, { recursive: true });

  // Write a valid rule file
  writeFileSync(
    join(RULES_DIR, "my-rule.ts"),
    `
import type { LintRule, LintContext, LintDiagnostic } from "../../../rule";

export const myCustomRule: LintRule = {
  id: "LOCAL001",
  severity: "warning",
  category: "style",
  check(context: LintContext): LintDiagnostic[] {
    return [];
  },
};

// Non-rule export should be ignored
export const notARule = "just a string";
`,
  );
});

afterAll(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe("rule-loader", () => {
  test("loads rules from .chant/rules/ directory", async () => {
    const rules = await loadLocalRules(TEST_DIR);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("LOCAL001");
    expect(rules[0].severity).toBe("warning");
    expect(rules[0].category).toBe("style");
  });

  test("returns empty array when .chant/rules/ does not exist", async () => {
    const rules = await loadLocalRules("/tmp/nonexistent-project-dir");
    expect(rules).toHaveLength(0);
  });

  test("ignores test files in .chant/rules/", async () => {
    // Write a test file that should be ignored
    writeFileSync(
      join(RULES_DIR, "my-rule.test.ts"),
      `export const testRule = { id: "SKIP", severity: "error", category: "style", check() { return []; } };`,
    );

    const rules = await loadLocalRules(TEST_DIR);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("LOCAL001");

    // Clean up
    rmSync(join(RULES_DIR, "my-rule.test.ts"));
  });
});
