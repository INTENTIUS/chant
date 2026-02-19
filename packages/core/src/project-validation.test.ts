import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { validateProjectStructure } from "./project-validation";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, "__test_project_validation__");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("validateProjectStructure", () => {
  test("warns on empty directory", () => {
    const result = validateProjectStructure(TEST_DIR);
    expect(result.valid).toBe(true); // warnings don't block
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.some((i) => i.message.includes("config"))).toBe(true);
    expect(result.issues.some((i) => i.message.includes("src/"))).toBe(true);
  });

  test("no config warning when chant.config.ts exists", () => {
    writeFileSync(join(TEST_DIR, "chant.config.ts"), "export default {};");
    mkdirSync(join(TEST_DIR, "src"));
    const result = validateProjectStructure(TEST_DIR);
    expect(result.issues.some((i) => i.message.includes("config"))).toBe(false);
  });

  test("no config warning when chant.config.json exists", () => {
    writeFileSync(join(TEST_DIR, "chant.config.json"), "{}");
    mkdirSync(join(TEST_DIR, "src"));
    const result = validateProjectStructure(TEST_DIR);
    expect(result.issues.some((i) => i.message.includes("config"))).toBe(false);
  });

  test("warns on missing core types", () => {
    writeFileSync(join(TEST_DIR, "chant.config.ts"), "export default {};");
    mkdirSync(join(TEST_DIR, "src"));
    const result = validateProjectStructure(TEST_DIR);
    expect(result.issues.some((i) => i.message.includes("core"))).toBe(true);
  });

  test("warns on missing lexicon types", () => {
    writeFileSync(join(TEST_DIR, "chant.config.ts"), "export default {};");
    mkdirSync(join(TEST_DIR, "src"));
    const result = validateProjectStructure(TEST_DIR, ["testdom"]);
    expect(result.issues.some((i) => i.message.includes('"testdom"'))).toBe(true);
  });

  test("passes with complete structure", () => {
    writeFileSync(join(TEST_DIR, "chant.config.ts"), "export default {};");
    mkdirSync(join(TEST_DIR, "src"));
    mkdirSync(join(TEST_DIR, ".chant", "types", "core"), { recursive: true });
    writeFileSync(join(TEST_DIR, ".chant", "types", "core", "index.d.ts"), "export {};");
    mkdirSync(join(TEST_DIR, ".chant", "types", "lexicon-testdom"), { recursive: true });

    const result = validateProjectStructure(TEST_DIR, ["testdom"]);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});
