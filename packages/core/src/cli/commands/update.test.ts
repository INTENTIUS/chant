import { describe, test, expect } from "vitest";
import { updateCommand } from "./update";
import { withTestDir } from "@intentius/chant-test-utils";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";

describe("updateCommand", () => {
  test("fails when no lexicons configured", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(join(testDir, "chant.config.json"), "{}");

      const result = await updateCommand({ path: testDir });
      expect(result.success).toBe(false);
      expect(result.error).toContain("No lexicons configured");
    });
  });

  test("warns when packages not found", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(
        join(testDir, "chant.config.ts"),
        `export default { lexicons: ["nonexistent"] };`,
      );

      const result = await updateCommand({ path: testDir });
      expect(result.success).toBe(true);
      expect(result.warnings.some((w) => w.includes("not found"))).toBe(true);
      // chant #3988 — the warning names the install command for the package.
      expect(
        result.warnings.some((w) =>
          w.includes('npm install --save-dev @intentius/chant-lexicon-nonexistent'),
        ),
      ).toBe(true);
    });
  });

  test("succeeds with no config file (returns error about no lexicons)", async () => {
    await withTestDir(async (testDir) => {
      const result = await updateCommand({ path: testDir });
      expect(result.success).toBe(false);
      expect(result.error).toContain("No lexicons");
    });
  });
});
