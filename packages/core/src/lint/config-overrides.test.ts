import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, resolveRulesForFile, type LintConfig } from "./config";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, "__test_config_overrides__");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("resolveRulesForFile", () => {
  test("returns base rules when config has no overrides", () => {
    const config: LintConfig = {
      rules: { COR001: "error", COR008: "warning" },
    };

    const resolved = resolveRulesForFile(config, "src/index.ts");

    expect(resolved).toEqual({ COR001: "error", COR008: "warning" });
  });

  test("override matches test files via glob **/*.test.ts", () => {
    const config: LintConfig = {
      rules: { COR001: "error", COR006: "error" },
      overrides: [
        {
          files: ["**/*.test.ts"],
          rules: { COR006: "off" },
        },
      ],
    };

    const resolved = resolveRulesForFile(config, "src/utils/helper.test.ts");

    expect(resolved).toEqual({ COR001: "error", COR006: "off" });
  });

  test("override does not match non-matching files", () => {
    const config: LintConfig = {
      rules: { COR001: "error", COR006: "error" },
      overrides: [
        {
          files: ["**/*.test.ts"],
          rules: { COR006: "off" },
        },
      ],
    };

    const resolved = resolveRulesForFile(config, "src/utils/helper.ts");

    expect(resolved).toEqual({ COR001: "error", COR006: "error" });
  });

  test("override matches directory via glob src/legacy/**", () => {
    const config: LintConfig = {
      rules: { COR001: "error" },
      overrides: [
        {
          files: ["src/legacy/**"],
          rules: { COR001: "warning" },
        },
      ],
    };

    const resolved = resolveRulesForFile(config, "src/legacy/old-module.ts");

    expect(resolved).toEqual({ COR001: "warning" });
  });

  test("multiple overrides applied in order (later overrides win)", () => {
    const config: LintConfig = {
      rules: { COR001: "error" },
      overrides: [
        {
          files: ["**/*.ts"],
          rules: { COR001: "warning" },
        },
        {
          files: ["**/*.test.ts"],
          rules: { COR001: "off" },
        },
      ],
    };

    const resolved = resolveRulesForFile(config, "src/app.test.ts");

    expect(resolved).toEqual({ COR001: "off" });
  });

  test("override can set rule to off", () => {
    const config: LintConfig = {
      rules: { COR001: "error", COR008: "error", COR006: "error" },
      overrides: [
        {
          files: ["**/*.spec.ts"],
          rules: { COR008: "off", COR006: "off" },
        },
      ],
    };

    const resolved = resolveRulesForFile(config, "test/app.spec.ts");

    expect(resolved).toEqual({ COR001: "error", COR008: "off", COR006: "off" });
  });

  test("override can change severity", () => {
    const config: LintConfig = {
      rules: { COR001: "error", COR009: "warning" },
      overrides: [
        {
          files: ["src/generated/**"],
          rules: { COR001: "info", COR009: "off" },
        },
      ],
    };

    const resolved = resolveRulesForFile(config, "src/generated/types.ts");

    expect(resolved).toEqual({ COR001: "info", COR009: "off" });
  });

  test("override can add rules not in base config", () => {
    const config: LintConfig = {
      rules: { COR001: "error" },
      overrides: [
        {
          files: ["**/*.ts"],
          rules: { W999: "warning" },
        },
      ],
    };

    const resolved = resolveRulesForFile(config, "src/index.ts");

    expect(resolved).toEqual({ COR001: "error", W999: "warning" });
  });

  test("multiple file patterns in single override", () => {
    const config: LintConfig = {
      rules: { COR006: "error" },
      overrides: [
        {
          files: ["**/*.test.ts", "**/*.spec.ts"],
          rules: { COR006: "off" },
        },
      ],
    };

    expect(resolveRulesForFile(config, "src/app.test.ts")).toEqual({ COR006: "off" });
    expect(resolveRulesForFile(config, "src/app.spec.ts")).toEqual({ COR006: "off" });
    expect(resolveRulesForFile(config, "src/app.ts")).toEqual({ COR006: "error" });
  });
});

describe("loadConfig with overrides", () => {
  test("loads config with overrides", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: { COR001: "error" },
        overrides: [
          {
            files: ["**/*.test.ts"],
            rules: { COR001: "off" },
          },
        ],
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.overrides).toHaveLength(1);
    expect(config.overrides![0].files).toEqual(["**/*.test.ts"]);
    expect(config.overrides![0].rules).toEqual({ COR001: "off" });
  });

  test("throws error for invalid overrides structure (not array)", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        overrides: "invalid",
      })
    );

    expect(() => loadConfig(TEST_DIR)).toThrow(/overrides must be an array/);
  });

  test("throws error for invalid override entry (not object)", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        overrides: ["invalid"],
      })
    );

    expect(() => loadConfig(TEST_DIR)).toThrow(/overrides\[0\] must be an object/);
  });

  test("throws error for missing files array in override", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        overrides: [{ rules: { COR001: "off" } }],
      })
    );

    expect(() => loadConfig(TEST_DIR)).toThrow(/overrides\[0\]\.files must be an array/);
  });

  test("throws error for non-string in files array", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        overrides: [{ files: [123], rules: { COR001: "off" } }],
      })
    );

    expect(() => loadConfig(TEST_DIR)).toThrow(/overrides\[0\]\.files must be an array of strings/);
  });

  test("throws error for invalid severity in override rules", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        overrides: [{ files: ["**/*.ts"], rules: { COR001: "invalid" } }],
      })
    );

    expect(() => loadConfig(TEST_DIR)).toThrow(/overrides\[0\] rule "COR001" has invalid severity/);
  });

  test("throws error for invalid rules in override (not object)", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        overrides: [{ files: ["**/*.ts"], rules: [] }],
      })
    );

    expect(() => loadConfig(TEST_DIR)).toThrow(/overrides\[0\]\.rules must be an object/);
  });
});
