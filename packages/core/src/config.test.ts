import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadChantConfig, DEFAULT_CHANT_CONFIG } from "./config";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, "__test_chant_config__");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadChantConfig", () => {
  test("returns default config when no config file exists", async () => {
    const result = await loadChantConfig(TEST_DIR);
    expect(result.config).toEqual(DEFAULT_CHANT_CONFIG);
    expect(result.configPath).toBeUndefined();
  });

  test("loads chant.config.ts with default export", async () => {
    const tsPath = join(TEST_DIR, "chant.config.ts");
    writeFileSync(
      tsPath,
      `export default { lexicons: ["testdom"], lint: { rules: { COR001: "error" } } };`,
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config.lexicons).toEqual(["testdom"]);
    expect(result.config.lint?.rules?.COR001).toBe("error");
    expect(result.configPath).toBe(tsPath);
  });

  test("loads chant.config.ts with named config export", async () => {
    const tsPath = join(TEST_DIR, "chant.config.ts");
    writeFileSync(
      tsPath,
      `export const config = { lexicons: ["testdom"] };`,
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config.lexicons).toEqual(["testdom"]);
  });

  test("loads chant.config.json", async () => {
    const jsonPath = join(TEST_DIR, "chant.config.json");
    writeFileSync(
      jsonPath,
      JSON.stringify({ lexicons: ["testdom"] }),
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config.lexicons).toEqual(["testdom"]);
    expect(result.configPath).toBe(jsonPath);
  });

  test("prefers .ts over .json when both exist", async () => {
    // .ts takes priority — verify by checking configPath ends with .ts
    writeFileSync(
      join(TEST_DIR, "chant.config.ts"),
      `export default { lexicons: ["testdom"] };`,
    );
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ lexicons: ["from-json"] }),
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.configPath).toEndWith("chant.config.ts");
  });

  test("handles empty config", async () => {
    writeFileSync(join(TEST_DIR, "chant.config.json"), "{}");

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config).toEqual({});
  });

  test("handles config with only lexicons", async () => {
    writeFileSync(
      join(TEST_DIR, "chant.config.json"),
      JSON.stringify({ lexicons: ["testdom"] }),
    );

    const result = await loadChantConfig(TEST_DIR);
    expect(result.config.lexicons).toEqual(["testdom"]);
    expect(result.config.lint).toBeUndefined();
  });
});
