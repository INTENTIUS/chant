import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  classifyAlert,
  gatherContext,
  proposeRemediation,
  notifyOutcome,
  type Alert,
} from "./triage";

const alert: Alert = { id: "a1", title: "API outage in prod", source: "datadog" };

describe("triage activities (stub path)", () => {
  // Ensure the deterministic stub path — never hit the real API in CI.
  const saved = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  });

  test("classifyAlert maps keywords to severity", async () => {
    expect((await classifyAlert({ id: "1", title: "API outage" })).severity).toBe("critical");
    expect((await classifyAlert({ id: "2", title: "request failed" })).severity).toBe("high");
    expect((await classifyAlert({ id: "3", title: "latency degraded" })).severity).toBe("medium");
    expect((await classifyAlert({ id: "4", title: "nightly report ready" })).severity).toBe("low");
  });

  test("gatherContext returns signals for the source", async () => {
    const ctx = await gatherContext(alert);
    expect(ctx.signals.length).toBeGreaterThan(0);
    expect(ctx.signals[0]).toContain("datadog");
  });

  test("proposeRemediation (stub) flags high/critical as risky", async () => {
    const classification = await classifyAlert(alert);
    const context = await gatherContext(alert);
    const r = await proposeRemediation({ alert, classification, context });
    expect(r.summary).toContain(alert.title);
    expect(r.risky).toBe(true); // critical → risky
  });

  test("proposeRemediation (stub) marks low severity as not risky", async () => {
    const classification = await classifyAlert({ id: "5", title: "info: cache warmed" });
    const context = await gatherContext({ id: "5", title: "info: cache warmed" });
    const r = await proposeRemediation({
      alert: { id: "5", title: "info: cache warmed" },
      classification,
      context,
    });
    expect(r.risky).toBe(false);
  });

  test("notifyOutcome runs without throwing", async () => {
    await expect(
      notifyOutcome({ alert, remediation: { summary: "x", risky: false }, approved: true }),
    ).resolves.toBeUndefined();
  });
});
