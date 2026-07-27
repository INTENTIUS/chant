/**
 * chant #1138 — `evaluateProjectPolicies` (the `policyGate` Op step's entry
 * point, ../../lexicons/temporal/src/op/activities/policy.ts) applies
 * `lint.rules` severity overrides to policy diagnostics the same way `chant
 * build` does (`../cli/commands/build.ts`), so a check `lint.rules` turns
 * "off" no longer gates an apply either — before this fix, only `chant
 * build`'s own error list was affected (and, before #1138, not even that).
 *
 * No lexicon is declared: the fixture project has no source files, so
 * `resolveProjectLexicons` detects none and `build()` succeeds trivially with
 * zero entities — the policy pack is the only thing under test.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateProjectPolicies } from "./policy";

describe("evaluateProjectPolicies honors lint.rules (chant #1138)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-policy-eval-test-${Date.now()}-${Math.random()}`);
    await mkdir(join(testDir, "policies"), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePolicyProject(checkId: string, severity: "error" | "warning", rules: Record<string, string>): Promise<void> {
    await writeFile(
      join(testDir, "policies", "org.ts"),
      `export const check = {\n` +
        `  id: ${JSON.stringify(checkId)},\n` +
        `  description: "test policy",\n` +
        `  check: () => [{ checkId: ${JSON.stringify(checkId)}, severity: ${JSON.stringify(severity)}, message: ${JSON.stringify(`${checkId} triggered`)} }],\n` +
        `};\n`,
    );
    await writeFile(
      join(testDir, "chant.config.ts"),
      // `lexicons: ["k8s"]` avoids `resolveProjectLexicons`'s source-import
      // auto-detection, which throws on a project with no lexicon-importing
      // source file at all (this fixture has none — the policy pack is the
      // only thing under test).
      `export default { lexicons: ["k8s"], lint: { policies: ["policies/org.ts"], rules: ${JSON.stringify(rules)} } };\n`,
    );
  }

  test('lint.rules "off" removes a check from violations and reports it as suppressed', async () => {
    await writePolicyProject("ORG-OFF", "error", { "ORG-OFF": "off" });

    const evaluation = await evaluateProjectPolicies({ path: testDir });

    expect(evaluation.violations).toEqual([]);
    expect(evaluation.diagnostics).toEqual([]);
    expect(evaluation.suppressed).toHaveLength(1);
    expect(evaluation.suppressed[0].checkId).toBe("ORG-OFF");
  });

  test('lint.rules "warning" downgrades an error-severity check out of violations', async () => {
    await writePolicyProject("ORG-DOWN", "error", { "ORG-DOWN": "warning" });

    const evaluation = await evaluateProjectPolicies({ path: testDir });

    expect(evaluation.violations).toEqual([]);
    expect(evaluation.diagnostics).toHaveLength(1);
    expect(evaluation.diagnostics[0].severity).toBe("warning");
    expect(evaluation.suppressed).toEqual([]);
  });

  test('lint.rules "error" upgrades a warning-severity check INTO violations', async () => {
    await writePolicyProject("ORG-UP", "warning", { "ORG-UP": "error" });

    const evaluation = await evaluateProjectPolicies({ path: testDir });

    expect(evaluation.violations).toHaveLength(1);
    expect(evaluation.violations[0].checkId).toBe("ORG-UP");
    expect(evaluation.violations[0].severity).toBe("error");
  });

  test("an unconfigured check id is unaffected — no drift for the common case", async () => {
    await writePolicyProject("ORG-PLAIN", "error", {});

    const evaluation = await evaluateProjectPolicies({ path: testDir });

    expect(evaluation.violations).toHaveLength(1);
    expect(evaluation.suppressed).toEqual([]);
  });
});
