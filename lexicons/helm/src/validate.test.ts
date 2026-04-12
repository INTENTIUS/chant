import { describe, test, expect } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { validate } from "./validate";

const basePath = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedDir = join(basePath, "src", "generated");
const hasGenerated = existsSync(join(generatedDir, "lexicon-helm.json"));

describe("validate", () => {
  test("runs validation checks on current artifacts", async () => {
    const result = await validate({ basePath });
    expect(result.checks.length).toBeGreaterThan(0);
  });

  test.skipIf(!hasGenerated)("checks lexicon JSON exists and parses", async () => {
    const result = await validate({ basePath });
    const jsonCheck = result.checks.find((c) => c.name === "lexicon-json-exists");
    expect(jsonCheck).toBeDefined();
    expect(jsonCheck?.ok).toBe(true);
  });

  test.skipIf(!hasGenerated)("checks types exist", async () => {
    const result = await validate({ basePath });
    const typesCheck = result.checks.find((c) => c.name === "types-exist");
    expect(typesCheck).toBeDefined();
    expect(typesCheck?.ok).toBe(true);
  });

  test.skipIf(!hasGenerated)("checks required names are present", async () => {
    const result = await validate({ basePath });
    const requiredCheck = result.checks.find((c) => c.name === "required-names");
    expect(requiredCheck).toBeDefined();
    expect(requiredCheck?.ok).toBe(true);
  });
});
