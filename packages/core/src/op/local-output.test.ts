import { describe, test, expect } from "vitest";
import type { OpRunResult } from "./local-executor";
import { renderHuman, renderJson } from "./local-output";

const RESULT: OpRunResult = {
  op: "hello",
  totalMs: 100,
  status: "ok",
  startedAt: "2026-09-05T12:00:00.000Z",
  records: [
    { phase: "Greet", fn: "shellCmd", args: { cmd: "echo hello from chant" }, status: "ok", durationMs: 42 },
    { phase: "Check", fn: "lifecycleDiff", args: { env: "prod" }, status: "ok", durationMs: 1200,
      outcome: { name: "Drift", value: false } },
  ],
};

describe("renderHuman", () => {
  test("renders phase banners, step lines, outcomes, and a summary", () => {
    const lines: string[] = [];
    renderHuman(RESULT, (l) => lines.push(l));
    const out = lines.join("\n");
    expect(out).toContain("[phase] Greet");
    expect(out).toContain("✓ shellCmd(cmd=echo hello from chant)   42ms");
    expect(out).toContain("[phase] Check");
    expect(out).toContain("[outcome] Drift=false");
    expect(out).toContain("✓ lifecycleDiff(env=prod)   1.2s");
    expect(out).toContain('Op "hello" completed in 0.1s');
  });

  test("renders failures with ✗ and the error", () => {
    const failed: OpRunResult = {
      op: "deploy", totalMs: 50, status: "fail", startedAt: "2026-09-05T12:00:00.000Z",
      records: [{ phase: "Apply", fn: "kubectlApply", args: { manifest: "x.yaml" }, status: "fail", durationMs: 10, error: "boom" }],
    };
    const lines: string[] = [];
    renderHuman(failed, (l) => lines.push(l));
    const out = lines.join("\n");
    expect(out).toContain("✗ kubectlApply(manifest=x.yaml)");
    expect(out).toContain("boom");
    expect(out).toContain('Op "deploy" failed');
  });
});

const GATED: OpRunResult = {
  op: "prod-apply",
  totalMs: 300,
  status: "gated",
  startedAt: "2026-09-05T12:00:00.000Z",
  gate: {
    version: 1, kind: "pending", op: "prod-apply", gate: "rollout-gate",
    description: "release manager signs off",
    timestamp: "2026-09-05T12:00:00.000Z",
    expiresAt: "2026-09-07T12:00:00.000Z",
    url: "https://github.com/org/repo/pull/7",
  },
  records: [
    { phase: "Apply", fn: "gate:rollout-gate", args: {}, status: "skipped", durationMs: 0 },
  ],
};

describe("renderHuman — gated (#2119)", () => {
  test("names the gate, the approve line and the expiry, and never mentions --temporal", () => {
    const lines: string[] = [];
    renderHuman(GATED, (l) => lines.push(l));
    const out = lines.join("\n");
    expect(out).toContain('Op "prod-apply" is gated on "rollout-gate"');
    expect(out).toContain("release manager signs off");
    expect(out).toContain("chant approve prod-apply rollout-gate");
    expect(out).toContain("https://github.com/org/repo/pull/7");
    expect(out).toContain("expires : 2026-09-07T12:00:00.000Z");
    expect(out).not.toContain("--temporal");
  });

  test("shows the approver on a gate that passed", () => {
    const lines: string[] = [];
    renderHuman({
      op: "prod-apply", totalMs: 10, status: "ok", startedAt: "2026-09-05T12:00:00.000Z",
      records: [{
        phase: "Apply", fn: "gate:rollout-gate", args: {}, status: "ok", durationMs: 1,
        approval: { gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-09-05T11:00:00.000Z" },
      }],
    }, (l) => lines.push(l));
    expect(lines.join("\n")).toContain("[approved] alex at 2026-09-05T11:00:00.000Z");
  });
});

describe("renderJson", () => {
  test("a gated result carries the gate, its expiry and the approve command", () => {
    const lines: string[] = [];
    renderJson(GATED, (l) => lines.push(l));
    const parsed = JSON.parse(lines[0]) as OpRunResult & { approve: string };
    expect(parsed.status).toBe("gated");
    expect(parsed.gate?.gate).toBe("rollout-gate");
    expect(parsed.gate?.expiresAt).toBe("2026-09-07T12:00:00.000Z");
    expect(parsed.approve).toBe("chant approve prod-apply rollout-gate");
  });

  test("prints valid JSON parseable back to OpRunResult", () => {
    const lines: string[] = [];
    renderJson(RESULT, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as OpRunResult;
    expect(parsed.op).toBe("hello");
    expect(parsed.status).toBe("ok");
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[1].outcome).toEqual({ name: "Drift", value: false });
  });
});
