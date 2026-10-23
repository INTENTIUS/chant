/**
 * ApplyOp's preflight and verify steps (#3370): where the phases land in the
 * workflow, and what a failing one does when the Op runs.
 */

import { describe, test, expect } from "vitest";
import { ApplyOp, type ApplyOpConfig } from "./apply-op";
import { activity, shell } from "../builders";
import { runOpLocally, OpRunFailure } from "../local-executor";
import { memoryGateLedgerPort } from "../gate";
import type { ActivityFn, ActivityProfile } from "../activity-registry";
import type { OpConfig } from "../types";

function opConfig(config: ApplyOpConfig): OpConfig {
  return (ApplyOp(config).op as unknown as { props: OpConfig }).props;
}

function phaseNames(config: OpConfig): string[] {
  return config.phases.map((p) => p.name);
}

const single: ActivityProfile = { timeout: "5m", retry: { maximumAttempts: 1 } };
const PROFILES: Record<string, ActivityProfile> = {
  fastIdempotent: single,
  longInfra: single,
  atMostOnce: single,
};

describe("ApplyOp: preflight and verify (#3370)", () => {
  test("with neither list, the workflow is the one ApplyOp always built", () => {
    for (const base of [
      { name: "p", env: "prod" },
      { name: "p", env: "prod", target: "cloudformation" as const, delete: "gated" as const },
      { name: "p", env: "prod", target: "kubectl" as const, compensate: { command: "kubectl rollout undo deploy/web" } },
    ]) {
      const plain = JSON.stringify(opConfig(base));
      expect(JSON.stringify(opConfig({ ...base, preflight: [], verify: [] }))).toBe(plain);
      expect(JSON.stringify(opConfig({ ...base, preflight: undefined, verify: undefined }))).toBe(plain);
    }
  });

  test("preflight lands after Plan and before Approve; verify after Apply", () => {
    const check = shell("otelcol-contrib validate --config dist/collector.yaml");
    const observe = activity("rulesLoadedObserve", { env: "prod" });
    const config = opConfig({ name: "p", env: "prod", delete: "gated", preflight: [check], verify: [observe] });
    expect(phaseNames(config)).toEqual(["Build", "Plan", "Preflight", "Approve", "Apply", "Verify"]);
    expect(config.phases[2].steps).toEqual([check]);
    expect(config.phases[5].steps).toEqual([observe]);
  });

  test("ungated, preflight sits directly before Apply", () => {
    const config = opConfig({ name: "p", env: "prod", preflight: [activity("check")] });
    expect(phaseNames(config)).toEqual(["Build", "Plan", "Preflight", "Apply"]);
  });

  describe("when the Op runs", () => {
    function harness(fail: { preflight?: boolean; verify?: boolean }) {
      const calls: string[] = [];
      const fn = (tag: string, throws = false): ActivityFn => async () => {
        calls.push(tag);
        if (throws) throw new Error(`${tag} failed`);
        return tag === "lifecycleDiff" ? { drifted: false, planDigest: "sha256:abc" } : undefined;
      };
      const activities = new Map<string, ActivityFn>([
        ["chantBuild", fn("chantBuild")],
        ["lifecycleDiff", fn("lifecycleDiff")],
        ["check", fn("check", fail.preflight)],
        ["nativeApply", fn("nativeApply")],
        ["observe", fn("observe", fail.verify)],
        ["compensateApply", fn("compensateApply")],
      ]);
      return { calls, activities };
    }

    const config = opConfig({
      name: "p",
      env: "prod",
      delete: "gated",
      compensate: { command: "kubectl rollout undo deploy/web" },
      preflight: [activity("check")],
      verify: [activity("observe")],
    });

    test("a failing preflight stops before Approve: no gate fact, no apply", async () => {
      const { calls, activities } = harness({ preflight: true });
      const port = memoryGateLedgerPort();
      const err = await runOpLocally(config, activities, PROFILES, undefined, { gates: port }).catch((e) => e);
      expect(err).toBeInstanceOf(OpRunFailure);
      expect(err.result.status).toBe("fail");
      expect(calls).not.toContain("nativeApply");
      expect(calls).not.toContain("observe");
      const phasesRun = new Set(err.result.records.filter((r: { status: string }) => r.status !== "skipped").map((r: { phase: string }) => r.phase));
      expect(phasesRun.has("Approve")).toBe(false);
      expect(port.appended).toEqual([]);
    });

    test("a failing verify runs onFailure", async () => {
      const { calls, activities } = harness({ verify: true });
      const port = memoryGateLedgerPort({
        resolutions: [{ version: 1, op: "p", gate: "approve-p", resolvedBy: "alex", timestamp: new Date().toISOString(), planDigest: "sha256:abc" }],
      });
      const err = await runOpLocally(config, activities, PROFILES, undefined, { gates: port }).catch((e) => e);
      expect(err).toBeInstanceOf(OpRunFailure);
      expect(err.result.status).toBe("fail");
      expect(calls).toEqual(["chantBuild", "lifecycleDiff", "check", "nativeApply", "observe", "compensateApply"]);
    });
  });
});
