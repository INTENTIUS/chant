import { describe, test, expect } from "vitest";
import type { OpRunResult } from "./local-executor";
import { renderHuman, renderJson } from "./local-output";

const RESULT: OpRunResult = {
  op: "hello",
  totalMs: 100,
  ok: true,
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
      op: "deploy", totalMs: 50, ok: false,
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

describe("renderJson", () => {
  test("prints valid JSON parseable back to OpRunResult", () => {
    const lines: string[] = [];
    renderJson(RESULT, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as OpRunResult;
    expect(parsed.op).toBe("hello");
    expect(parsed.ok).toBe(true);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[1].outcome).toEqual({ name: "Drift", value: false });
  });
});
