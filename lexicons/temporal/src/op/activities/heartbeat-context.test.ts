import { describe, test, expect, vi } from "vitest";

// Positive path: prove the shim actually heartbeats once `@temporalio/activity`
// is present. The SDK isn't installed in this repo, so we virtual-mock it with a
// fake `Context` whose `heartbeat` we can observe. Lives in its own file so the
// module-level cache in heartbeat.ts starts fresh (vitest isolates files), and
// so heartbeat.test.ts can keep exercising the no-SDK path unmocked.
const { heartbeat } = vi.hoisted(() => ({ heartbeat: vi.fn() }));

vi.mock("@temporalio/activity", () => ({
  Context: { current: () => ({ heartbeat }) },
}));

describe("safeHeartbeat with @temporalio/activity present", () => {
  test("heartbeats once the lazy import resolves", async () => {
    const { safeHeartbeat } = await import("./heartbeat");

    // First call only kicks off the one-time lazy load and returns immediately.
    safeHeartbeat({ step: "first" });
    expect(heartbeat).not.toHaveBeenCalled();

    // After the dynamic import settles, subsequent calls heartbeat through to
    // the (mocked) activity Context, preserving the passed details.
    await vi.waitFor(() => {
      safeHeartbeat({ step: "after-load" });
      expect(heartbeat).toHaveBeenCalledWith({ step: "after-load" });
    });
  });
});
