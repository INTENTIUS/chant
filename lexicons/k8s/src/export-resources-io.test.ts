/**
 * `exportResources` I/O glue (#160), over the typed API client (chant #1074).
 *
 * `KUBECTL_RESOURCE` used to be two things at once: the set of kinds a bare
 * `chant import` sweeps, and the only way the lexicon knew how to address
 * anything. #1074 removed the second job — addressing now comes from the
 * generated operation surface plus the cluster's discovery — so what is left
 * here is the product decision about what a default import covers, and a
 * `--selector type=` import can now name any generated type, CRDs included.
 */
import { describe, test, expect } from "vitest";
import { exportResources, DEFAULT_IMPORT_TYPES } from "./export-resources";
import { fakeCluster, objectKey } from "./api/fake-cluster";
import { statusBody } from "@intentius/chant-k8s-client/testing";

const liveDeployment = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "default", uid: "d-1" },
  spec: { replicas: 3, selector: { matchLabels: { app: "web" } } },
};

const liveRayCluster = {
  apiVersion: "ray.io/v1",
  kind: "RayCluster",
  metadata: { name: "ml", namespace: "ray", uid: "r-1" },
  spec: { rayVersion: "2.9.0" },
};

describe("k8s exportResources I/O glue (#160)", () => {
  test("sweeps the default types by LIST and maps to IR", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("apps/v1", "Deployment", "web", "default")]: liveDeployment },
    });

    const ir = await exportResources({ environment: "prod" }, cluster.connector);

    expect(ir.resources.map((r) => r.type)).toContain("K8s::Apps::Deployment");
    // Cluster-wide collection paths, which is what `kubectl get -A` was doing.
    expect(cluster.layer.paths()).toContain("/apis/apps/v1/deployments");
    expect(cluster.layer.paths()).toContain("/api/v1/services");
    expect(cluster.layer.paths().some((p) => p.includes("/namespaces/"))).toBe(false);
  });

  test("a kind that errors is skipped; the rest of the sweep still maps", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("apps/v1", "Deployment", "web", "default")]: liveDeployment },
      respond: (req) =>
        req.path === "/api/v1/secrets" ? { status: 403, body: statusBody(403, "Forbidden", "rbac") } : undefined,
    });

    const ir = await exportResources({ environment: "prod" }, cluster.connector);
    expect(ir.resources.map((r) => r.type)).toContain("K8s::Apps::Deployment");
  });

  test("a type selector narrows the sweep to one kind", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("apps/v1", "Deployment", "web", "default")]: liveDeployment },
    });

    await exportResources({ environment: "prod", selector: { type: "K8s::Apps::Deployment" } }, cluster.connector);

    // One discovery request plus one collection read, and nothing else.
    expect(cluster.layer.paths()).toEqual(["/apis/apps/v1", "/apis/apps/v1/deployments"]);
  });

  test("a CRD can now be imported by name — it never could through the twenty-entry map", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("ray.io/v1", "RayCluster", "ml", "ray")]: liveRayCluster },
    });

    await exportResources({ environment: "prod", selector: { type: "K8s::Ray::RayCluster" } }, cluster.connector);
    expect(cluster.layer.paths()).toContain("/apis/ray.io/v1/rayclusters");
  });

  test("an unknown selector type sweeps nothing rather than everything", async () => {
    const cluster = fakeCluster();
    const ir = await exportResources(
      { environment: "prod", selector: { type: "K8s::NotAGroupChantKnows::Thing" } },
      cluster.connector,
    );
    expect(ir.resources).toEqual([]);
    expect(cluster.layer.requests).toHaveLength(0);
  });

  test("the default sweep still covers the workload, config, networking and RBAC kinds", () => {
    for (const type of [
      "K8s::Apps::Deployment",
      "K8s::Core::Service",
      "K8s::Core::ConfigMap",
      "K8s::Networking::Ingress",
      "K8s::Rbac::ClusterRole",
    ]) {
      expect(DEFAULT_IMPORT_TYPES).toContain(type);
    }
  });
});
