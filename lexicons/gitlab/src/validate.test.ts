import { describe, test, expect } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const basePath = dirname(dirname(fileURLToPath(import.meta.url)));
const lexiconPath = join(basePath, "src", "generated", "lexicon-gitlab.json");
const hasGenerated = existsSync(lexiconPath);

describe("validate", () => {
  test.skipIf(!hasGenerated)("runs validation checks on current generated artifacts", async () => {
    const { validate } = await import("./validate");
    const result = await validate({ basePath });
    expect(result.checks.length).toBeGreaterThan(0);
  });

  test.skipIf(!hasGenerated)("checks lexicon JSON exists and parses", async () => {
    const { validate } = await import("./validate");
    const result = await validate({ basePath });
    const jsonCheck = result.checks.find((c) => c.name === "lexicon-json-exists");
    expect(jsonCheck).toBeDefined();
    expect(jsonCheck?.ok).toBe(true);
  });

  test.skipIf(!hasGenerated)("checks types exist", async () => {
    const { validate } = await import("./validate");
    const result = await validate({ basePath });
    const typesCheck = result.checks.find((c) => c.name === "types-exist");
    expect(typesCheck).toBeDefined();
    expect(typesCheck?.ok).toBe(true);
  });

  test.skipIf(!hasGenerated)("checks required names are present", async () => {
    const { validate } = await import("./validate");
    const result = await validate({ basePath });
    const requiredCheck = result.checks.find((c) => c.name === "required-names");
    expect(requiredCheck).toBeDefined();
    expect(requiredCheck?.ok).toBe(true);
  });
});
