import { describe, test, expect } from "vitest";
import {
  waitForArgoSync,
  ArgoSyncFailedError,
  type ArgoAppStatus,
  type ArgoStatusFetcher,
} from "./argo";
import { TEMPORAL_ACTIVITY_PROFILES } from "../../config";

/** A fetcher that returns a scripted sequence of statuses, repeating the last. */
function scriptedFetcher(sequence: ArgoAppStatus[]): ArgoStatusFetcher {
  let i = 0;
  return async () => {
    const status = sequence[Math.min(i, sequence.length - 1)];
    i++;
    return status;
  };
}

const fast = { appName: "guestbook", intervalMs: 0 };

describe("waitForArgoSync", () => {
  test("resolves once the Application is Healthy and Synced", async () => {
    const fetcher = scriptedFetcher([
      { health: "Progressing", sync: "OutOfSync" },
      { health: "Progressing", sync: "Synced" },
      { health: "Healthy", sync: "Synced" },
    ]);
    const result = await waitForArgoSync(fast, undefined, fetcher);
    expect(result).toEqual({ health: "Healthy", sync: "Synced" });
  });

  test("does not resolve while Synced but still Progressing", async () => {
    // First Healthy+Synced read is the third; ensure it polls past the
    // Progressing reads rather than returning early.
    let calls = 0;
    const fetcher: ArgoStatusFetcher = async () => {
      calls++;
      if (calls < 3) return { health: "Progressing", sync: "Synced" };
      return { health: "Healthy", sync: "Synced" };
    };
    await waitForArgoSync(fast, undefined, fetcher);
    expect(calls).toBe(3);
  });

  test("throws ArgoSyncFailedError when the Application is Degraded", async () => {
    const fetcher = scriptedFetcher([{ health: "Degraded", sync: "Synced" }]);
    await expect(waitForArgoSync(fast, undefined, fetcher)).rejects.toBeInstanceOf(
      ArgoSyncFailedError,
    );
  });

  test("throws ArgoSyncFailedError when the Application is Missing", async () => {
    const fetcher = scriptedFetcher([{ health: "Missing", sync: "OutOfSync" }]);
    await expect(waitForArgoSync(fast, undefined, fetcher)).rejects.toThrow(/Missing/);
  });

  test("honors an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = scriptedFetcher([{ health: "Progressing", sync: "OutOfSync" }]);
    await expect(waitForArgoSync(fast, controller.signal, fetcher)).rejects.toThrow(/aborted/);
  });
});

describe("argoSync profile", () => {
  test("is exported with a long timeout and 60s heartbeat", () => {
    const p = TEMPORAL_ACTIVITY_PROFILES.argoSync;
    expect(p.startToCloseTimeout).toBe("30m");
    expect(p.heartbeatTimeout).toBe("60s");
  });

  test("treats ArgoSyncFailedError as non-retryable", () => {
    expect(TEMPORAL_ACTIVITY_PROFILES.argoSync.retry?.nonRetryableErrorTypes).toContain(
      "ArgoSyncFailedError",
    );
  });
});
