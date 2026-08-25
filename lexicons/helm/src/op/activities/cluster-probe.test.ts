/**
 * Pure comparison/parsing halves of the deploy-time capability probe
 * (#1244). The exec-driven probe itself is exercised through `helmInstall`
 * in helm.test.ts, against the scripted kubectl double.
 */
import { describe, test, expect } from "vitest";
import { compareCapabilityProfile, majorMinorOf, type LiveClusterCapabilities } from "./cluster-probe";

const live: LiveClusterCapabilities = {
  kubeVersion: "v1.33.6+k3s1",
  majorMinor: "1.33",
  apiVersions: ["v1", "apps/v1", "batch/v1", "monitoring.coreos.com/v1"],
};

describe("majorMinorOf", () => {
  test("accepts every shape KUBE_VERSION_PATTERN admits, plus live gitVersions", () => {
    expect(majorMinorOf("1.33")).toBe("1.33");
    expect(majorMinorOf("1.33.6")).toBe("1.33");
    expect(majorMinorOf("v1.33.6")).toBe("1.33");
    expect(majorMinorOf("v1.33.6+k3s1")).toBe("1.33");
  });

  test("rejects the unparseable", () => {
    expect(majorMinorOf("latest")).toBeUndefined();
    expect(majorMinorOf("")).toBeUndefined();
  });
});

describe("compareCapabilityProfile", () => {
  test("matching profile has no divergences — patch skew tolerated, extra live apiVersions ignored", () => {
    expect(
      compareCapabilityProfile(
        { kubeVersion: "1.33.4", apiVersions: ["apps/v1", "monitoring.coreos.com/v1"] },
        live,
      ),
    ).toEqual([]);
  });

  test("a kubeVersion divergence names both the declared and the live version", () => {
    expect(compareCapabilityProfile({ kubeVersion: "1.31.4" }, live)).toEqual([
      "kubeVersion: profile declares 1.31.4 (1.31), cluster runs v1.33.6+k3s1 (1.33)",
    ]);
  });

  test("every missing apiVersion is named, one divergence each", () => {
    expect(
      compareCapabilityProfile(
        { apiVersions: ["missing.io/v1", "apps/v1", "alsomissing.io/v1beta1"] },
        live,
      ),
    ).toEqual([
      "apiVersion missing.io/v1: declared by the profile, not served by the cluster",
      "apiVersion alsomissing.io/v1beta1: declared by the profile, not served by the cluster",
    ]);
  });

  test("kubeVersion and apiVersion divergences accumulate", () => {
    expect(
      compareCapabilityProfile({ kubeVersion: "1.31", apiVersions: ["missing.io/v1"] }, live),
    ).toHaveLength(2);
  });

  test("a profile declaring nothing diverges from nothing", () => {
    expect(compareCapabilityProfile({}, live)).toEqual([]);
  });
});
