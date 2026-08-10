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

const { describeResources, statusFromObject, unhappyConditions, revisionAttributes } = await import("./describe-resources");
const { fakeCluster, objectKey, ownedObject } = await import("./api/fake-cluster");
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

  // The behold#192 shape (#1620): a Flux-deployed object declares no
  // metadata.namespace (the controller stamps targetNamespace at apply), so the
  // live read scopes to the client's default namespace, finds nothing, and
  // correctly reports absence. Every layer is spec-correct and the picture
  // still says the opposite of the truth — unless the report carries the
  // address it actually asked, which is what `queried` is.
  test("an absent verdict carries the resolved query address, namespace defaulted and visible (#1620)", async () => {
    const cluster = fakeCluster({
      // The object lives where Flux put it — not where the read will look.
      objects: { [objectKey("apps/v1", "Deployment", "web", "flux-target")]: web },
    });
    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["web"],
        entities: makeEntities([
          // No metadata.namespace declared — Flux stamps it at apply time.
          { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web" } } },
        ]),
      },
      cluster.connector,
    );

    // Still a clean absence: in neither map, the tri-state unshifted.
    expect(result.resources).toEqual({});
    expect(result.unobserved ?? {}).toEqual({});
    // But the report can now explain itself: the read went to `default`.
    expect(result.queried?.web).toBe("/apis/apps/v1/namespaces/default/deployments/web");
  });

  test("a present entity carries its query address too — the map is total over issued reads (#1620)", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("apps/v1", "Deployment", "web", "prod")]: web },
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
    expect(result.resources.web).toBeDefined();
    expect(result.queried?.web).toBe("/apis/apps/v1/namespaces/prod/deployments/web");
  });

  test("a read-failed unobserved entry carries the address the failing read was issued against (#1620)", async () => {
    const cluster = fakeCluster({
      respond: (req) =>
        req.path.endsWith("/deployments/web")
          ? { status: 500, body: statusBody(500, "InternalError", "etcdserver: request timed out") }
          : undefined,
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
    expect(result.unobserved?.web).toMatchObject({
      reason: "read-failed",
      queried: "/apis/apps/v1/namespaces/prod/deployments/web",
    });
    expect(result.queried?.web).toBe("/apis/apps/v1/namespaces/prod/deployments/web");
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

    test("bound while a different context is ambient: the binding wins and the estate observes (#1488)", async () => {
      loadChantConfigMock.mockResolvedValue({ config: { k8s: { profiles: { prod: { context: "prod-eks" } } } } });
      // Ambient points at staging — the state any other project's k3d cluster
      // leaves behind. Before #1488 this refused and the whole estate read
      // grey; the declared binding must simply be used instead.
      const ambientIsStaging = fakeKubeconfig({
        contexts: [
          { name: "prod-eks", cluster: "prod", user: "prod-user" },
          { name: "staging-eks", cluster: "staging", user: "staging-user" },
        ],
        currentContext: "staging-eks",
      });
      const cluster = fakeCluster({
        kubeconfig: ambientIsStaging,
        objects: { [objectKey("apps/v1", "Deployment", "web", "prod")]: web },
      });

      const result = await describeResources(
        { environment: "prod", buildOutput: "", entityNames: ["web"], entities: entities() },
        (o) => defaultK8sConnector({ ...o, client: { kubeconfig: ambientIsStaging, requestLayer: cluster.layer } }),
      );

      expect(result.resources.web).toMatchObject({ type: "K8s::Apps::Deployment", physicalId: "uid-1", status: "READY" });
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

    test("a failed read names the bound context it read (#1488)", async () => {
      loadChantConfigMock.mockResolvedValue({ config: { k8s: { profiles: { prod: { context: "prod-eks" } } } } });
      const cluster = fakeCluster({
        kubeconfig: twoContexts,
        respond: (req) =>
          req.path.endsWith("/deployments/web")
            ? { status: 500, body: statusBody(500, "InternalError", "etcdserver: leader changed") }
            : undefined,
      });

      const result = await describeResources(
        { environment: "prod", buildOutput: "", entityNames: ["web"], entities: entities() },
        (o) => defaultK8sConnector({ ...o, client: { kubeconfig: twoContexts, requestLayer: cluster.layer } }),
      );

      expect(result.unobserved?.web?.reason).toBe("read-failed");
      expect(result.unobserved?.web?.detail).toContain('context "prod-eks" (bound by k8s.profiles.prod.context)');
    });

    test("an ambient read failure names the context that was read and the missing binding (#1488)", async () => {
      loadChantConfigMock.mockResolvedValue({ config: {} });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const cluster = fakeCluster({
        kubeconfig: twoContexts,
        respond: (req) =>
          req.path.endsWith("/deployments/web") ? { status: 500, body: statusBody(500, "InternalError", "nope") } : undefined,
      });

      const result = await describeResources(
        { environment: "prod", buildOutput: "", entityNames: ["web"], entities: entities() },
        (o) => defaultK8sConnector({ ...o, client: { kubeconfig: twoContexts, requestLayer: cluster.layer } }),
      );
      warnSpy.mockRestore();

      expect(result.unobserved?.web?.reason).toBe("read-failed");
      expect(result.unobserved?.web?.detail).toContain('context "prod-eks" (ambient; no k8s.profiles.prod binding)');
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

  // ── Runtime children: owner-reference chain classification (chant #1077) ──

  describe("runtime children of the estate's own API groups (#1517)", () => {
    function declaredCronJob() {
      return makeEntities([
        { name: "backup", entityType: "K8s::Batch::CronJob", props: { metadata: { name: "backup", namespace: "prod" } } },
      ]);
    }
    const cronJob = {
      apiVersion: "batch/v1",
      kind: "CronJob",
      metadata: { name: "backup", namespace: "prod", uid: "cj-uid" },
    };

    test("a controller-made child in a declared non-core group surfaces with its own kind and a declared chain", async () => {
      const job = {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: "backup-29157",
          namespace: "prod",
          uid: "job-uid",
          ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: "backup", uid: "cj-uid", controller: true }],
        },
        status: { conditions: [{ type: "Complete", status: "True" }] },
      };
      const cluster = fakeCluster({
        objects: {
          [objectKey("batch/v1", "CronJob", "backup", "prod")]: cronJob,
          [objectKey("batch/v1", "Job", "backup-29157", "prod")]: job,
        },
      });

      const result = await describeResources(
        { environment: "prod", buildOutput: "", entityNames: ["backup"], entities: declaredCronJob() },
        cluster.connector,
      );

      const child = result.resources["Job/prod/backup-29157"];
      expect(child).toMatchObject({
        type: "K8s::Batch::Job",
        physicalId: "job-uid",
        ownerChain: { root: "declared", entity: "backup" },
      });
    });

    test("a loose object in a swept group with no owner chain is NOT reported — the scan is not an inventory", async () => {
      const looseJob = {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name: "hand-made", namespace: "prod", uid: "loose-uid" },
      };
      const cluster = fakeCluster({
        objects: {
          [objectKey("batch/v1", "CronJob", "backup", "prod")]: cronJob,
          [objectKey("batch/v1", "Job", "hand-made", "prod")]: looseJob,
        },
      });

      const result = await describeResources(
        { environment: "prod", buildOutput: "", entityNames: ["backup"], entities: declaredCronJob() },
        cluster.connector,
      );

      expect(result.resources["Job/prod/hand-made"]).toBeUndefined();
    });

    // The issue's own estate: a declared MicroVMReplicaSet whose operator
    // made MicroVMs — a CRD kind no table anticipated. Discovery names it.
    test("a controller-made child of a CRD kind surfaces as a runtime child of the declared CR", async () => {
      const replicaSet = {
        apiVersion: "lambda.aws.amazon.com/v1alpha1",
        kind: "MicroVMReplicaSet",
        metadata: { name: "kmv-dev-a-vm", namespace: "microvm-demo", uid: "mvrs-uid" },
      };
      const vm = {
        apiVersion: "lambda.aws.amazon.com/v1alpha1",
        kind: "MicroVM",
        metadata: {
          name: "kmv-dev-a-vm-42sgf",
          namespace: "microvm-demo",
          uid: "vm-uid",
          ownerReferences: [
            { apiVersion: "lambda.aws.amazon.com/v1alpha1", kind: "MicroVMReplicaSet", name: "kmv-dev-a-vm", uid: "mvrs-uid", controller: true },
          ],
        },
        status: { phase: "Running" },
      };
      const cluster = fakeCluster({
        objects: {
          [objectKey("lambda.aws.amazon.com/v1alpha1", "MicroVMReplicaSet", "kmv-dev-a-vm", "microvm-demo")]: replicaSet,
          [objectKey("lambda.aws.amazon.com/v1alpha1", "MicroVM", "kmv-dev-a-vm-42sgf", "microvm-demo")]: vm,
        },
      });

      const result = await describeResources(
        {
          environment: "dev",
          buildOutput: "",
          entityNames: ["workloadReplicaSet"],
          entities: makeEntities([
            {
              name: "workloadReplicaSet",
              entityType: "K8s::KubeMicroVM::MicroVMReplicaSet",
              props: { metadata: { name: "kmv-dev-a-vm", namespace: "microvm-demo" } },
            },
          ]),
        },
        cluster.connector,
      );

      expect(result.resources["MicroVM/microvm-demo/kmv-dev-a-vm-42sgf"]).toMatchObject({
        type: "K8s::KubeMicroVM::MicroVM",
        physicalId: "vm-uid",
        ownerChain: { root: "declared", entity: "workloadReplicaSet" },
      });
    });

    test("a child in a group the estate never declares surfaces too — discovery names the kinds, not the declaration", async () => {
      // A declared CR whose operator makes ordinary Deployments: ray.io is
      // declared, apps/v1 is not, and the estate-groups sweep never listed it.
      const rayCluster = { apiVersion: "ray.io/v1", kind: "RayCluster", metadata: { name: "ml", namespace: "ray", uid: "ray-uid" } };
      const head = {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
          name: "ml-head",
          namespace: "ray",
          uid: "head-uid",
          ownerReferences: [{ apiVersion: "ray.io/v1", kind: "RayCluster", name: "ml", uid: "ray-uid", controller: true }],
        },
        status: { readyReplicas: 1, replicas: 1 },
      };
      const cluster = fakeCluster({
        objects: {
          [objectKey("ray.io/v1", "RayCluster", "ml", "ray")]: rayCluster,
          [objectKey("apps/v1", "Deployment", "ml-head", "ray")]: head,
        },
      });

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

      expect(result.resources["Deployment/ray/ml-head"]).toMatchObject({
        type: "K8s::Apps::Deployment",
        physicalId: "head-uid",
        ownerChain: { root: "declared", entity: "ml" },
      });
    });

    test("a discovered kind the sweep cannot list is an unobserved hole, never silently absent", async () => {
      const cluster = fakeCluster({
        objects: { [objectKey("batch/v1", "CronJob", "backup", "prod")]: cronJob },
        respond: (req) =>
          req.path === "/apis/batch/v1/namespaces/prod/jobs"
            ? { status: 403, body: statusBody(403, "Forbidden", "jobs is forbidden") }
            : undefined,
      });

      const result = await describeResources(
        { environment: "prod", buildOutput: "", entityNames: ["backup"], entities: declaredCronJob() },
        cluster.connector,
      );

      // Declared resolution is never failed by the sweep.
      expect(result.resources.backup).toMatchObject({ type: "K8s::Batch::CronJob", physicalId: "cj-uid" });
      // The failed list is a hole the observation admits, with the failure's
      // own classification — a 403 is a credentials problem, and silence here
      // would have read as "no runtime children in prod".
      expect(result.unobserved?.["runtime-sweep:batch/v1/Job"]).toMatchObject({
        type: "K8s::Batch::Job",
        reason: "no-credentials",
      });
      expect(result.unobserved?.["runtime-sweep:batch/v1/Job"]?.detail).toContain("namespace prod");
    });

    test("a cluster-scoped child chains to a declared cluster-scoped entity — the one case cluster-scoped kinds are swept", async () => {
      const ns = { apiVersion: "v1", kind: "Namespace", metadata: { name: "team-a", uid: "ns-uid" }, status: { phase: "Active" } };
      const role = {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "ClusterRole",
        metadata: {
          name: "team-a-admin",
          uid: "role-uid",
          ownerReferences: [{ apiVersion: "v1", kind: "Namespace", name: "team-a", uid: "ns-uid", controller: true }],
        },
      };
      const cluster = fakeCluster({
        objects: {
          [objectKey("v1", "Namespace", "team-a")]: ns,
          [objectKey("rbac.authorization.k8s.io/v1", "ClusterRole", "team-a-admin")]: role,
        },
      });

      const result = await describeResources(
        {
          environment: "prod",
          buildOutput: "",
          entityNames: ["team"],
          entities: makeEntities([
            { name: "team", entityType: "K8s::Core::Namespace", props: { metadata: { name: "team-a" } } },
          ]),
        },
        cluster.connector,
      );

      expect(result.resources["cluster:ClusterRole/team-a-admin"]).toMatchObject({
        type: "K8s::Rbac::ClusterRole",
        physicalId: "role-uid",
        ownerChain: { root: "declared", entity: "team" },
      });
    });

    test("a Flux-managed Deployment is attributed to its declared Kustomization by the controller's labels (#1549)", async () => {
      // Flux stamps managed objects with name+namespace labels instead of
      // ownerReferences, so the chain walk reaches nothing — the label
      // channel resolves against the DECLARED CR, exactly. The workload also
      // lives in a namespace the estate never declares an entity in: the
      // Kustomization's own spec.targetNamespace is what puts it in scope.
      const kustomization = {
        apiVersion: "kustomize.toolkit.fluxcd.io/v1",
        kind: "Kustomization",
        metadata: { name: "apps", namespace: "flux-system", uid: "ks-uid" },
        status: { conditions: [{ type: "Ready", status: "True" }] },
      };
      const managed = {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
          name: "web",
          namespace: "prod",
          uid: "dep-uid",
          labels: { "kustomize.toolkit.fluxcd.io/name": "apps", "kustomize.toolkit.fluxcd.io/namespace": "flux-system" },
        },
        status: { readyReplicas: 1, replicas: 1 },
      };
      const cluster = fakeCluster({
        objects: {
          [objectKey("kustomize.toolkit.fluxcd.io/v1", "Kustomization", "apps", "flux-system")]: kustomization,
          [objectKey("apps/v1", "Deployment", "web", "prod")]: managed,
        },
      });

      const result = await describeResources(
        {
          environment: "prod",
          buildOutput: "",
          entityNames: ["apps"],
          entities: makeEntities([
            {
              name: "apps",
              entityType: "K8s::Flux::Kustomization",
              props: { metadata: { name: "apps", namespace: "flux-system" }, spec: { targetNamespace: "prod", sourceRef: { kind: "GitRepository", name: "infra" } } },
            },
          ]),
        },
        cluster.connector,
      );

      expect(result.resources["Deployment/prod/web"]).toMatchObject({
        type: "K8s::Apps::Deployment",
        ownerChain: { root: "declared", entity: "apps" },
      });
    });

    test("Argo's bare instance label claims only a UNIQUE declared Application (#1549)", async () => {
      const app = (name: string) => ({
        apiVersion: "argoproj.io/v1alpha1",
        kind: "Application",
        metadata: { name, namespace: "argocd", uid: `${name}-uid` },
        status: { health: { status: "Healthy" }, sync: { status: "Synced" } },
      });
      const managed = {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "web", namespace: "prod", uid: "dep-uid", labels: { "app.kubernetes.io/instance": "web" } },
      };
      const cluster = fakeCluster({
        objects: {
          [objectKey("argoproj.io/v1alpha1", "Application", "web", "argocd")]: app("web"),
          [objectKey("apps/v1", "Deployment", "web", "prod")]: managed,
        },
      });

      const result = await describeResources(
        {
          environment: "prod",
          buildOutput: "",
          entityNames: ["webApp"],
          entities: makeEntities([
            {
              name: "webApp",
              entityType: "K8s::Argo::Application",
              props: { metadata: { name: "web", namespace: "argocd" }, spec: { destination: { namespace: "prod" } } },
            },
          ]),
        },
        cluster.connector,
      );

      expect(result.resources["Deployment/prod/web"]).toMatchObject({
        type: "K8s::Apps::Deployment",
        ownerChain: { root: "declared", entity: "webApp" },
      });
    });

    // #1643 — the common convention names a workload and its Service alike, so
    // a kind-less `namespace/name` key made them one row and only whichever
    // kind swept first survived. Found by behold's argo estate: Application
    // boxes held Endpoints instead of the Deployment.
    test("same-named objects of different kinds are all reported — the key carries the kind (#1643)", async () => {
      const app = {
        apiVersion: "argoproj.io/v1alpha1",
        kind: "Application",
        metadata: { name: "app-a", namespace: "argocd", uid: "app-uid" },
        status: { health: { status: "Healthy" }, sync: { status: "Synced" } },
      };
      const label = { "app.kubernetes.io/instance": "app-a" };
      const deployment = {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "app-a", namespace: "app-a", uid: "dep-uid", labels: label },
      };
      const service = {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: "app-a", namespace: "app-a", uid: "svc-uid", labels: label },
      };
      const cluster = fakeCluster({
        objects: {
          [objectKey("argoproj.io/v1alpha1", "Application", "app-a", "argocd")]: app,
          [objectKey("apps/v1", "Deployment", "app-a", "app-a")]: deployment,
          [objectKey("v1", "Service", "app-a", "app-a")]: service,
        },
      });

      const result = await describeResources(
        {
          environment: "prod",
          buildOutput: "",
          entityNames: ["appA"],
          entities: makeEntities([
            {
              name: "appA",
              entityType: "K8s::Argo::Application",
              props: { metadata: { name: "app-a", namespace: "argocd" }, spec: { destination: { namespace: "app-a" } } },
            },
          ]),
        },
        cluster.connector,
      );

      expect(result.resources["Deployment/app-a/app-a"]).toMatchObject({ type: "K8s::Apps::Deployment", physicalId: "dep-uid" });
      expect(result.resources["Service/app-a/app-a"]).toMatchObject({ type: "K8s::Core::Service", physicalId: "svc-uid" });
    });

    test("a generic instance label matching NO declared Application claims nothing — not an inventory (#1549)", async () => {
      // `app.kubernetes.io/instance` is also what plain helm sets; on an
      // estate declaring a Flux CR (so the widened sweep runs), a foreign
      // helm-installed Deployment must not be attributed.
      const kustomization = {
        apiVersion: "kustomize.toolkit.fluxcd.io/v1",
        kind: "Kustomization",
        metadata: { name: "apps", namespace: "flux-system", uid: "ks-uid" },
      };
      const foreign = {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "cert-manager", namespace: "flux-system", uid: "cm-uid", labels: { "app.kubernetes.io/instance": "cert-manager" } },
      };
      const cluster = fakeCluster({
        objects: {
          [objectKey("kustomize.toolkit.fluxcd.io/v1", "Kustomization", "apps", "flux-system")]: kustomization,
          [objectKey("apps/v1", "Deployment", "cert-manager", "flux-system")]: foreign,
        },
      });

      const result = await describeResources(
        {
          environment: "prod",
          buildOutput: "",
          entityNames: ["apps"],
          entities: makeEntities([
            { name: "apps", entityType: "K8s::Flux::Kustomization", props: { metadata: { name: "apps", namespace: "flux-system" } } },
          ]),
        },
        cluster.connector,
      );

      expect(result.resources["Deployment/flux-system/cert-manager"]).toBeUndefined();
    });

    test("the sweep's bound is the estate's namespaces, not a kind list — and no cluster-scoped list without a cluster-scoped entity", async () => {
      const svc = { apiVersion: "v1", kind: "Service", metadata: { name: "web", namespace: "prod", uid: "svc-uid" } };
      const cluster = fakeCluster({
        objects: { [objectKey("v1", "Service", "web", "prod")]: svc },
      });

      await describeResources(
        {
          environment: "prod",
          buildOutput: "",
          entityNames: ["web"],
          entities: makeEntities([
            { name: "web", entityType: "K8s::Core::Service", props: { metadata: { name: "web", namespace: "prod" } } },
          ]),
        },
        cluster.connector,
      );

      const paths = cluster.layer.paths();
      const isDiscovery = (p: string) =>
        p === "/api" || p === "/apis" || /^\/api\/[^/]+$/.test(p) || /^\/apis\/[^/]+\/[^/]+$/.test(p);
      const reads = paths.filter((p) => !isDiscovery(p));
      // Discovery names the kinds; every actual read or list stays inside the
      // one namespace the estate touches. Nothing is listed cluster-wide.
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((p) => p.includes("/namespaces/prod/"))).toBe(true);
      // Nothing declared is cluster-scoped, so no owner chain could reach a
      // cluster-scoped object — their kinds are not listed at all.
      expect(paths.some((p) => p.endsWith("/clusterroles"))).toBe(false);
      // Events churn by the thousands and can never chain (`involvedObject`,
      // not `ownerReferences`) — discovery serves them, the sweep skips them.
      expect(paths.some((p) => p.endsWith("/events"))).toBe(false);
    });
  });

  describe("runtime children (#1077)", () => {
    function declaredDeployment() {
      return makeEntities([
        { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } },
      ]);
    }

    test("a Pod owned (via an undeclared ReplicaSet) by a declared Deployment reports ownerChain: declared", async () => {
      const replicaSet = {
        apiVersion: "apps/v1",
        kind: "ReplicaSet",
        metadata: {
          name: "web-7d9f8c9c8",
          namespace: "prod",
          uid: "rs-uid",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "uid-1", controller: true }],
        },
      };
      const runtimePod = {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: "web-7d9f8c9c8-abcde",
          namespace: "prod",
          uid: "pod-uid",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "web-7d9f8c9c8", uid: "rs-uid", controller: true }],
        },
        status: { phase: "Running" },
      };
      const cluster = fakeCluster({
        objects: {
          [objectKey("apps/v1", "Deployment", "web", "prod")]: web,
          [objectKey("apps/v1", "ReplicaSet", "web-7d9f8c9c8", "prod")]: replicaSet,
          [objectKey("v1", "Pod", "web-7d9f8c9c8-abcde", "prod")]: runtimePod,
        },
      });

      const result = await describeResources(
        { environment: "prod", buildOutput: "", entityNames: ["web"], entities: declaredDeployment() },
        cluster.connector,
      );

      const child = result.resources["Pod/prod/web-7d9f8c9c8-abcde"];
      expect(child).toMatchObject({
        type: "K8s::Core::Pod",
        physicalId: "pod-uid",
        status: "Running",
        ownerChain: { root: "declared", entity: "web" },
      });
      // Reads the ReplicaSet to walk past it — one extra request beyond the
      // Deployment read and the Pod list.
      expect(cluster.layer.paths()).toContain("/apis/apps/v1/namespaces/prod/replicasets/web-7d9f8c9c8");
    });

    test("a genuinely unowned Pod in the same namespace reports ownerChain: unowned (still an orphan downstream)", async () => {
      const standalonePod = {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: "standalone", namespace: "prod", uid: "standalone-uid" },
        status: { phase: "Running" },
      };
      const cluster = fakeCluster({
        objects: {
          [objectKey("apps/v1", "Deployment", "web", "prod")]: web,
          [objectKey("v1", "Pod", "standalone", "prod")]: standalonePod,
        },
      });

      const result = await describeResources(
        { environment: "prod", buildOutput: "", entityNames: ["web"], entities: declaredDeployment() },
        cluster.connector,
      );

      expect(result.resources["Pod/prod/standalone"]).toMatchObject({
        type: "K8s::Core::Pod",
        ownerChain: { root: "unowned" },
      });
    });

    test("a Pod owned by something never declared reports ownerChain: foreign", async () => {
      const otherRs = {
        apiVersion: "apps/v1",
        kind: "ReplicaSet",
        metadata: { name: "other-rs", namespace: "prod", uid: "other-rs-uid" }, // no further owner
      };
      const otherPod = {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: "other-pod",
          namespace: "prod",
          uid: "other-pod-uid",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "other-rs", uid: "other-rs-uid", controller: true }],
        },
      };
      const cluster = fakeCluster({
        objects: {
          [objectKey("apps/v1", "Deployment", "web", "prod")]: web,
          [objectKey("apps/v1", "ReplicaSet", "other-rs", "prod")]: otherRs,
          [objectKey("v1", "Pod", "other-pod", "prod")]: otherPod,
        },
      });

      const result = await describeResources(
        { environment: "prod", buildOutput: "", entityNames: ["web"], entities: declaredDeployment() },
        cluster.connector,
      );

      expect(result.resources["Pod/prod/other-pod"]).toMatchObject({ ownerChain: { root: "foreign" } });
    });

    test("--owned withholds an unrelated Pod, but keeps a runtime child of a declared (owned) entity", async () => {
      // The declared Deployment must itself carry chant's marker for `--owned`
      // to surface it at all — otherwise it is filtered before a Pod scan ever
      // has a declared uid to compare against.
      const ownedWeb = ownedObject("apps/v1", "Deployment", "web", "prod", { status: { readyReplicas: 3, replicas: 3 } });
      const standalonePod = {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: "standalone", namespace: "prod", uid: "standalone-uid" },
      };
      const runtimePod = {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: "web-abc",
          namespace: "prod",
          uid: "pod-uid",
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "uid-web", controller: true }],
        },
      };
      const cluster = fakeCluster({
        objects: {
          [objectKey("apps/v1", "Deployment", "web", "prod")]: ownedWeb,
          [objectKey("v1", "Pod", "standalone", "prod")]: standalonePod,
          [objectKey("v1", "Pod", "web-abc", "prod")]: runtimePod,
        },
      });

      const result = await describeResources(
        {
          environment: "prod",
          buildOutput: "",
          entityNames: ["web"],
          entities: declaredDeployment(),
          owned: true,
        },
        cluster.connector,
      );

      expect(result.resources.web).toBeDefined(); // the marker let it through
      expect(result.resources["Pod/prod/standalone"]).toBeUndefined();
      expect(result.resources["Pod/prod/web-abc"]).toMatchObject({ ownerChain: { root: "declared", entity: "web" } });
    });

    test("a Pod that is itself declared is never duplicated as a runtime child", async () => {
      const declaredPod = {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: "standalone-pod", namespace: "prod", uid: "uid-declared-pod" },
        status: { phase: "Running" },
      };
      const cluster = fakeCluster({
        objects: {
          [objectKey("apps/v1", "Deployment", "web", "prod")]: web,
          [objectKey("v1", "Pod", "standalone-pod", "prod")]: declaredPod,
        },
      });

      const result = await describeResources(
        {
          environment: "prod",
          buildOutput: "",
          entityNames: ["web", "standalonePod"],
          entities: makeEntities([
            { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } },
            { name: "standalonePod", entityType: "K8s::Core::Pod", props: { metadata: { name: "standalone-pod", namespace: "prod" } } },
          ]),
        },
        cluster.connector,
      );

      expect(result.resources.standalonePod).toBeDefined();
      expect(result.resources["Pod/prod/standalone-pod"]).toBeUndefined();
      expect(Object.keys(result.resources)).toHaveLength(2); // web + standalonePod, no synthetic duplicate
    });

    test("a Pod-list failure never fails declared resolution — and surfaces as an unobserved hole (#1517)", async () => {
      const cluster = fakeCluster({
        objects: { [objectKey("apps/v1", "Deployment", "web", "prod")]: web },
        respond: (req) => (req.path.endsWith("/pods") ? { status: 403, body: statusBody(403, "Forbidden", "no pods list") } : undefined),
      });

      const result = await describeResources(
        { environment: "prod", buildOutput: "", entityNames: ["web"], entities: declaredDeployment() },
        cluster.connector,
      );

      expect(result.resources.web).toMatchObject({ type: "K8s::Apps::Deployment", physicalId: "uid-1" });
      expect(Object.keys(result.resources)).toEqual(["web"]);
      // Silence would read as "no runtime Pods in prod", which the failed
      // list never proved — the sweep admits the hole instead.
      expect(result.unobserved?.["runtime-sweep:v1/Pod"]).toMatchObject({
        type: "K8s::Core::Pod",
        reason: "no-credentials",
      });
    });

    test("a lexicon-supported entity type with no namespaced entities resolved does no Pod scan at all", async () => {
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

      expect(Object.keys(result.resources)).toEqual(["ns"]);
      expect(cluster.layer.paths().some((p) => p.endsWith("/pods"))).toBe(false);
    });
  });
});

// #1397 — a Pod's phase is `Running` from the moment the kubelet admits it, so
// the phase alone reported a crashlooping Pod as `Running`, which every
// consumer classifying that word read as healthy.
describe("statusFromObject — the most specific failing signal (#1397)", () => {
  test("a crashlooping Pod reports the reason, not the phase", () => {
    expect(
      statusFromObject({
        status: {
          phase: "Running",
          containerStatuses: [{ state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s" } } }],
        },
      } as never),
    ).toBe("CrashLoopBackOff");
  });

  test("an image-pull failure reports the reason", () => {
    expect(
      statusFromObject({
        status: { phase: "Pending", containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } }] },
      } as never),
    ).toBe("ImagePullBackOff");
  });

  test("an unschedulable Pod reports Unschedulable, not Pending", () => {
    expect(
      statusFromObject({
        status: {
          phase: "Pending",
          conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }],
        },
      } as never),
    ).toBe("Unschedulable");
  });

  test("ordinary startup is not promoted over the phase", () => {
    // ContainerCreating and PodInitializing are not failure; surfacing them
    // would be noise, and the phase already classifies as progressing.
    for (const reason of ["ContainerCreating", "PodInitializing"]) {
      expect(
        statusFromObject({
          status: { phase: "Pending", containerStatuses: [{ state: { waiting: { reason } } }] },
        } as never),
      ).toBe("Pending");
    }
  });

  test("a terminated container does not outrank the phase — a Job container exits cleanly", () => {
    expect(
      statusFromObject({
        status: { phase: "Succeeded", containerStatuses: [{ state: { terminated: { reason: "Completed", exitCode: 0 } } }] },
      } as never),
    ).toBe("Succeeded");
  });

  test("a healthy Pod and a ready Deployment are unchanged", () => {
    expect(statusFromObject({ status: { phase: "Running", containerStatuses: [{ state: { running: {} } }] } } as never)).toBe("Running");
    expect(statusFromObject({ status: { readyReplicas: 3, replicas: 3 } } as never)).toBe("READY");
    expect(statusFromObject({ status: { readyReplicas: 1, replicas: 3 } } as never)).toBe("PROGRESSING(1/3)");
    expect(statusFromObject({} as never)).toBe("PRESENT");
  });

  test("a conditions-first CR reads its Ready condition, not PRESENT (#1549)", () => {
    // A wedged Flux Kustomization/HelmRelease has no phase and no replica
    // counts, so it fell straight to PRESENT — a wedged reconciler read
    // exactly like a healthy one.
    expect(
      statusFromObject({ status: { conditions: [{ type: "Ready", status: "False", reason: "BuildFailed" }] } } as never),
    ).toBe("BuildFailed");
    expect(
      statusFromObject({ status: { conditions: [{ type: "Ready", status: "False" }] } } as never),
    ).toBe("NOT-READY");
    expect(
      statusFromObject({ status: { conditions: [{ type: "Ready", status: "True", reason: "ReconciliationSucceeded" }] } } as never),
    ).toBe("READY");
  });

  test("the Ready rung never changes a Pod or workload word — phase and replicas rank above it (#1549)", () => {
    expect(
      statusFromObject({ status: { phase: "Running", conditions: [{ type: "Ready", status: "False" }] } } as never),
    ).toBe("Running");
    expect(
      statusFromObject({ status: { readyReplicas: 1, replicas: 3, conditions: [{ type: "Ready", status: "False" }] } } as never),
    ).toBe("PROGRESSING(1/3)");
  });

  test("an Argo Application reads health/sync (#1549)", () => {
    expect(statusFromObject({ status: { health: { status: "Degraded" }, sync: { status: "Synced" } } } as never)).toBe("Degraded");
    expect(statusFromObject({ status: { health: { status: "Healthy" }, sync: { status: "OutOfSync" } } } as never)).toBe("OutOfSync");
    expect(statusFromObject({ status: { health: { status: "Healthy" }, sync: { status: "Synced" } } } as never)).toBe("READY");
  });
});

// #1401 — #1397 made the status WORD honest; this carries the part that says
// what to do about it. `Unschedulable` is the reason; "0/3 nodes are available"
// is the answer.
describe("unhappyConditions (#1401)", () => {
  test("reports an unschedulable Pod's message, not just its reason", () => {
    expect(
      unhappyConditions({
        status: {
          conditions: [
            {
              type: "PodScheduled",
              status: "False",
              reason: "Unschedulable",
              message: "0/3 nodes are available: 1 node(s) had untolerated taint.",
            },
          ],
        },
      } as never),
    ).toEqual(["PodScheduled=Unschedulable: 0/3 nodes are available: 1 node(s) had untolerated taint."]);
  });

  test("is absent when every condition is happy — presence means the object has something to say", () => {
    expect(
      unhappyConditions({
        status: { conditions: [{ type: "Ready", status: "True" }, { type: "PodScheduled", status: "True" }] },
      } as never),
    ).toBeUndefined();
  });

  test("knows the happy polarity is per condition type", () => {
    // Ready/Available/PodScheduled are good when True; the *Pressure and
    // NetworkUnavailable node conditions are good when False. Treating them all
    // the same would report every healthy node as unhappy, or hide a node
    // genuinely under disk pressure.
    const healthyNode = {
      status: {
        conditions: [
          { type: "Ready", status: "True" },
          { type: "MemoryPressure", status: "False" },
          { type: "DiskPressure", status: "False" },
        ],
      },
    };
    expect(unhappyConditions(healthyNode as never)).toBeUndefined();

    const pressured = {
      status: {
        conditions: [
          { type: "Ready", status: "True" },
          { type: "DiskPressure", status: "True", reason: "KubeletHasDiskPressure" },
        ],
      },
    };
    expect(unhappyConditions(pressured as never)).toEqual(["DiskPressure=KubeletHasDiskPressure"]);
  });

  test("reports every unhappy condition, since a stuck Deployment has two", () => {
    expect(
      unhappyConditions({
        status: {
          conditions: [
            { type: "Available", status: "False", reason: "MinimumReplicasUnavailable" },
            { type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded", message: "ReplicaSet has timed out." },
          ],
        },
      } as never),
    ).toHaveLength(2);
  });

  test("is absent for an object with no conditions at all", () => {
    expect(unhappyConditions({ status: {} } as never)).toBeUndefined();
    expect(unhappyConditions({} as never)).toBeUndefined();
  });
});

describe("revisionAttributes — the GitOps convergence fields (#1632)", () => {
  test("carries a Kustomization's applied and attempted revisions", () => {
    expect(
      revisionAttributes({
        status: {
          lastAppliedRevision: "main@sha1:1a2b3c4d",
          lastAttemptedRevision: "main@sha1:5e6f7a8b",
          conditions: [{ type: "Ready", status: "True" }],
        },
      } as never),
    ).toMatchObject({ lastAppliedRevision: "main@sha1:1a2b3c4d", lastAttemptedRevision: "main@sha1:5e6f7a8b" });
  });

  test("flattens a source kind's status.artifact.revision", () => {
    expect(revisionAttributes({ status: { artifact: { revision: "main@sha1:1a2b3c4d" } } } as never)).toMatchObject({
      artifactRevision: "main@sha1:1a2b3c4d",
    });
  });

  test("says nothing for an object that carries none of them", () => {
    // Every field undefined, so `pruneUndefined` drops all three and the
    // attributes of a Deployment or a Service are byte-for-byte what they were.
    expect(revisionAttributes({ status: { readyReplicas: 1, replicas: 1 } } as never)).toEqual({
      lastAppliedRevision: undefined,
      lastAttemptedRevision: undefined,
      artifactRevision: undefined,
    });
    expect(revisionAttributes({} as never)).toEqual({
      lastAppliedRevision: undefined,
      lastAttemptedRevision: undefined,
      artifactRevision: undefined,
    });
  });

  test("ignores non-string and empty revisions", () => {
    expect(
      revisionAttributes({ status: { lastAppliedRevision: "", lastAttemptedRevision: 7, artifact: { revision: null } } } as never),
    ).toEqual({ lastAppliedRevision: undefined, lastAttemptedRevision: undefined, artifactRevision: undefined });
  });
});

describe("observed attributes carry the Flux revisions (#1632)", () => {
  const applied = "main@sha1:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
  const attempted = "main@sha1:5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d";

  test("a Kustomization mid-rollout reports applied != attempted even with Ready=True", async () => {
    const kustomization = {
      apiVersion: "kustomize.toolkit.fluxcd.io/v1",
      kind: "Kustomization",
      metadata: { name: "apps", namespace: "flux-system", uid: "ks-uid", resourceVersion: "42" },
      status: {
        lastAppliedRevision: applied,
        lastAttemptedRevision: attempted,
        conditions: [{ type: "Ready", status: "True", reason: "ReconciliationSucceeded" }],
      },
    };
    const source = {
      apiVersion: "source.toolkit.fluxcd.io/v1",
      kind: "GitRepository",
      metadata: { name: "infra", namespace: "flux-system", uid: "gr-uid" },
      status: {
        artifact: { revision: attempted, path: "gitrepository/flux-system/infra/x.tar.gz" },
        conditions: [{ type: "Ready", status: "True" }],
      },
    };
    const cluster = fakeCluster({
      objects: {
        [objectKey("kustomize.toolkit.fluxcd.io/v1", "Kustomization", "apps", "flux-system")]: kustomization,
        [objectKey("source.toolkit.fluxcd.io/v1", "GitRepository", "infra", "flux-system")]: source,
      },
    });

    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["apps", "infra"],
        entities: makeEntities([
          {
            name: "apps",
            entityType: "K8s::Flux::Kustomization",
            props: { metadata: { name: "apps", namespace: "flux-system" } },
          },
          {
            name: "infra",
            entityType: "K8s::Flux::GitRepository",
            props: { metadata: { name: "infra", namespace: "flux-system" } },
          },
        ]),
      },
      cluster.connector,
    );

    // The per-node half: attempted is ahead of applied, so this object is
    // mid-flight however cheerful its Ready condition is.
    expect(result.resources.apps?.attributes).toMatchObject({
      lastAppliedRevision: applied,
      lastAttemptedRevision: attempted,
    });
    // The cross-node half: the source's artifact revision, which a consumer
    // joins against the Kustomization's applied revision.
    expect(result.resources.infra?.attributes).toMatchObject({ artifactRevision: attempted });
    expect(result.resources.apps?.status).toBe("READY");
  });

  test("a HelmRelease's revisions ride the same path, and other kinds are untouched", async () => {
    const helmRelease = {
      apiVersion: "helm.toolkit.fluxcd.io/v2",
      kind: "HelmRelease",
      metadata: { name: "podinfo", namespace: "prod", uid: "hr-uid" },
      status: { lastAppliedRevision: "6.5.4", lastAttemptedRevision: "6.5.4", conditions: [{ type: "Ready", status: "True" }] },
    };
    const cluster = fakeCluster({
      objects: {
        [objectKey("helm.toolkit.fluxcd.io/v2", "HelmRelease", "podinfo", "prod")]: helmRelease,
        [objectKey("apps/v1", "Deployment", "web", "prod")]: web,
      },
    });

    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["podinfo", "web"],
        entities: makeEntities([
          {
            name: "podinfo",
            entityType: "K8s::Flux::HelmRelease",
            props: { metadata: { name: "podinfo", namespace: "prod" } },
          },
          { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } },
        ]),
      },
      cluster.connector,
    );

    expect(result.resources.podinfo?.attributes).toMatchObject({
      lastAppliedRevision: "6.5.4",
      lastAttemptedRevision: "6.5.4",
    });
    // The string wire form for every other kind is what it was — no empty
    // revision keys appear on a Deployment (#1401's shape, unchanged).
    expect(result.resources.web?.attributes).toEqual({
      namespace: "prod",
      labels: { app: "web" },
      resourceVersion: "7",
    });
  });
});

// The behold#221 shape (#1629): the estate's control-plane project declares
// the Kustomization carrying `spec.targetNamespace`, and the app project
// declares bare objects the controller stamps at apply time. Reading the app
// project alone, `metadata.namespace` is absent everywhere and the read
// defaults to `default` — a running estate reported entirely absent. The
// caller that knows the binding can now say where to look.
describe("a per-read namespace override for entities that declare none (#1629)", () => {
  const inAppB = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", namespace: "app-b", uid: "uid-b", resourceVersion: "11" },
    status: { readyReplicas: 1, replicas: 1 },
  };

  test("replaces the `default` fallback for a namespaced entity that declares no namespace", async () => {
    const cluster = fakeCluster({ objects: { [objectKey("apps/v1", "Deployment", "web", "app-b")]: inAppB } });
    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["web"],
        entities: makeEntities([
          { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web" } } },
        ]),
        namespace: "app-b",
      },
      cluster.connector,
    );

    expect(result.resources.web).toMatchObject({ type: "K8s::Apps::Deployment", physicalId: "uid-b" });
    // The `queried` diagnosis line (#1620) reflects the overridden address —
    // whatever the read did, the report says where it looked.
    expect(result.queried?.web).toBe("/apis/apps/v1/namespaces/app-b/deployments/web");
  });

  test("an explicitly declared namespace still wins — the override is a default, not a rewrite", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod")]: web,
        [objectKey("apps/v1", "Deployment", "web", "app-b")]: inAppB,
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
        namespace: "app-b",
      },
      cluster.connector,
    );

    // Both objects exist; the declared namespace decides which one was read.
    expect(result.resources.web).toMatchObject({ physicalId: "uid-1" });
    expect(result.queried?.web).toBe("/apis/apps/v1/namespaces/prod/deployments/web");
  });

  test("without the override the read still defaults to `default` — nothing changed for a caller that passes none", async () => {
    const cluster = fakeCluster({ objects: { [objectKey("apps/v1", "Deployment", "web", "app-b")]: inAppB } });
    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["web"],
        entities: makeEntities([
          { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web" } } },
        ]),
      },
      cluster.connector,
    );

    expect(result.resources).toEqual({});
    expect(result.queried?.web).toBe("/apis/apps/v1/namespaces/default/deployments/web");
  });

  test("a cluster-scoped kind is untouched — it has no namespace to default", async () => {
    const ns = { apiVersion: "v1", kind: "Namespace", metadata: { name: "app-b", uid: "ns-uid" } };
    const cluster = fakeCluster({ objects: { [objectKey("v1", "Namespace", "app-b")]: ns } });
    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["appB"],
        entities: makeEntities([
          { name: "appB", entityType: "K8s::Core::Namespace", props: { metadata: { name: "app-b" } } },
        ]),
        namespace: "app-b",
      },
      cluster.connector,
    );

    expect(result.resources.appB).toMatchObject({ physicalId: "ns-uid" });
    expect(result.queried?.appB).toBe("/api/v1/namespaces/app-b");
  });

  test("the override reaches every declared entity, not just the first", async () => {
    const svc = { apiVersion: "v1", kind: "Service", metadata: { name: "web-svc", namespace: "app-b", uid: "svc-b" } };
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "app-b")]: inAppB,
        [objectKey("v1", "Service", "web-svc", "app-b")]: svc,
      },
    });
    const result = await describeResources(
      {
        environment: "prod",
        buildOutput: "",
        entityNames: ["web", "webSvc"],
        entities: makeEntities([
          { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web" } } },
          { name: "webSvc", entityType: "K8s::Core::Service", props: { metadata: { name: "web-svc" } } },
        ]),
        namespace: "app-b",
      },
      cluster.connector,
    );

    expect(Object.keys(result.resources).sort()).toEqual(["web", "webSvc"]);
  });
});
