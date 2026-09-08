/**
 * The pending-gate block a CI run leaves where people actually look (#2243),
 * and the second surface GitLab needs for it (#2256).
 *
 * GitHub Actions, Forgejo Actions and Gitea all hand a step a markdown
 * scratchpad through `GITHUB_STEP_SUMMARY`. GitLab CI has no equivalent at
 * all — a job's surfaces are its log and its artifacts — so `CHANT_GATE_SUMMARY`
 * names a path the generated GitLab job also declares under `artifacts:`. One
 * more environment variable, the same block, still no API call and no token.
 */

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect } from "vitest";
import { gatedRunSummaryMarkdown, writeGatedRunSummary } from "./gate-summary";

const summary = { op: "app-apply", gate: "approve-app-apply", expiresAt: "2026-09-08T00:00:00Z" };

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "chant-gate-")), name);
}

describe("gatedRunSummaryMarkdown (#2243)", () => {
  test("names the gate, the exact approve command and the ledger path", () => {
    const md = gatedRunSummaryMarkdown(summary);
    expect(md).toContain("Waiting on gate `approve-app-apply`");
    expect(md).toContain("chant approve app-apply approve-app-apply --approver <you>");
    expect(md).toContain("_gates/app-apply.jsonl");
  });
});

describe("writeGatedRunSummary surfaces (#2243, #2256)", () => {
  test("writes to GITHUB_STEP_SUMMARY where the forge sets one", () => {
    const path = tempPath("step-summary.md");
    expect(writeGatedRunSummary(summary, { GITHUB_STEP_SUMMARY: path })).toBe(path);
    expect(readFileSync(path, "utf8")).toContain("approve-app-apply");
  });

  test("writes to CHANT_GATE_SUMMARY where the forge sets none — GitLab's artifact path", () => {
    const path = tempPath("chant-gate-app-apply.md");
    expect(writeGatedRunSummary(summary, { CHANT_GATE_SUMMARY: path })).toBe(path);
    expect(readFileSync(path, "utf8")).toContain("chant approve app-apply approve-app-apply");
  });

  test("the forge's own variable wins when both are set", () => {
    const forge = tempPath("step-summary.md");
    const artifact = tempPath("chant-gate-app-apply.md");
    expect(
      writeGatedRunSummary(summary, { GITHUB_STEP_SUMMARY: forge, CHANT_GATE_SUMMARY: artifact }),
    ).toBe(forge);
    expect(existsSync(artifact)).toBe(false);
  });

  test("a run with neither variable writes nothing and reports nothing", () => {
    expect(writeGatedRunSummary(summary, {})).toBeUndefined();
  });

  test("an unwritable path is swallowed: a decided run does not change outcome over a scratchpad", () => {
    expect(writeGatedRunSummary(summary, { CHANT_GATE_SUMMARY: "/no/such/dir/gate.md" })).toBeUndefined();
  });
});
