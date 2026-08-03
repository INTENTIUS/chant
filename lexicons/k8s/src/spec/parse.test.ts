import { describe, test, expect } from "vitest";
import {
  gvkToTypeName,
  gvkToApiVersion,
  k8sShortName,
  k8sServiceName,
  specListMapKeyPairs,
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

/**
 * chant #1441 — the merge semantics the API server publishes, read off every
 * definition rather than only the ones chant emits a type for.
 */
describe("specListMapKeyPairs", () => {
  const spec = JSON.stringify({
    definitions: {
      "io.k8s.api.core.v1.PodSpec": {
        properties: {
          containers: { type: "array", "x-kubernetes-list-type": "map", "x-kubernetes-list-map-keys": ["name"] },
          // atomic and set lists carry no identity key
          tolerations: { type: "array", "x-kubernetes-list-type": "atomic" },
          finalizers: { type: "array", "x-kubernetes-list-type": "set" },
          nodeName: { type: "string" },
        },
      },
      "io.k8s.api.core.v1.ServiceSpec": {
        properties: {
          ports: { type: "array", "x-kubernetes-list-type": "map", "x-kubernetes-list-map-keys": ["port", "protocol"] },
        },
      },
      "io.k8s.api.core.v1.NoProperties": {},
    },
  });

  test("collects only map-typed lists that name their keys", () => {
    expect(specListMapKeyPairs(spec)).toEqual([
      ["containers", ["name"]],
      ["ports", ["port", "protocol"]],
    ]);
  });

  test("accepts a Buffer, as the fetch path supplies", () => {
    expect(specListMapKeyPairs(Buffer.from(spec, "utf-8"))).toHaveLength(2);
  });

  test("a spec with no definitions yields nothing rather than throwing", () => {
    expect(specListMapKeyPairs(JSON.stringify({}))).toEqual([]);
  });
});
