import { describe, test, expect } from "vitest";
import { alertFromWebhook, alertFromDrift } from "./parse";

describe("alertFromWebhook", () => {
  test("maps a Datadog-ish body", () => {
    const a = alertFromWebhook({ id: "dd-1", title: "API outage", source: "datadog", body: "5xx" });
    expect(a).toEqual({ id: "dd-1", title: "API outage", body: "5xx", source: "datadog" });
  });

  test("falls back to summary/message and a derived id", () => {
    const a = alertFromWebhook({ summary: "Disk almost full", message: "92% used" });
    expect(a.title).toBe("Disk almost full");
    expect(a.body).toBe("92% used");
    expect(a.id).toMatch(/^webhook-disk-almost-full/);
    expect(a.source).toBe("webhook");
  });

  test("handles an empty body", () => {
    const a = alertFromWebhook({});
    expect(a.title).toBe("untitled alert");
    expect(a.source).toBe("webhook");
  });
});

describe("alertFromDrift", () => {
  test("turns a drift entry into a triage alert", () => {
    const a = alertFromDrift({ name: "alert-webhook", type: "Deployment", category: "drifted" });
    expect(a.id).toBe("drift-alert-webhook");
    expect(a.title).toContain("Deployment alert-webhook");
    expect(a.title).toContain("drifted");
    expect(a.source).toBe("watchop");
  });
});
