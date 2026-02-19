import { describe, test, expect } from "bun:test";
import { validate } from "./validate";
import { dirname } from "path";
import { fileURLToPath } from "url";

const basePath = dirname(dirname(fileURLToPath(import.meta.url)));

describe("validate", () => {
  test("passes validation for current generated artifacts", async () => {
    const result = await validate({ basePath });
    expect(result.success).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
  });

  test("checks all expected entities are present", async () => {
    const result = await validate({ basePath });
    const checkNames = result.checks.map((c) => c.name);
    expect(checkNames).toContain("resource Job present");
    expect(checkNames).toContain("resource Default present");
    expect(checkNames).toContain("resource Workflow present");
    expect(checkNames).toContain("property Artifacts present");
    expect(checkNames).toContain("property Cache present");
    expect(checkNames).toContain("property Image present");
  });

  test("checks file existence", async () => {
    const result = await validate({ basePath });
    const fileChecks = result.checks.filter((c) => c.name.endsWith("exists"));
    expect(fileChecks.length).toBeGreaterThan(0);
    for (const check of fileChecks) {
      expect(check.ok).toBe(true);
    }
  });

  test("checks index.d.ts class declarations", async () => {
    const result = await validate({ basePath });
    const dtsChecks = result.checks.filter((c) => c.name.startsWith("index.d.ts declares"));
    expect(dtsChecks.length).toBeGreaterThan(0);
    for (const check of dtsChecks) {
      expect(check.ok).toBe(true);
    }
  });
});
