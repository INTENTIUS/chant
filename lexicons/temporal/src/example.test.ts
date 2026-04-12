/**
 * Integration test for the temporal-self-hosted example project.
 *
 * Builds the example from source using the temporal serializer and
 * verifies all expected output files are produced.
 */

import { describe, test, expect } from "vitest";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { build } from "@intentius/chant/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { temporalSerializer } from "./serializer";

const examplesRoot = resolve(fileURLToPath(import.meta.url), "../../../../examples");
const srcDir = resolve(examplesRoot, "temporal-self-hosted", "src");

describe("temporal-self-hosted example", () => {
  test("passes lint", async () => {
    const result = await lintCommand({ path: srcDir, format: "stylish", fix: true });
    if (!result.success || result.errorCount > 0) console.log(result.output);
    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  test("build produces docker-compose.yml primary output", async () => {
    const result = await build(srcDir, [temporalSerializer]);
    expect(result.errors).toHaveLength(0);
    const output = result.outputs.get("temporal")!;
    const primary = typeof output === "string" ? output : (output as { primary: string }).primary;
    expect(primary).toContain("temporalio/admin-tools");
    expect(primary).toContain("temporal server start-dev");
    expect(primary).toContain("7233");
  });

  test("build produces temporal-setup.sh with namespace and search attributes", async () => {
    const result = await build(srcDir, [temporalSerializer]);
    const output = result.outputs.get("temporal")!;
    const files =
      typeof output === "string" ? {} : (output as { files: Record<string, string> }).files ?? {};
    expect(files["temporal-setup.sh"]).toBeDefined();
    expect(files["temporal-setup.sh"]).toContain("temporal operator namespace create");
    expect(files["temporal-setup.sh"]).toContain('--namespace "my-app"');
    expect(files["temporal-setup.sh"]).toContain("temporal operator search-attribute create");
    expect(files["temporal-setup.sh"]).toContain('"JobType"');
    expect(files["temporal-setup.sh"]).toContain('"Priority"');
  });

  test("build produces schedules/daily-sync.ts", async () => {
    const result = await build(srcDir, [temporalSerializer]);
    const output = result.outputs.get("temporal")!;
    const files =
      typeof output === "string" ? {} : (output as { files: Record<string, string> }).files ?? {};
    expect(files["schedules/daily-sync.ts"]).toBeDefined();
    expect(files["schedules/daily-sync.ts"]).toContain("daily-sync");
    expect(files["schedules/daily-sync.ts"]).toContain("syncWorkflow");
    expect(files["schedules/daily-sync.ts"]).toContain("client.schedule.create");
  });
});
