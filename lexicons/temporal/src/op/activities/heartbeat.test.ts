import { describe, test, expect } from "vitest";
import { safeHeartbeat } from "./heartbeat";

describe("safeHeartbeat", () => {
  test("no-ops outside a Temporal worker instead of throwing", () => {
    // No activity execution context and (in this env) no @temporalio/activity.
    expect(() => safeHeartbeat({ step: "test" })).not.toThrow();
    expect(() => safeHeartbeat()).not.toThrow();
  });
});
