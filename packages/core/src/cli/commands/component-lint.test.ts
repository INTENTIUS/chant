/**
 * `chant lint` end-to-end integration for the COMP* composition checks
 * (#562, epic #551) — confirms `lintCommand` itself (not just
 * `runComponentChecks` in isolation, see
 * ../../lint/rules/comp/comp.test.ts) merges COMP* diagnostics into its
 * output, gates the build at error severity the same way COR/EVL rules do,
 * honors config severity overrides (including "off"), and honors the
 * file-level `chant-disable` directive form.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { lintCommand, type LintOptions } from "./lint";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const COMPONENT_MODULE_SPECIFIER = JSON.stringify(
  new URL("../../components/component.ts", import.meta.url).pathname,
);

function componentSource(body: string): string {
  return `import type { Component } from ${COMPONENT_MODULE_SPECIFIER};\nimport { phase } from ${COMPONENT_MODULE_SPECIFIER};\n\n${body}\n`;
}

describe("chant lint: COMP* composition checks (#562)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-comp-lint-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
    process.env.NO_COLOR = "1";
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    delete process.env.NO_COLOR;
  });

  test("a clean component (no *.component.ts issues) lints with no COMP diagnostics", async () => {
    await writeFile(
      join(testDir, "orders-table.component.ts"),
      componentSource(
        `export const ordersTable: Component = {\n` +
          `  name: "orders-table",\n` +
          `  archetype: "infra",\n` +
          `  dependsOn: [],\n` +
          `  deploy: [phase("Apply", [{ kind: "cfn-deploy", template: "archive:orders-table.template.json" }])],\n` +
          `};\n`,
      ),
    );

    const result = await lintCommand({ path: testDir, format: "stylish" } satisfies LintOptions);
    expect(result.diagnostics.filter((d) => d.ruleId.startsWith("COMP"))).toHaveLength(0);
  });

  test("a raw shell step with no reason fails the lint at error severity (COMP006), gating the build like a COR* error", async () => {
    await writeFile(
      join(testDir, "legacy.component.ts"),
      componentSource(
        `export const legacyTool: Component = {\n` +
          `  name: "legacy-tool",\n` +
          `  archetype: "infra",\n` +
          `  dependsOn: [],\n` +
          `  deploy: [phase("Apply", [{ kind: "shell", cmd: "./deploy.sh" }])],\n` +
          `};\n`,
      ),
    );

    const result = await lintCommand({ path: testDir, format: "stylish" } satisfies LintOptions);
    expect(result.success).toBe(false);
    const hit = result.diagnostics.find((d) => d.ruleId === "COMP006");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
    expect(result.errorCount).toBeGreaterThan(0);
  });

  test("a chant-disable COMP006 file-level directive suppresses the diagnostic", async () => {
    await writeFile(
      join(testDir, "legacy.component.ts"),
      `// chant-disable COMP006 -- vendor CLI, tracked in TICKET-123\n` +
        componentSource(
          `export const legacyTool: Component = {\n` +
            `  name: "legacy-tool",\n` +
            `  archetype: "infra",\n` +
            `  dependsOn: [],\n` +
            `  deploy: [phase("Apply", [{ kind: "shell", cmd: "./deploy.sh" }])],\n` +
            `};\n`,
        ),
    );

    const result = await lintCommand({ path: testDir, format: "stylish" } satisfies LintOptions);
    expect(result.diagnostics.some((d) => d.ruleId === "COMP006")).toBe(false);
    expect(result.success).toBe(true);
  });

  test("a bare chant-disable (no rule ids) suppresses every COMP diagnostic for that file", async () => {
    await writeFile(
      join(testDir, "legacy.component.ts"),
      `// chant-disable\n` +
        componentSource(
          `export const legacyTool: Component = {\n` +
            `  name: "legacy-tool",\n` +
            `  archetype: "infra",\n` +
            `  dependsOn: [],\n` +
            `  deploy: [phase("Apply", [{ kind: "shell", cmd: "./deploy.sh" }])],\n` +
            `};\n`,
        ),
    );

    const result = await lintCommand({ path: testDir, format: "stylish" } satisfies LintOptions);
    expect(result.diagnostics.filter((d) => d.ruleId.startsWith("COMP"))).toHaveLength(0);
  });

  test("chant.config.ts can turn a COMP rule off entirely", async () => {
    await writeFile(
      join(testDir, "legacy.component.ts"),
      componentSource(
        `export const legacyTool: Component = {\n` +
          `  name: "legacy-tool",\n` +
          `  archetype: "infra",\n` +
          `  dependsOn: [],\n` +
          `  deploy: [phase("Apply", [{ kind: "shell", cmd: "./deploy.sh" }])],\n` +
          `};\n`,
      ),
    );
    await writeFile(
      join(testDir, "chant.config.json"),
      JSON.stringify({ rules: { COMP006: "off" } }),
    );

    const result = await lintCommand({ path: testDir, format: "stylish" } satisfies LintOptions);
    expect(result.diagnostics.some((d) => d.ruleId === "COMP006")).toBe(false);
  });

  test("chant.config.ts can downgrade a COMP rule to warning, so it no longer fails the build", async () => {
    await writeFile(
      join(testDir, "legacy.component.ts"),
      componentSource(
        `export const legacyTool: Component = {\n` +
          `  name: "legacy-tool",\n` +
          `  archetype: "infra",\n` +
          `  dependsOn: [],\n` +
          `  deploy: [phase("Apply", [{ kind: "shell", cmd: "./deploy.sh" }])],\n` +
          `};\n`,
      ),
    );
    await writeFile(
      join(testDir, "chant.config.json"),
      JSON.stringify({ rules: { COMP006: "warning" } }),
    );

    const result = await lintCommand({ path: testDir, format: "stylish" } satisfies LintOptions);
    const hit = result.diagnostics.find((d) => d.ruleId === "COMP006");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
    expect(result.success).toBe(true);
  });
});
