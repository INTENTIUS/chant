/**
 * `describeResources` over the typed API client (chant #1074).
 *
 * Every case drives the real client against a literal kubeconfig with the
 * transport faked, so no ambient kubeconfig is read and no cluster is
 * contacted. The tri-state contract (chant #1089) and the cluster binding
 * (chant #1100/#1155) are asserted through the new path, since both had to
 * survive the move off `kubectl` unchanged.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const loadChantConfigMock = vi.fn();
vi.mock("@intentius/chant/config", () => ({
  loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args),
}));

const { describeResources } = await import("./describe-resources");
const { fakeCluster, objectKey } = await import("./api/fake-cluster");
const { defaultK8sConnector } = await import("./api/connect");
const { fakeKubeconfig, statusBody } = await import("@intentius/chant-k8s-client/testing");

type Entity = { name: string; entityType: string; props: Record<string, unknown> };

function makeEntities(records: Entity[]) {
  return new Map(records.map((r) => [r.name, { entityType: r.entityType, props: r.props }]));
}

const web = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: {
    name: "web",
    namespace: "prod",
    uid: "uid-1",
    creationTimestamp: "2026-05-01T00:00:00Z",
    resourceVersion: "7",
    labels: { app: "web" },
  },
  status: { readyReplicas: 3, replicas: 3 },
};

const webSvc = {
  apiVersion: "v1",
  kind: "Service",
  metadata: { name: "web-svc", namespace: "prod", uid: "uid-2", creationTimestamp: "2026-05-01T00:00:00Z" },
};

describe("k8s describeResources", () => {
  beforeEach(() => {
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({ config: {} });
  });

  test("reads each declared entity through the API and maps it to ResourceMetadata", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod")]: web,
        [objectKey("v1", "Service", "web-svc", "prod")]: webSvc,
      },
    });

    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["web", "webSvc"],
        entities: makeEntities([
          { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } },
          { name: "webSvc", entityType: "K8s::Core::Service", props: { metadata: { name: "web-svc", namespace: "prod" } } },
        ]),
      },
      cluster.connector,
    );

    expect(result.resources.web).toMatchObject({
      type: "K8s::Apps::Deployment",
      physicalId: "uid-1",
      status: "READY",
      lastUpdated: "2026-05-01T00:00:00Z",
      attributes: expect.objectContaining({ namespace: "prod", labels: { app: "web" }, resourceVersion: "7" }),
    });
    expect(result.resources.webSvc).toMatchObject({ type: "K8s::Core::Service", physicalId: "uid-2", status: "PRESENT" });

    // The paths came from the cluster's discovery, not from a table.
    expect(cluster.layer.paths()).toContain("/apis/apps/v1/namespaces/prod/deployments/web");
    expect(cluster.layer.paths()).toContain("/api/v1/namespaces/prod/services/web-svc");
  });

  test("a NotFound leaves the entity out of both maps — an absence, the only shape that becomes a create", async () => {
    const cluster = fakeCluster();
    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["missing"],
        entities: makeEntities([
          { name: "missing", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "missing", namespace: "prod" } } },
        ]),
      },
      cluster.connector,
    );

    expect(result.resources).toEqual({});
    expect(result.unobserved ?? {}).toEqual({});
  });

  // The headline of chant #1074: the twenty-entry map is gone, so a CRD is an
  // ordinary read rather than a permanent hole.
  test("a CRD is observed like anything else — no KUBECTL_RESOURCE entry required", async () => {
    const rayCluster = {
      apiVersion: "ray.io/v1",
      kind: "RayCluster",
      metadata: { name: "ml", namespace: "ray", uid: "uid-ray", creationTimestamp: "2026-05-01T00:00:00Z" },
      status: { phase: "ready" },
    };
    const cluster = fakeCluster({ objects: { [objectKey("ray.io/v1", "RayCluster", "ml", "ray")]: rayCluster } });

    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["ml"],
        entities: makeEntities([
          { name: "ml", entityType: "K8s::Ray::RayCluster", props: { metadata: { name: "ml", namespace: "ray" } } },
        ]),
      },
      cluster.connector,
    );

    expect(result.unobserved ?? {}).toEqual({});
    expect(result.resources.ml).toMatchObject({ type: "K8s::Ray::RayCluster", physicalId: "uid-ray", status: "ready" });
    expect(cluster.layer.paths()).toContain("/apis/ray.io/v1/namespaces/ray/rayclusters/ml");
  });

  test.each([
    ["K8s::Argo::Application", "argoproj.io/v1alpha1", "Application", "applications"],
    ["K8s::CertManager::Certificate", "cert-manager.io/v1", "Certificate", "certificates"],
    ["K8s::Rbac::ClusterRole", "rbac.authorization.k8s.io/v1", "ClusterRole", "clusterroles"],
    ["K8s::Batch::CronJob", "batch/v1", "CronJob", "cronjobs"],
    ["K8s::Networking::Ingress", "networking.k8s.io/v1", "Ingress", "ingresses"],
  ])("%s addresses %s %s at /%s", async (entityType, apiVersion, kind, plural) => {
    const clusterScoped = kind === "ClusterRole";
    const object = {
      apiVersion,
      kind,
      metadata: { name: "x", ...(clusterScoped ? {} : { namespace: "prod" }), uid: `uid-${kind}` },
    };
    const cluster = fakeCluster({
      objects: { [objectKey(apiVersion, kind, "x", clusterScoped ? undefined : "prod")]: object },
    });

    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["x"],
        entities: makeEntities([
          { name: "x", entityType, props: { metadata: { name: "x", ...(clusterScoped ? {} : { namespace: "prod" }) } } },
        ]),
      },
      cluster.connector,
    );

    expect(result.resources.x?.physicalId).toBe(`uid-${kind}`);
    expect(cluster.layer.paths().some((p) => p.endsWith(`/${plural}/x`))).toBe(true);
  });

  test("an entity type chant has no address for at all is unobserved, never absent", async () => {
    const cluster = fakeCluster();
    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["exotic"],
        entities: makeEntities([
          { name: "exotic", entityType: "K8s::NotAGroupChantKnows::Thing", props: { metadata: { name: "x" } } },
        ]),
      },
      cluster.connector,
    );

    expect(result.resources).toEqual({});
    expect(result.unobserved?.exotic).toMatchObject({
      type: "K8s::NotAGroupChantKnows::Thing",
      reason: "unsupported-kind",
    });
    // Nothing was asked of the cluster for it.
    expect(cluster.layer.paths().some((p) => p.includes("Thing"))).toBe(false);
  });

  // chant #1089 — a failure that is not a NotFound proves nothing about
  // existence, and must not reach the change set as an absence.
  test.each([
    [401, "Unauthorized", "no-credentials"],
    [403, "Forbidden", "no-credentials"],
    [500, "InternalError", "read-failed"],
  ])("HTTP %i is reported unobserved (%s → %s)", async (code, reason, expected) => {
    const cluster = fakeCluster({
      respond: (req) =>
        req.path.endsWith("/deployments/web") ? { status: code, body: statusBody(code, reason, "nope") } : undefined,
    });

    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["web"],
        entities: makeEntities([
          { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } },
        ]),
      },
      cluster.connector,
    );

    expect(result.resources).toEqual({});
    expect(result.unobserved?.web?.reason).toBe(expected);
  });

  test("an unreachable API server is no-binding, not an empty cluster", async () => {
    const cluster = fakeCluster({
      respond: () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6443");
      },
    });

    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["web"],
        entities: makeEntities([
          { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } },
        ]),
      },
      cluster.connector,
    );

    expect(result.resources).toEqual({});
    expect(result.unobserved?.web?.reason).toBe("no-binding");
  });

  test("a kind the cluster does not serve is a real absence (nothing of that kind can exist)", async () => {
    // A cluster that serves only core v1 — so apps/v1 discovery 404s.
    const cluster = fakeCluster({ serves: ["K8s::Core::Service"] });
    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["web"],
        entities: makeEntities([
          { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } },
        ]),
      },
      cluster.connector,
    );

    expect(result.resources).toEqual({});
    expect(result.unobserved ?? {}).toEqual({});
  });

  test("--owned withholds an unmarked live object as `filtered`, never as absent (#1089)", async () => {
    const cluster = fakeCluster({ objects: { [objectKey("apps/v1", "Deployment", "web", "prod")]: web } });
    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["web"],
        entities: makeEntities([
          { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } },
        ]),
        owned: true,
      },
      cluster.connector,
    );

    expect(result.resources).toEqual({});
    expect(result.unobserved?.web?.reason).toBe("filtered");
  });

  test("status derivation is unchanged: phase, ready/total, or PRESENT", async () => {
    const progressing = { ...web, status: { readyReplicas: 1, replicas: 3 } };
    const pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "p", namespace: "prod", uid: "uid-p" },
      status: { phase: "Running" },
    };
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod")]: progressing,
        [objectKey("v1", "Pod", "p", "prod")]: pod,
        [objectKey("v1", "Service", "web-svc", "prod")]: webSvc,
      },
    });

    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["web", "p", "webSvc"],
        entities: makeEntities([
          { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } },
          { name: "p", entityType: "K8s::Core::Pod", props: { metadata: { name: "p", namespace: "prod" } } },
          { name: "webSvc", entityType: "K8s::Core::Service", props: { metadata: { name: "web-svc", namespace: "prod" } } },
        ]),
      },
      cluster.connector,
    );

    expect(result.resources.web.status).toBe("PROGRESSING(1/3)");
    expect(result.resources.p.status).toBe("Running");
    expect(result.resources.webSvc.status).toBe("PRESENT");
  });

  test("a cluster-scoped resource is addressed without a namespace segment", async () => {
    const ns = { apiVersion: "v1", kind: "Namespace", metadata: { name: "mynamespace", uid: "uid-ns" }, status: { phase: "Active" } };
    const cluster = fakeCluster({ objects: { [objectKey("v1", "Namespace", "mynamespace")]: ns } });

    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["ns"],
        entities: makeEntities([{ name: "ns", entityType: "K8s::Core::Namespace", props: { metadata: { name: "mynamespace" } } }]),
      },
      cluster.connector,
    );

    expect(result.resources.ns.status).toBe("Active");
    expect(cluster.layer.paths()).toContain("/api/v1/namespaces/mynamespace");
  });

  test("entity without metadata.name is unobserved — nothing was queried", async () => {
    const cluster = fakeCluster();
    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["broken"],
        entities: makeEntities([{ name: "broken", entityType: "K8s::Apps::Deployment", props: {} }]),
      },
      cluster.connector,
    );

    expect(result.resources).toEqual({});
    expect(result.unobserved?.broken?.reason).toBe("read-failed");
    expect(cluster.layer.paths().some((p) => p.includes("/deployments/"))).toBe(false);
  });

  test("reads run concurrently — 40 entities are not 40 serial round trips", async () => {
    const objects: Record<string, (typeof web)> = {};
    const entities: Entity[] = [];
    for (let i = 0; i < 40; i++) {
      objects[objectKey("apps/v1", "Deployment", `web-${i}`, "prod")] = {
        ...web,
        metadata: { ...web.metadata, name: `web-${i}`, uid: `uid-${i}` },
      };
      entities.push({
        name: `web-${i}`,
        entityType: "K8s::Apps::Deployment",
        props: { metadata: { name: `web-${i}`, namespace: "prod" } },
      });
    }

    let inFlight = 0;
    let peak = 0;
    const cluster = fakeCluster({
      objects,
      respond: () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        queueMicrotask(() => inFlight--);
        return undefined;
      },
    });

    const result = await describeResources(
      { environment: "prod", buildOutput: "", entityNames: entities.map((e) => e.name), entities: makeEntities(entities) },
      cluster.connector,
    );

    expect(Object.keys(result.resources)).toHaveLength(40);
    expect(peak).toBeGreaterThan(1);
    // One discovery request for apps/v1 serves all forty reads.
    expect(cluster.layer.paths().filter((p) => p === "/apis/apps/v1")).toHaveLength(1);
  });

  // chant #1100/#1155 — the binding carries over to the typed client
  // unchanged. These drive the REAL connector, so `resolveClusterTarget` runs
  // for real; only the kubeconfig and the transport are supplied.
  describe("cluster binding (chant #1100, through the typed client)", () => {
    const twoContexts = fakeKubeconfig({
      contexts: [
        { name: "prod-eks", cluster: "prod", user: "prod-user" },
        { name: "staging-eks", cluster: "staging", user: "staging-user" },
      ],
      currentContext: "prod-eks",
    });

    function entities() {
      return makeEntities([
        { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } },
      ]);
    }

    test("bound and ambient context matches: observes explicitly against the bound context", async () => {
      loadChantConfigMock.mockResolvedValue({ config: { k8s: { profiles: { prod: { context: "prod-eks" } } } } });
      const cluster = fakeCluster({
        kubeconfig: twoContexts,
        objects: { [objectKey("apps/v1", "Deployment", "web", "prod")]: web },
      });

      const result = await describeResources(
        { environment: "prod", buildOutput: "", entityNames: ["web"], entities: entities() },
        // The real connector, with only the kubeconfig and transport supplied.
        (o) => defaultK8sConnector({ ...o, client: { kubeconfig: twoContexts, requestLayer: cluster.layer } }),
      );

      expect(result.resources.web).toMatchObject({ type: "K8s::Apps::Deployment", physicalId: "uid-1", status: "READY" });
    });

    test("bound and ambient context mismatches: refuses loudly instead of reading the wrong cluster", async () => {
      loadChantConfigMock.mockResolvedValue({ config: { k8s: { profiles: { prod: { context: "prod-eks" } } } } });
      const ambientIsStaging = fakeKubeconfig({
        contexts: [
          { name: "prod-eks", cluster: "prod", user: "prod-user" },
          { name: "staging-eks", cluster: "staging", user: "staging-user" },
        ],
        currentContext: "staging-eks",
      });
      const cluster = fakeCluster({ kubeconfig: ambientIsStaging });

      await expect(
        describeResources({ environment: "prod", buildOutput: "", entityNames: ["web"], entities: entities() }, (o) =>
          defaultK8sConnector({ ...o, client: { kubeconfig: ambientIsStaging, requestLayer: cluster.layer } }),
        ),
      ).rejects.toThrow(/environment "prod".*"prod-eks".*"staging-eks"/s);

      // Refused before a single request left the process.
      expect(cluster.layer.requests).toHaveLength(0);
    });

    test("unbound: the kubeconfig's own context is used, and the fallback is visible", async () => {
      loadChantConfigMock.mockResolvedValue({ config: {} });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const cluster = fakeCluster({
        kubeconfig: twoContexts,
        objects: { [objectKey("apps/v1", "Deployment", "web", "prod")]: web },
      });

      const result = await describeResources(
        { environment: "prod", buildOutput: "", entityNames: ["web"], entities: entities() },
        (o) => defaultK8sConnector({ ...o, client: { kubeconfig: twoContexts, requestLayer: cluster.layer } }),
      );

      expect(result.resources.web).toMatchObject({ physicalId: "uid-1", status: "READY" });
      const bindingWarning = warnSpy.mock.calls.find((c) => String(c[0]).includes("no cluster binding"));
      expect(bindingWarning?.[0]).toContain('environment "prod"');
      expect(bindingWarning?.[0]).toContain("k8s.profiles.prod.context");
      warnSpy.mockRestore();
    });

    test("a bound context the kubeconfig does not have refuses with the context name", async () => {
      loadChantConfigMock.mockResolvedValue({ config: { k8s: { profiles: { prod: { context: "gone-eks" } } } } });
      const oneContext = fakeKubeconfig({ contexts: [{ name: "prod-eks" }], currentContext: "prod-eks" });
      const cluster = fakeCluster({ kubeconfig: oneContext });

      const result = await describeResources(
        { environment: "prod", buildOutput: "", entityNames: ["web"], entities: entities() },
        (o) => defaultK8sConnector({ ...o, client: { kubeconfig: oneContext, requestLayer: cluster.layer } }),
      ).catch(() => undefined);

      // resolveClusterTarget refuses on the mismatch first; either way no read happened.
      expect(result?.resources ?? {}).toEqual({});
      expect(cluster.layer.requests).toHaveLength(0);
    });
  });

  // The optional dependency is missing: chant reports holes with an actionable
  // reason rather than an empty cluster (which would classify as N creates).
  test("a missing client package is a hole with an install hint, never an absence", async () => {
    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["web"],
        entities: makeEntities([
          { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } },
        ]),
      },
      async () => {
        throw Object.assign(new Error("Cannot find package '@intentius/chant-k8s-client'"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
    );

    expect(result.resources).toEqual({});
    expect(result.unobserved?.web?.reason).toBe("read-failed");
    expect(result.unobserved?.web?.detail).toContain("npm i @intentius/chant-k8s-client");
    expect(result.unobserved?.web?.type).toBe("K8s::Apps::Deployment");
  });
});
