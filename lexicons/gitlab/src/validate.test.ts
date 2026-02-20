import { describe, test, expect } from "bun:test";
import { validate } from "./validate";
import { dirname } from "path";
import { fileURLToPath } from "url";

const basePath = dirname(dirname(fileURLToPath(import.meta.url)));

describe("validate", () => {
  test("runs validation checks on current generated artifacts", async () => {
    const result = await validate({ basePath });
    expect(result.checks.length).toBeGreaterThan(0);
  });

  test("checks lexicon JSON exists and parses", async () => {
    const result = await validate({ basePath });
    const jsonCheck = result.checks.find((c) => c.name === "lexicon-json-exists");
    expect(jsonCheck).toBeDefined();
    expect(jsonCheck?.ok).toBe(true);
  });

  test("checks types exist", async () => {
    const result = await validate({ basePath });
    const typesCheck = result.checks.find((c) => c.name === "types-exist");
    expect(typesCheck).toBeDefined();
    expect(typesCheck?.ok).toBe(true);
  });

  test("checks required names are present", async () => {
    const result = await validate({ basePath });
    const requiredCheck = result.checks.find((c) => c.name === "required-names");
    expect(requiredCheck).toBeDefined();
    expect(requiredCheck?.ok).toBe(true);
  });
});
