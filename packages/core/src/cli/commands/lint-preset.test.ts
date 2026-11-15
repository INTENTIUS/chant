import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintCommand } from "./lint";
import type { LintRule } from "../../lint/rule";
import { PULL_REQUEST_PRESET, readBaselineIdentities } from "../../audit/pull-request-preset";

/**
 * #5118: `chant lint --preset pull-request` keeps the preset's rules, names
 * each finding by identity, and fails only on a merge-blocking one.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-5118-lint-"));
  process.env.NO_COLOR = "1";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.NO_COLOR;
});

/** A rule that reports once per `// flag <name>` comment, under the id it is given. */
const ruleFor = (id: string, severity: LintRule["severity"]): LintRule => ({
  id,
  severity,
  category: "correctness",
  description: `test rule ${id}`,
  check(ctx) {
    const text = ctx.sourceFile.getFullText();
    return [...text.matchAll(/\/\/ flag (\w+)/g)].map((m) => ({
      file: ctx.filePath,
      line: 1,
      column: 1,
      ruleId: id,
      severity,
      message: `flagged ${m[1]}`,
      entity: m[1],
    }));
  },
});

const rules = [ruleFor("WK8501", "error"), ruleFor("WK8102", "warning"), ruleFor("COR001", "warning")];

describe("chant lint --preset pull-request (#5118)", () => {
  test("leaves out rules outside the preset and fails on a merge-blocking finding", async () => {
    writeFileSync(join(dir, "a.ts"), "// flag one\nexport const x = 1;\n");
    const plain = await lintCommand({ path: dir, format: "json", rules, postSynth: false });
    expect(plain.diagnostics.map((d) => d.ruleId).sort()).toEqual(["COR001", "WK8102", "WK8501"]);

    const r = await lintCommand({ path: dir, format: "json", rules, postSynth: false, preset: PULL_REQUEST_PRESET });
    expect(r.diagnostics.map((d) => [d.ruleId, d.gate])).toEqual([
      ["WK8501", "merge-blocking"],
      ["WK8102", "report-only"],
    ]);
    expect(r.diagnostics.every((d) => typeof d.identity === "string")).toBe(true);
    expect(r.success).toBe(false);
  });

  test("with its own JSON as the baseline, only a new finding is reported", async () => {
    writeFileSync(join(dir, "a.ts"), "// flag one\nexport const x = 1;\n");
    const base = await lintCommand({ path: dir, format: "json", rules, postSynth: false, preset: PULL_REQUEST_PRESET });
    const baseline = readBaselineIdentities(base.output);

    const same = await lintCommand({ path: dir, format: "json", rules, postSynth: false, preset: PULL_REQUEST_PRESET, baseline });
    expect(same.diagnostics).toEqual([]);
    expect(same.success).toBe(true);

    writeFileSync(join(dir, "a.ts"), "// flag one\n// flag two\nexport const x = 1;\n");
    const head = await lintCommand({ path: dir, format: "sarif", rules, postSynth: false, preset: PULL_REQUEST_PRESET, baseline });
    expect(head.diagnostics.map((d) => [d.ruleId, d.entity])).toEqual([
      ["WK8501", "two"],
      ["WK8102", "two"],
    ]);
    expect(head.success).toBe(false);
    // The SARIF carries the identity, so it can be the next run's baseline.
    expect(readBaselineIdentities(head.output).size).toBe(2);
  });

  test("a report-only finding alone passes", async () => {
    const only = [ruleFor("WK8102", "warning")];
    writeFileSync(join(dir, "a.ts"), "// flag one\nexport const x = 1;\n");
    const r = await lintCommand({ path: dir, format: "stylish", rules: only, postSynth: false, preset: PULL_REQUEST_PRESET });
    expect(r.success).toBe(true);
    expect(r.output).toContain("Preset pull-request: 0 merge-blocking findings, 1 report-only");
  });
});
