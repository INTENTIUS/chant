import { describe, test, expect } from "vitest";
import { loadActivities, loadProfiles, resolveActivity, type ActivityFn } from "./activity-registry";
import { ACTIVITY_PROFILES } from "./activity-profiles";

describe("loadActivities", () => {
  test("loads core's own activity library keyed by export name", async () => {
    const activities = await loadActivities();
    // Real export names from packages/core/src/op/activities.
    expect(activities.has("shellCmd")).toBe(true);
    expect(activities.has("chantBuild")).toBe(true);
    expect(activities.has("waitForStack")).toBe(true);
    expect(activities.has("lifecycleDiff")).toBe(true);
    expect(typeof activities.get("shellCmd")).toBe("function");
  });

  /**
   * chant #2114 — the base library used to live in a hosting lexicon,
   * dynamically imported, and `loadActivities` threw "no activities
   * registered" without it. The activities are core's own now and the
   * import is static, so an empty lexicon list resolves the whole base surface in
   * a project that has installed nothing but chant.
   */
  test("every base activity resolves with no lexicons configured", async () => {
    const a = await loadActivities([]);
    for (const fn of [
      "shellCmd", "chantBuild", "waitForStack", "lifecycleSnapshot", "lifecycleDiff",
      "httpCheck", "chantTeardown", "envTeardown", "convergeTick", "reconcilePr",
      "guardValidate", "policyGate", "workflowSupplyChainAudit", "pipelineSupplyChainAudit",
      "lexiconUpgrade", "nativeApply",
    ]) {
      expect(typeof a.get(fn), `${fn} should resolve from the base library`).toBe("function");
    }
  });

  test("loadProfiles returns core's table", async () => {
    expect(await loadProfiles()).toBe(ACTIVITY_PROFILES);
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

describe("loadActivities — no runtime SDK on the path", () => {
  test("the activity library loads with no orchestrator SDK installed", async () => {
    // The base activities used to reach an orchestrator SDK for heartbeats and
    // its non-retryable failure type. Neither is a core dependency, and this
    // import would throw if one crept back in.
    const activities = await loadActivities();
    expect(activities.has("waitForStack")).toBe(true);
    expect(activities.has("chantBuild")).toBe(true);
    expect(activities.has("policyGate")).toBe(true);
  });
});

// Cloud appliers were relocated out of a single lexicon into their own
// lexicons (#706); the loader pulls them in per the project's configured
// `lexicons`. Proves the relocation resolves end-to-end.
describe("loadActivities — multi-lexicon (#706)", () => {
  test("base (no lexicons): core activities present, product activities absent", async () => {
    const a = await loadActivities();
    expect(a.has("waitForStack")).toBe(true); // core base
    expect(a.has("shellCmd")).toBe(true); // core base
    expect(a.has("kubectlApply")).toBe(false); // relocated to k8s (#809)
    expect(a.has("k3dUp")).toBe(false); // relocated to k8s (#809), then k3d (#1410)
    expect(a.has("gcpApply")).toBe(false); // relocated to gcp
    expect(a.has("flociUp")).toBe(false); // relocated to aws
    expect(a.has("azGroupEnsure")).toBe(false); // relocated to azure
  });

  test("gcp lexicon contributes the GCP applier", async () => {
    const a = await loadActivities(["gcp"]);
    expect(a.has("gcpApply")).toBe(true);
    expect(a.has("waitForStack")).toBe(true); // base still loaded alongside
  });

  test("k8s lexicon contributes kubectl / argo activities (#809)", async () => {
    const a = await loadActivities(["k8s"]);
    expect(a.has("kubectlApply")).toBe(true);
    expect(a.has("k3dUp")).toBe(false); // moved on to the k3d lexicon (#1410)
    expect(a.has("k3dDown")).toBe(false); // moved on to the k3d lexicon (#1410)
    expect(a.has("waitForArgoSync")).toBe(true);
    expect(a.has("waitForStack")).toBe(true); // base still loaded alongside
  });

  test("k3d lexicon contributes the local-cluster lifecycle (#1410)", async () => {
    const a = await loadActivities(["k3d"]);
    expect(a.has("k3dUp")).toBe(true);
    expect(a.has("k3dDown")).toBe(true);
    expect(a.has("waitForStack")).toBe(true); // base still loaded alongside
  });

  test("aws lexicon contributes the Floci lifecycle", async () => {
    const a = await loadActivities(["aws"]);
    expect(a.has("flociUp")).toBe(true);
    expect(a.has("flociDown")).toBe(true);
  });

  test("azure lexicon contributes the resource-group lifecycle + ARM applier", async () => {
    const a = await loadActivities(["azure"]);
    expect(a.has("azGroupEnsure")).toBe(true);
    expect(a.has("azGroupDelete")).toBe(true);
    expect(a.has("azApply")).toBe(true);
  });

  test("cedar lexicon contributes the dogwood replay activities (#1661)", async () => {
    const a = await loadActivities(["cedar"]);
    expect(a.has("dogwoodReplay")).toBe(true);
    expect(a.has("dogwoodReplayReport")).toBe(true);
    expect(a.has("waitForStack")).toBe(true); // base still loaded alongside
  });

  test("unknown lexicon is skipped without throwing", async () => {
    const a = await loadActivities(["definitely-not-a-lexicon"]);
    expect(a.has("waitForStack")).toBe(true); // core base still loads
  });
});
