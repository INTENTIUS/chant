import { describe, test, expect } from "vitest";
import {
  waitForReady,
  ReadinessFailedError,
  readinessFor,
  isReady,
  firstTerminal,
  DEFAULT_READINESS,
  type ResourceFetcher,
  type ReadinessSpec,
} from "./wait-for-ready";
// The k8sWait profile marks ReadinessFailedError non-retryable for this activity.
import { TEMPORAL_ACTIVITY_PROFILES } from "@intentius/chant-lexicon-temporal/config";

/** A fetcher returning a scripted sequence of objects, repeating the last. */
function scriptedFetcher(sequence: Array<Record<string, unknown>>): ResourceFetcher {
  let i = 0;
  return async () => {
    const obj = sequence[Math.min(i, sequence.length - 1)];
    i++;
    return obj;
  };
}

const ready = (conds: Array<{ type: string; status: string }>, extra: Record<string, unknown> = {}) => ({
  metadata: { generation: 1 },
  status: { observedGeneration: 1, conditions: conds, ...extra },
});

const fast = { kind: "certificate", name: "tls", intervalMs: 0 };

describe("readiness model", () => {
  test("default spec = Ready condition True + observedGeneration", () => {
    expect(readinessFor(undefined, "Certificate")).toBe(DEFAULT_READINESS);
    expect(isReady(ready([{ type: "Ready", status: "True" }]), DEFAULT_READINESS)).toBe(true);
    expect(isReady(ready([{ type: "Ready", status: "False" }]), DEFAULT_READINESS)).toBe(false);
    expect(isReady(ready([]), DEFAULT_READINESS)).toBe(false);
  });

  test("observedGeneration lagging metadata.generation blocks readiness", () => {
    const obj = { metadata: { generation: 5 }, status: { observedGeneration: 4, conditions: [{ type: "Ready", status: "True" }] } };
    expect(isReady(obj, DEFAULT_READINESS)).toBe(false);
  });

  test("absent observedGeneration does not block", () => {
    const obj = { metadata: { generation: 5 }, status: { conditions: [{ type: "Ready", status: "True" }] } };
    expect(isReady(obj, DEFAULT_READINESS)).toBe(true);
  });

  test("Argo override uses health/sync, not a Ready condition", () => {
    const spec = readinessFor("argoproj.io", "Application");
    expect(spec).not.toBe(DEFAULT_READINESS);
    const healthy = { status: { health: { status: "Healthy" }, sync: { status: "Synced" } } };
    const progressing = { status: { health: { status: "Progressing" }, sync: { status: "Synced" } } };
    const degraded = { status: { health: { status: "Degraded" }, sync: { status: "OutOfSync" } } };
    expect(isReady(healthy, spec)).toBe(true);
    expect(isReady(progressing, spec)).toBe(false);
    expect(firstTerminal(degraded, spec)).toBeDefined();
    expect(firstTerminal(healthy, spec)).toBeUndefined();
  });
});

describe("waitForReady", () => {
  test("resolves once the Ready condition flips True", async () => {
    const fetcher = scriptedFetcher([
      ready([{ type: "Ready", status: "False" }]),
      ready([{ type: "Ready", status: "False" }]),
      ready([{ type: "Ready", status: "True" }]),
    ]);
    const obj = await waitForReady(fast, undefined, fetcher);
    expect((obj as any).status.conditions[0].status).toBe("True");
  });

  test("polls past not-ready reads instead of returning early", async () => {
    let calls = 0;
    const fetcher: ResourceFetcher = async () => {
      calls++;
      return calls < 3 ? ready([{ type: "Ready", status: "False" }]) : ready([{ type: "Ready", status: "True" }]);
    };
    await waitForReady(fast, undefined, fetcher);
    expect(calls).toBe(3);
  });

  test("throws ReadinessFailedError on a terminal state", async () => {
    const spec: ReadinessSpec = {
      ready: [{ conditionType: "Ready", status: "True" }],
      terminal: [{ path: "status.phase", equals: "Failed" }],
    };
    const fetcher = scriptedFetcher([{ status: { phase: "Failed" } }]);
    await expect(
      waitForReady({ ...fast, spec }, undefined, fetcher),
    ).rejects.toBeInstanceOf(ReadinessFailedError);
  });

  test("k8sWait marks ReadinessFailedError non-retryable", () => {
    expect(TEMPORAL_ACTIVITY_PROFILES.k8sWait.retry?.nonRetryableErrorTypes).toContain("ReadinessFailedError");
  });

  test("explicit spec wins over the registry", async () => {
    const spec: ReadinessSpec = { ready: [{ path: "status.state", equals: "running" }], observedGeneration: false };
    const fetcher = scriptedFetcher([{ status: { state: "running" } }]);
    const obj = await waitForReady({ kind: "widget", name: "w", intervalMs: 0, spec }, undefined, fetcher);
    expect((obj as any).status.state).toBe("running");
  });
});
