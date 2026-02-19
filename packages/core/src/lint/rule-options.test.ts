import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { parseRuleConfig, loadConfig } from "./config";
import { fileDeclarableLimitRule } from "./rules/file-declarable-limit";
import * as ts from "typescript";
import type { LintContext } from "./rule";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

function makeNewExprs(names: string[]): string {
  return names.map((n) => `const x = new ${n}({ name: "a" });`).join("\n");
}

const TEST_DIR = join(import.meta.dir, "__test_rule_options__");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("parseRuleConfig", () => {
  test("parses string severity", () => {
    const result = parseRuleConfig("warning");
    expect(result).toEqual({ severity: "warning" });
  });

  test("parses 'off' string", () => {
    const result = parseRuleConfig("off");
    expect(result).toEqual({ severity: "off" });
  });

  test("parses [severity, options] tuple", () => {
    const result = parseRuleConfig(["warning", { max: 12 }]);
    expect(result).toEqual({ severity: "warning", options: { max: 12 } });
  });

  test("throws for invalid tuple length", () => {
    expect(() => parseRuleConfig([] as unknown as [string, Record<string, unknown>])).toThrow(
      /expected a severity string or \[severity, options\] tuple/
    );
  });

  test("throws for invalid severity in tuple", () => {
    expect(() => parseRuleConfig(["invalid" as "error", { max: 1 }])).toThrow(
      /severity "invalid" must be/
    );
  });

  test("throws when options is not a plain object", () => {
    expect(() => parseRuleConfig(["warning", [1, 2] as unknown as Record<string, unknown>])).toThrow(
      /options must be a plain object/
    );
  });

  test("throws when options is null", () => {
    expect(() => parseRuleConfig(["warning", null as unknown as Record<string, unknown>])).toThrow(
      /options must be a plain object/
    );
  });
});

describe("COR009 with options", () => {
  test("uses default limit (8) when no options", () => {
    const code = makeNewExprs(["A", "B", "C", "D", "E", "F", "G", "H", "I"]);
    const context = createContext(code);
    const diagnostics = fileDeclarableLimitRule.check(context);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("limit: 8");
  });

  test("respects custom max from options", () => {
    const code = makeNewExprs(["A", "B", "C", "D", "E", "F", "G", "H", "I"]);
    const context = createContext(code);

    // With max: 12, 9 instances should not trigger
    const diagnostics = fileDeclarableLimitRule.check(context, { max: 12 });
    expect(diagnostics).toHaveLength(0);
  });

  test("custom max triggers when exceeded", () => {
    const code = makeNewExprs(["A", "B", "C", "D", "E"]);
    const context = createContext(code);

    // With max: 4, 5 instances should trigger
    const diagnostics = fileDeclarableLimitRule.check(context, { max: 4 });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("limit: 4");
  });
});

describe("config loading with tuple format", () => {
  test("loads config with string severity", () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ rules: { COR009: "error" } })
    );
    const config = loadConfig(TEST_DIR);
    expect(config.rules?.["COR009"]).toBe("error");
  });

  test("loads config with [severity, options] tuple", () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ rules: { COR009: ["warning", { max: 12 }] } })
    );
    const config = loadConfig(TEST_DIR);
    expect(config.rules?.["COR009"]).toEqual(["warning", { max: 12 }]);
  });

  test("rejects invalid tuple format in config", () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ rules: { COR009: ["warning"] } })
    );
    expect(() => loadConfig(TEST_DIR)).toThrow(/must be a severity string or \[severity, options\] tuple/);
  });

  test("rejects non-object options in config tuple", () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ rules: { COR009: ["warning", "not-an-object"] } })
    );
    expect(() => loadConfig(TEST_DIR)).toThrow(/must be a severity string or \[severity, options\] tuple/);
  });

  test("rejects non-string/non-tuple rule values", () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ rules: { COR009: 42 } })
    );
    expect(() => loadConfig(TEST_DIR)).toThrow(/must be a severity string or \[severity, options\] tuple/);
  });
});
