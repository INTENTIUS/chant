import { describe, expect, test } from "vitest";
import { params, setBuildParams } from "./params";

describe("params — the shared build-time-parameters object", () => {
  test("starts empty", () => {
    setBuildParams({});
    expect(params).toEqual({});
  });

  test("setBuildParams mutates the SAME object in place, never rebinds it", () => {
    const before = params;
    setBuildParams({ tier: "production", replicas: 3, enabled: true });
    expect(params).toBe(before);
    expect(params).toEqual({ tier: "production", replicas: 3, enabled: true });
  });

  test("a second call fully replaces the previous values (no stale leftover keys)", () => {
    setBuildParams({ a: "1", b: "2" });
    setBuildParams({ c: "3" });
    expect(params).toEqual({ c: "3" });
  });
});
