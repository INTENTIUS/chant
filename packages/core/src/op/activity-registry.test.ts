import { describe, test, expect, vi, afterEach } from "vitest";
import { loadActivities, resolveActivity, type ActivityFn } from "./activity-registry";

describe("loadActivities", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@intentius/chant-lexicon-temporal/op/activities");
  });

  test("loads the lexicon activity library keyed by export name", async () => {
    const activities = await loadActivities();
    // Real export names from lexicons/temporal/src/op/activities.
    expect(activities.has("shellCmd")).toBe(true);
    expect(activities.has("chantBuild")).toBe(true);
    expect(activities.has("kubectlApply")).toBe(true);
    expect(activities.has("lifecycleDiff")).toBe(true);
    expect(typeof activities.get("shellCmd")).toBe("function");
  });

  test("throws a friendly error when the lexicon is not installed", async () => {
    vi.resetModules();
    vi.doMock("@intentius/chant-lexicon-temporal/op/activities", () => {
      throw new Error("Cannot find module");
    });
    const { loadActivities: fresh } = await import("./activity-registry");
    await expect(fresh()).rejects.toThrow(
      "no activities registered — install `@intentius/chant-lexicon-temporal`",
    );
  });
});

describe("resolveActivity", () => {
  test("resolves a known activity by name", () => {
    const fn: ActivityFn = async () => "ok";
    const map = new Map<string, ActivityFn>([["shellCmd", fn]]);
    expect(resolveActivity(map, "shellCmd")).toBe(fn);
  });

  test("throws listing known names for an unknown fn", () => {
    const map = new Map<string, ActivityFn>([
      ["shellCmd", async () => undefined],
      ["chantBuild", async () => undefined],
    ]);
    expect(() => resolveActivity(map, "nope")).toThrow(
      'no activity named "nope" (known: chantBuild, shellCmd)',
    );
  });
});

describe("loadActivities — heartbeat-shim safety", () => {
  test("the activity library loads without @temporalio/activity installed", async () => {
    // kubectlApply/helmInstall/waitForStack/gitlabPipeline heartbeat via the
    // lazy shim; if the shim statically required the SDK, this import would
    // throw (the SDK is not installed in this environment).
    const activities = await loadActivities();
    expect(activities.has("kubectlApply")).toBe(true);
    expect(activities.has("waitForStack")).toBe(true);
  });
});
