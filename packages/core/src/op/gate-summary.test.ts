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

  // #2310: `recordGateApproval`'s push was already reported (#2309); the
  // gate's own `appendPending` push was not. The GitHub/Forgejo/Gitea step
  // summary is exactly the surface an operator working from a different
  // checkout would open, so it is where the gap mattered most.
  test("says so when this run's own append never reached the remote", () => {
    const md = gatedRunSummaryMarkdown({
      ...summary,
      pushed: false,
      pushWarning: "chant/lifecycle remote branch has moved since this run started",
    });
    expect(md).toContain("was not pushed to the remote");
    expect(md).toContain("chant/lifecycle remote branch has moved since this run started");
    expect(md).toContain("cannot see it to approve it");
  });

  test("says nothing extra when the push landed or nothing was pushed this run", () => {
    const md = gatedRunSummaryMarkdown(summary);
    expect(md).not.toContain("was not pushed");
  });

  // #2300 — the block is where a CI approver reads what they are approving,
  // so it names the plan and says the approval does not carry to the next one.
  test("names the plan the approval binds to, when the gate binds one", () => {
    const digest = `sha256:${"d".repeat(64)}`;
    const md = gatedRunSummaryMarkdown({ ...summary, planDigest: digest });
    expect(md).toContain(digest);
    expect(md).toContain("and not the next run");
  });

  test("a gate that binds no plan says nothing about one", () => {
    expect(gatedRunSummaryMarkdown(summary)).not.toContain("and not the next run");
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
