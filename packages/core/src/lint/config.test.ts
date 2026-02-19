import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, DEFAULT_CONFIG } from "./config";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, "__test_config__");

beforeEach(() => {
  // Create test directory
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  // Clean up test directory
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("returns default config when no config file exists", () => {
    const config = loadConfig(TEST_DIR);

    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("loads basic config file", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          "test-rule": "error",
        },
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.rules).toEqual({
      "test-rule": "error",
    });
  });

  test("supports disabling rules with 'off'", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          "test-rule": "off",
        },
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.rules?.["test-rule"]).toBe("off");
  });

  test("supports all severity levels", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          "rule-1": "error",
          "rule-2": "warning",
          "rule-3": "info",
          "rule-4": "off",
        },
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.rules?.["rule-1"]).toBe("error");
    expect(config.rules?.["rule-2"]).toBe("warning");
    expect(config.rules?.["rule-3"]).toBe("info");
    expect(config.rules?.["rule-4"]).toBe("off");
  });

  test("throws error for invalid severity", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          "test-rule": "invalid",
        },
      })
    );

    expect(() => loadConfig(TEST_DIR)).toThrow(
      /rule "test-rule" has invalid severity "invalid"/
    );
  });

  test("throws error for invalid config structure", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(configPath, "[]"); // Array instead of object

    expect(() => loadConfig(TEST_DIR)).toThrow(/must be an object/);
  });

  test("throws error for invalid rules type", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [],
      })
    );

    expect(() => loadConfig(TEST_DIR)).toThrow(/rules must be an object/);
  });

  test("throws error for invalid JSON", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(configPath, "{invalid json}");

    expect(() => loadConfig(TEST_DIR)).toThrow(/Failed to parse config file/);
  });

  test("extends single config file", () => {
    const baseConfigPath = join(TEST_DIR, "base.json");
    writeFileSync(
      baseConfigPath,
      JSON.stringify({
        rules: {
          "rule-1": "error",
          "rule-2": "warning",
        },
      })
    );

    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: ["./base.json"],
        rules: {
          "rule-3": "info",
        },
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.rules).toEqual({
      "rule-1": "error",
      "rule-2": "warning",
      "rule-3": "info",
    });
  });

  test("extends multiple config files with override priority", () => {
    const base1Path = join(TEST_DIR, "base1.json");
    writeFileSync(
      base1Path,
      JSON.stringify({
        rules: {
          "rule-1": "error",
          "rule-2": "warning",
        },
      })
    );

    const base2Path = join(TEST_DIR, "base2.json");
    writeFileSync(
      base2Path,
      JSON.stringify({
        rules: {
          "rule-2": "info", // Override base1
          "rule-3": "error",
        },
      })
    );

    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: ["./base1.json", "./base2.json"],
        rules: {
          "rule-3": "warning", // Override base2
        },
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.rules).toEqual({
      "rule-1": "error",
      "rule-2": "info", // From base2
      "rule-3": "warning", // From main config
    });
  });

  test("throws error when extended config not found", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: ["./non-existent.json"],
      })
    );

    expect(() => loadConfig(TEST_DIR)).toThrow(/Extended config file not found/);
  });

  test("throws error for invalid extends type", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: "single-string",
      })
    );

    expect(() => loadConfig(TEST_DIR)).toThrow(/extends must be an array/);
  });

  test("throws error for non-string in extends array", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: [123],
      })
    );

    expect(() => loadConfig(TEST_DIR)).toThrow(/extends must be an array of strings/);
  });

  test("supports nested extends", () => {
    const base1Path = join(TEST_DIR, "base1.json");
    writeFileSync(
      base1Path,
      JSON.stringify({
        rules: {
          "rule-1": "error",
        },
      })
    );

    const base2Path = join(TEST_DIR, "base2.json");
    writeFileSync(
      base2Path,
      JSON.stringify({
        extends: ["./base1.json"],
        rules: {
          "rule-2": "warning",
        },
      })
    );

    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: ["./base2.json"],
        rules: {
          "rule-3": "info",
        },
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.rules).toEqual({
      "rule-1": "error",
      "rule-2": "warning",
      "rule-3": "info",
    });
  });

  test("detects circular extends", () => {
    const config1Path = join(TEST_DIR, "config1.json");
    const config2Path = join(TEST_DIR, "config2.json");

    writeFileSync(
      config1Path,
      JSON.stringify({
        extends: ["./config2.json"],
      })
    );

    writeFileSync(
      config2Path,
      JSON.stringify({
        extends: ["./config1.json"],
      })
    );

    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: ["./config1.json"],
      })
    );

    expect(() => loadConfig(TEST_DIR)).toThrow(/Circular extends detected/);
  });

  test("handles empty config file", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(configPath, "{}");

    const config = loadConfig(TEST_DIR);

    expect(config.rules).toEqual({});
  });

  test("handles config with empty rules object", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: {},
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.rules).toEqual({});
  });

  test("handles config with empty extends array", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: [],
        rules: {
          "test-rule": "error",
        },
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.rules).toEqual({
      "test-rule": "error",
    });
  });

  test("allows rule severity changes from extended config", () => {
    const basePath = join(TEST_DIR, "base.json");
    writeFileSync(
      basePath,
      JSON.stringify({
        rules: {
          "test-rule": "error",
        },
      })
    );

    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: ["./base.json"],
        rules: {
          "test-rule": "warning",
        },
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.rules?.["test-rule"]).toBe("warning");
  });

  test("allows disabling rules from extended config", () => {
    const basePath = join(TEST_DIR, "base.json");
    writeFileSync(
      basePath,
      JSON.stringify({
        rules: {
          "test-rule": "error",
        },
      })
    );

    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: ["./base.json"],
        rules: {
          "test-rule": "off",
        },
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.rules?.["test-rule"]).toBe("off");
  });

  test("default config uses strict preset severities", () => {
    expect(DEFAULT_CONFIG.rules).toEqual({
      COR001: "error",
      COR002: "error",
      COR003: "warning",
      COR004: "warning",
      COR005: "warning",
      COR006: "error",
      COR007: "warning",
      COR008: "error",
      COR009: "warning",
      COR010: "warning",
      COR011: "error",
      COR012: "warning",
      COR013: "info",
      COR014: "warning",
      COR015: "warning",
    });
  });

  test("no config file returns strict preset defaults", () => {
    const config = loadConfig(TEST_DIR);

    expect(config.rules?.["COR001"]).toBe("error");
    expect(config.rules?.["COR008"]).toBe("error");
    expect(config.rules?.["COR006"]).toBe("error");
    expect(config.rules?.["COR009"]).toBe("warning");
    expect(config.rules?.["COR005"]).toBe("warning");
    expect(config.rules?.["COR002"]).toBe("error");
    expect(config.rules?.["COR010"]).toBe("warning");
    expect(config.rules?.["COR013"]).toBe("info");
  });

  test("extends relaxed preset via package path", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: ["@intentius/chant/lint/presets/relaxed"],
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.rules).toEqual({
      COR001: "warning",
      COR002: "off",
      COR003: "off",
      COR004: "off",
      COR005: "off",
      COR006: "off",
      COR007: "off",
      COR008: "warning",
      COR009: "off",
      COR010: "warning",
      COR011: "warning",
      COR012: "off",
      COR013: "off",
      COR014: "off",
      COR015: "off",
    });
  });

  test("extends strict preset via package path", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: ["@intentius/chant/lint/presets/strict"],
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.rules).toEqual({
      COR001: "error",
      COR002: "error",
      COR003: "warning",
      COR004: "warning",
      COR005: "warning",
      COR006: "error",
      COR007: "warning",
      COR008: "error",
      COR009: "warning",
      COR010: "warning",
      COR011: "error",
      COR012: "warning",
      COR013: "info",
      COR014: "warning",
      COR015: "warning",
    });
  });

  test("user rules override preset severities", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: ["@intentius/chant/lint/presets/strict"],
        rules: {
          COR001: "off",
          COR006: "warning",
        },
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.rules?.["COR001"]).toBe("off");
    expect(config.rules?.["COR008"]).toBe("error");
    expect(config.rules?.["COR006"]).toBe("warning");
  });

  test("throws error for unknown @intentius/chant preset", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: ["@intentius/chant/lint/presets/nonexistent"],
      })
    );

    expect(() => loadConfig(TEST_DIR)).toThrow(/Unknown preset/);
  });

  test("config with no plugins field works (backward compat)", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          "test-rule": "error",
        },
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.rules).toEqual({ "test-rule": "error" });
    expect(config.plugins).toBeUndefined();
  });

  test("config with valid plugins array is loaded", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: { "test-rule": "error" },
        plugins: ["./my-plugin.ts", "./another-plugin.ts"],
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.plugins).toEqual(["./my-plugin.ts", "./another-plugin.ts"]);
  });

  test("throws error for non-array plugins", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: "not-an-array",
      })
    );

    expect(() => loadConfig(TEST_DIR)).toThrow(/plugins must be an array/);
  });

  test("throws error for non-string in plugins array", () => {
    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: ["valid-plugin", 123],
      })
    );

    expect(() => loadConfig(TEST_DIR)).toThrow(/plugins must be an array of strings/);
  });

  test("plugins from extended config are not inherited", () => {
    const basePath = join(TEST_DIR, "base.json");
    writeFileSync(
      basePath,
      JSON.stringify({
        rules: { "rule-1": "error" },
        plugins: ["./base-plugin.ts"],
      })
    );

    const configPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: ["./base.json"],
        rules: { "rule-2": "warning" },
      })
    );

    const config = loadConfig(TEST_DIR);

    expect(config.rules).toEqual({ "rule-1": "error", "rule-2": "warning" });
    expect(config.plugins).toBeUndefined();
  });

  test("loads lint config from chant.config.ts", () => {
    const tsPath = join(TEST_DIR, "chant.config.ts");
    writeFileSync(
      tsPath,
      `export default { lexicons: ["aws"], lint: { rules: { COR001: "off" } } };`,
    );

    const config = loadConfig(TEST_DIR);
    expect(config.rules?.COR001).toBe("off");
  });

  test("prefers chant.config.ts over chant.config.json", () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.ts"),
      `export default { lint: { rules: { COR001: "off" } } };`,
    );
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ rules: { COR001: "error" } }),
    );

    const config = loadConfig(TEST_DIR);
    expect(config.rules?.COR001).toBe("off");
  });

  test("chant.config.ts with only lexicons returns defaults for lint", () => {
    // Note: Bun caches require() by path, so we use a subdirectory
    const subDir = join(TEST_DIR, "no-lint-sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, "chant.config.ts"),
      `export default { lexicons: ["aws"] };`,
    );

    const config = loadConfig(subDir);
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});
