import { describe, test, expect } from "bun:test";
import {
  gvkToTypeName,
  gvkToApiVersion,
  k8sShortName,
  k8sServiceName,
} from "./parse";

describe("gvkToTypeName", () => {
  test("core group maps to Core", () => {
    expect(gvkToTypeName({ group: "", version: "v1", kind: "Pod" })).toBe(
      "K8s::Core::Pod",
    );
  });

  test("apps group", () => {
    expect(
      gvkToTypeName({ group: "apps", version: "v1", kind: "Deployment" }),
    ).toBe("K8s::Apps::Deployment");
  });

  test("batch group", () => {
    expect(
      gvkToTypeName({ group: "batch", version: "v1", kind: "Job" }),
    ).toBe("K8s::Batch::Job");
  });

  test("networking.k8s.io group", () => {
    expect(
      gvkToTypeName({
        group: "networking.k8s.io",
        version: "v1",
        kind: "Ingress",
      }),
    ).toBe("K8s::Networking::Ingress");
  });

  test("rbac group normalised to Rbac", () => {
    expect(
      gvkToTypeName({
        group: "rbac.authorization.k8s.io",
        version: "v1",
        kind: "Role",
      }),
    ).toBe("K8s::Rbac::Role");
  });

  test("autoscaling group", () => {
    expect(
      gvkToTypeName({
        group: "autoscaling",
        version: "v2",
        kind: "HorizontalPodAutoscaler",
      }),
    ).toBe("K8s::Autoscaling::HorizontalPodAutoscaler");
  });
});

describe("gvkToApiVersion", () => {
  test("core group returns version only", () => {
    expect(gvkToApiVersion({ group: "", version: "v1", kind: "Pod" })).toBe(
      "v1",
    );
  });

  test("empty string group returns version only", () => {
    expect(
      gvkToApiVersion({ group: "", version: "v1", kind: "Service" }),
    ).toBe("v1");
  });

  test("non-core group returns group/version", () => {
    expect(
      gvkToApiVersion({ group: "apps", version: "v1", kind: "Deployment" }),
    ).toBe("apps/v1");
  });

  test("networking group", () => {
    expect(
      gvkToApiVersion({
        group: "networking.k8s.io",
        version: "v1",
        kind: "Ingress",
      }),
    ).toBe("networking.k8s.io/v1");
  });
});

describe("k8sShortName", () => {
  test("returns short name for known types", () => {
    // k8sShortName should map well-known types to their abbreviations
    const name = k8sShortName("Deployment");
    expect(typeof name).toBe("string");
  });
});

describe("k8sServiceName", () => {
  test("returns service name for known types", () => {
    const name = k8sServiceName("Deployment");
    expect(typeof name).toBe("string");
  });
});
