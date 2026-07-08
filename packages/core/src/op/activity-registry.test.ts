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

// Cloud appliers were relocated out of the temporal lexicon into their own
// lexicons (#706); the loader pulls them in per the project's configured
// `lexicons`. Proves the relocation resolves end-to-end.
describe("loadActivities — multi-lexicon (#706)", () => {
  test("base (no lexicons): temporal activities present, cloud appliers absent", async () => {
    const a = await loadActivities();
    expect(a.has("kubectlApply")).toBe(true); // temporal base
    expect(a.has("k3dUp")).toBe(true); // cloud-agnostic, stays in temporal
    expect(a.has("gcpApply")).toBe(false); // relocated to gcp
    expect(a.has("flociUp")).toBe(false); // relocated to aws
    expect(a.has("azGroupEnsure")).toBe(false); // relocated to azure
  });

  test("gcp lexicon contributes the GCP applier", async () => {
    const a = await loadActivities(["gcp"]);
    expect(a.has("gcpApply")).toBe(true);
    expect(a.has("kubectlApply")).toBe(true); // base still loaded alongside
  });

  test("aws lexicon contributes the Floci lifecycle", async () => {
    const a = await loadActivities(["aws"]);
    expect(a.has("flociUp")).toBe(true);
    expect(a.has("flociDown")).toBe(true);
  });

  test("azure lexicon contributes the resource-group lifecycle", async () => {
    const a = await loadActivities(["azure"]);
    expect(a.has("azGroupEnsure")).toBe(true);
    expect(a.has("azGroupDelete")).toBe(true);
  });

  test("unknown lexicon is skipped without throwing", async () => {
    const a = await loadActivities(["definitely-not-a-lexicon"]);
    expect(a.has("kubectlApply")).toBe(true);
  });
});
