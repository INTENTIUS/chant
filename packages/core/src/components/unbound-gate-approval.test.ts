/**
 * The warning a release ahead of environment- and plan-bound component gate
 * approvals (chant #2574). The gate decision itself must not change.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityRegistry } from "./capability";
import { runComponentDeploy, type DriverComponent } from "./driver";
import { memoryGateLedgerPort } from "../op/gate";
import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";
import { resetUnboundGateApprovalWarnings, warnOnUnboundComponentApproval } from "./unbound-gate-approval";

const NOW = "2026-09-05T12:00:00.000Z";

const component: DriverComponent = {
  name: "search-service",
  deploy: [{ phase: "Apply", steps: [{ kind: "gate", gate: "approve-prod" }, { kind: "ecs-deploy" }] }],
};

const pending: PendingGateRecord = {
  version: 1, kind: "pending", op: "search-service", gate: "approve-prod",
  timestamp: "2026-09-05T10:00:00.000Z", expiresAt: "2026-09-07T10:00:00.000Z",
};

const unbound: GateResolutionRecord = {
  version: 1, op: "search-service", gate: "approve-prod",
  resolvedBy: "alex", timestamp: "2026-09-05T11:00:00.000Z",
};

function registry(calls: string[]): CapabilityRegistry {
  const r = new CapabilityRegistry();
  r.register({ kind: "ecs-deploy", async run() { calls.push("ecs-deploy"); return { ok: true }; } });
  return r;
}

describe("warnOnUnboundComponentApproval (#2574)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetUnboundGateApprovalWarnings();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("warns once per component and gate when the approval records no plan", () => {
    expect(warnOnUnboundComponentApproval("search-service", "approve-prod", "prod", unbound)).toBe(true);
    expect(warnOnUnboundComponentApproval("search-service", "approve-prod", "staging", unbound)).toBe(false);
    expect(warnOnUnboundComponentApproval("orders-table", "approve-prod", "prod", { ...unbound, op: "orders-table" })).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain('gate "approve-prod" on component "search-service" passed in "prod"');
    expect(line).toContain("From the next chant release");
    expect(line).toContain("chant approve search-service approve-prod");
    expect(line).toContain("issues/2574");
  });

  it("says nothing for an approval that records a plan", () => {
    const bound = { ...unbound, planDigest: `sha256:${"a".repeat(64)}` };
    expect(warnOnUnboundComponentApproval("search-service", "approve-prod", "prod", bound)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a deploy passes the gate exactly as before, and warns", async () => {
    const calls: string[] = [];
    const result = await runComponentDeploy(
      component, { env: "prod", component: "search-service" }, registry(calls), {}, undefined,
      { port: memoryGateLedgerPort({ pending: [pending], resolutions: [unbound] }), now: NOW },
    );
    expect(result.status).toBe("ok");
    expect(calls).toEqual(["ecs-deploy"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a gated deploy does not warn", async () => {
    const calls: string[] = [];
    const result = await runComponentDeploy(
      component, { env: "prod", component: "search-service" }, registry(calls), {}, undefined,
      { port: memoryGateLedgerPort(), now: NOW },
    );
    expect(result.status).toBe("gated");
    expect(warn).not.toHaveBeenCalled();
  });
});
