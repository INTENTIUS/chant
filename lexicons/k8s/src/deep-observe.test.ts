/**
 * Kubernetes deep observation (#1076) — the k8s row of the deep-observe
 * contract (#1014), and its managed-fields-specific pruning.
 *
 * Every case here drives the real reader (`observeResourcesDeepK8s`) against
 * `./api/fake-cluster.ts` — a real `@intentius/chant-k8s-client` with only
 * `@kubernetes/client-node`'s HTTP send replaced, the same harness
 * `describe-resources.test.ts` uses for the thin read. No ambient kubeconfig
 * is read and no cluster is contacted.
 *
 * The end-to-end acceptance test drives `observeResourcesDeepK8s`'s real
 * output through core's real `diffDeepObservation`, with `k8sPlugin`'s real,
 * exported `deepNormalizationHooks` — the same three pieces
 * `lexicons/aws/src/deep-observe.test.ts` exercises through
 * `deepDiffForLexicon(awsPlugin, …)`. This suite calls
 * `observeResourcesDeepK8s(options, cluster.connector)` directly rather than
 * routing through `k8sPlugin.observeResourcesDeep`, for the same reason
 * `describe-resources.test.ts` calls `describeResources(options,
 * cluster.connector)` directly: the connector is how *this lexicon's* tests
 * substitute a fake cluster (chant #1074), and `k8sPlugin.observeResourcesDeep`
 * is a one-line dynamic-import forward with no branching logic of its own —
 * covered by `examples/k8s-client-boundary.test.ts` and the wiring check
 * below, not by re-deriving a fake-cluster path through it here.
 */

import { describe, test, expect } from "vitest";

const { k8sPlugin } = await import("./plugin");
const {
  observeResourcesDeepK8s,
  buildOwnershipSets,
} = await import("./deep-observe");
const { k8sDeepNormalizationHooks } = await import("./deep-observe-hooks");
const { fakeCluster, objectKey } = await import("./api/fake-cluster");
const { statusBody } = await import("@intentius/chant-k8s-client/testing");
const { isChantFieldManager } = await import("@intentius/chant-k8s-client");
const { diffDeepObservation, observeDeep } = await import("@intentius/chant/lifecycle/deep-observe");
const { normalizeDeepObservation, normalizeDeepProperties } = await import("@intentius/chant/deep-observation");

type Entity = { name: string; entityType: string; props: Record<string, unknown> };
function makeEntities(records: Entity[]): Map<string, { entityType: string; props: Record<string, unknown> }> {
  return new Map(records.map((r) => [r.name, { entityType: r.entityType, props: r.props }]));
}

describe("k8sPlugin wiring (#1076)", () => {
  test("the plugin exposes the deep-observe contract, and the hooks are the shared static instance", () => {
    expect(typeof k8sPlugin.observeResourcesDeep).toBe("function");
    expect(k8sPlugin.deepNormalizationHooks).toBe(k8sDeepNormalizationHooks);
  });
});

describe("k8sDeepNormalizationHooks — the static rules", () => {
  test("prunes server-populated metadata and status unconditionally", () => {
    const out = normalizeDeepProperties(
      {
        status: { readyReplicas: 3 },
        metadata: {
          name: "web",
          uid: "u-1",
          resourceVersion: "7",
          generation: 3,
          creationTimestamp: "2026-01-01T00:00:00Z",
          managedFields: [{ manager: "chant" }],
          labels: { app: "web" },
        },
      },
      { entityType: "K8s::Apps::Deployment", side: "live", hooks: k8sDeepNormalizationHooks },
    );
    expect(out).toEqual({ metadata: { name: "web", labels: { app: "web" } } });
  });

  test("subtracts a Kubernetes default only where source is silent about the property", () => {
    const strategyDefault = { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } };

    const declaredSilent = normalizeDeepProperties(
      { spec: { strategy: strategyDefault, replicas: 3 } },
      {
        entityType: "K8s::Apps::Deployment",
        side: "live",
        hooks: k8sDeepNormalizationHooks,
        counterpartPaths: new Set(["spec", "spec.replicas"]),
      },
    );
    // The whole wrapper drops — no dangling `strategy: {}` left behind.
    expect(declaredSilent).toEqual({ spec: { replicas: 3 } });

    const declaredExplicit = normalizeDeepProperties(
      { spec: { strategy: strategyDefault, replicas: 3 } },
      {
        entityType: "K8s::Apps::Deployment",
        side: "live",
        hooks: k8sDeepNormalizationHooks,
        counterpartPaths: new Set(["spec", "spec.strategy", "spec.replicas"]),
      },
    );
    expect(declaredExplicit).toEqual({ spec: { strategy: strategyDefault, replicas: 3 } });
  });

  test("a one-sided pass never subtracts defaults — the reader has no declared tree yet", () => {
    const out = normalizeDeepProperties(
      { spec: { strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } } } },
      { entityType: "K8s::Apps::Deployment", side: "live", hooks: k8sDeepNormalizationHooks },
    );
    expect(out).toEqual({ spec: { strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } } } });
  });

  test("orders containers, env and volumes by name", () => {
    const out = normalizeDeepProperties(
      {
        containers: [{ name: "sidecar" }, { name: "app" }],
        env: [{ name: "Z" }, { name: "A" }],
        volumes: [{ name: "cache" }, { name: "config" }],
      },
      { entityType: "K8s::Apps::Deployment", side: "live", hooks: k8sDeepNormalizationHooks },
    );
    expect((out.containers as Array<{ name: string }>).map((c) => c.name)).toEqual(["app", "sidecar"]);
    expect((out.env as Array<{ name: string }>).map((e) => e.name)).toEqual(["A", "Z"]);
    expect((out.volumes as Array<{ name: string }>).map((v) => v.name)).toEqual(["cache", "config"]);
  });

  test("orders container ports by containerPort+protocol and service ports by port+protocol", () => {
    const containerPorts = normalizeDeepProperties(
      { ports: [{ containerPort: 9090, protocol: "TCP" }, { containerPort: 8080, protocol: "TCP" }] },
      { entityType: "K8s::Apps::Deployment", side: "live", hooks: k8sDeepNormalizationHooks },
    );
    expect((containerPorts.ports as Array<{ containerPort: number }>).map((p) => p.containerPort)).toEqual([8080, 9090]);

    const servicePorts = normalizeDeepProperties(
      { ports: [{ port: 443, protocol: "TCP" }, { port: 80, protocol: "TCP" }] },
      { entityType: "K8s::Core::Service", side: "live", hooks: k8sDeepNormalizationHooks },
    );
    expect((servicePorts.ports as Array<{ port: number }>).map((p) => p.port)).toEqual([80, 443]);
  });
});

describe("buildOwnershipSets — resolving managedFields against live and declared trees (#1076)", () => {
  test("a scalar owned by chant is chant-owned regardless of the declared tree", () => {
    const live = { spec: { replicas: 3 } };
    const declared = {};
    const sets = buildOwnershipSets(
      [{ manager: "chant:web", operation: "Apply", fieldsV1: { "f:spec": { "f:replicas": {} } } }],
      live,
      declared,
      isChantFieldManager,
    );
    expect(sets.chantOwned.has("spec.replicas")).toBe(true);
    expect(sets.foreignOwned.has("spec.replicas")).toBe(false);
  });

  test("a scalar owned by a foreign manager and undeclared is foreign-owned, not contested", () => {
    const live = { spec: { replicas: 7 } };
    const declared = { spec: {} };
    const sets = buildOwnershipSets(
      [{ manager: "kube-controller-manager", operation: "Update", fieldsV1: { "f:spec": { "f:replicas": {} } } }],
      live,
      declared,
      isChantFieldManager,
    );
    expect(sets.foreignOwned.has("spec.replicas")).toBe(true);
    expect(sets.foreignContested.has("spec.replicas")).toBe(false);
  });

  test("a scalar owned by a foreign manager AND declared is contested", () => {
    const live = { spec: { replicas: 9 } };
    const declared = { spec: { replicas: 5 } };
    const sets = buildOwnershipSets(
      [{ manager: "kubectl-client-side-apply", operation: "Update", fieldsV1: { "f:spec": { "f:replicas": {} } } }],
      live,
      declared,
      isChantFieldManager,
    );
    expect(sets.foreignOwned.has("spec.replicas")).toBe(true);
    expect(sets.foreignContested.has("spec.replicas")).toBe(true);
  });

  test("a keyed list item resolves to its live index, independent of position in the declared array", () => {
    const live = { spec: { containers: [{ name: "istio-proxy" }, { name: "app" }] } };
    const declared = { spec: { containers: [{ name: "app" }] } };
    const sets = buildOwnershipSets(
      [
        {
          manager: "istio-sidecar-injector",
          operation: "Update",
          fieldsV1: { "f:spec": { "f:containers": { 'k:{"name":"istio-proxy"}': { ".": {}, "f:name": {} } } } },
        },
      ],
      live,
      declared,
      isChantFieldManager,
    );
    // Live index 0, not declared index 0 — "istio-proxy" does not exist in
    // declared source at all, so it is undeclared, never contested.
    expect(sets.foreignOwned.has("spec.containers[0]")).toBe(true);
    expect(sets.foreignContested.has("spec.containers[0]")).toBe(false);
  });

  test("a keyed list item that IS declared, at a different live index, is contested at its live index", () => {
    const live = { spec: { containers: [{ name: "sidecar" }, { name: "app", image: "app:2.0" }] } };
    const declared = { spec: { containers: [{ name: "app", image: "app:1.0" }] } };
    const sets = buildOwnershipSets(
      [
        {
          manager: "kubectl-edit",
          operation: "Update",
          fieldsV1: { "f:spec": { "f:containers": { 'k:{"name":"app"}': { "f:image": {} } } } },
        },
      ],
      live,
      declared,
      isChantFieldManager,
    );
    // "app" is live index 1 here (a sidecar was injected in front of it), and
    // it is declared — contested at the index it actually resolved to.
    expect(sets.foreignOwned.has("spec.containers[1].image")).toBe(true);
    expect(sets.foreignContested.has("spec.containers[1].image")).toBe(true);
  });

  test("a subresource entry (status) is excluded — a controller writing status is not contesting the spec", () => {
    const live = { status: { readyReplicas: 3 } };
    const sets = buildOwnershipSets(
      [{ manager: "kube-controller-manager", operation: "Update", subresource: "status", fieldsV1: { "f:status": { "f:readyReplicas": {} } } }],
      live,
      {},
      isChantFieldManager,
    );
    expect(sets.foreignOwned.size).toBe(0);
  });

  test("an entry with no manager name is skipped", () => {
    const sets = buildOwnershipSets(
      [{ operation: "Update", fieldsV1: { "f:spec": {} } }],
      { spec: {} },
      {},
      isChantFieldManager,
    );
    expect(sets.chantOwned.size).toBe(0);
    expect(sets.foreignOwned.size).toBe(0);
  });
});

describe("observeResourcesDeepK8s — reading through the typed client (#1076)", () => {
  test("a hand-edited field chant owns surfaces with the field path; a type with no operation surface is unsupported-kind", async () => {
    const web = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: "web",
        namespace: "prod",
        uid: "uid-web",
        resourceVersion: "9",
        labels: { app: "web", tier: "frontend" },
        managedFields: [
          {
            manager: "chant:web",
            operation: "Apply",
            fieldsV1: { "f:metadata": { "f:labels": { "f:app": {}, "f:tier": {} } } },
          },
        ],
      },
      status: {},
    };
    const cluster = fakeCluster({ objects: { [objectKey("apps/v1", "Deployment", "web", "prod")]: web } });

    const result = normalizeDeepObservation(
      await observeResourcesDeepK8s(
        {
          environment: "prod",
          entityNames: ["web", "unknownKind"],
          entities: makeEntities([
            {
              name: "web",
              entityType: "K8s::Apps::Deployment",
              props: { metadata: { name: "web", namespace: "prod", labels: { app: "web", tier: "backend" } } },
            },
            { name: "unknownKind", entityType: "K8s::Totally::Unknown", props: { metadata: { name: "x" } } },
          ]),
        },
        cluster.connector,
      ),
    );

    expect(result.resources.web.properties).toMatchObject({ metadata: { labels: { app: "web", tier: "frontend" } } });
    expect(result.resources.web.properties).not.toHaveProperty("status");
    expect(result.unobserved.unknownKind.reason).toBe("unsupported-kind");
  });

  test("a read failure is a hole with a reason, never silence", async () => {
    const cluster = fakeCluster({
      respond: (req) => (req.path.endsWith("/deployments/broken") ? { status: 403, body: statusBody(403, "Forbidden", "nope") } : undefined),
    });
    const result = normalizeDeepObservation(
      await observeResourcesDeepK8s(
        {
          environment: "prod",
          entityNames: ["broken"],
          entities: makeEntities([
            { name: "broken", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "broken", namespace: "prod" } } },
          ]),
        },
        cluster.connector,
      ),
    );
    expect(result.resources).toEqual({});
    expect(result.unobserved.broken.reason).toBe("no-credentials");
  });

  test("--owned withholds an unmarked object as filtered, not absent", async () => {
    const theirs = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "theirs", namespace: "prod", uid: "uid-theirs" },
    };
    const cluster = fakeCluster({ objects: { [objectKey("v1", "Service", "theirs", "prod")]: theirs } });
    const result = normalizeDeepObservation(
      await observeResourcesDeepK8s(
        {
          environment: "prod",
          entityNames: ["theirs"],
          owned: true,
          entities: makeEntities([
            { name: "theirs", entityType: "K8s::Core::Service", props: { metadata: { name: "theirs", namespace: "prod" } } },
          ]),
        },
        cluster.connector,
      ),
    );
    expect(result.resources).toEqual({});
    expect(result.unobserved.theirs.reason).toBe("filtered");
  });
});

/**
 * The acceptance test for #1076: declared source, a live tree with
 * controller-managed noise (HPA-owned replicas, an Istio-injected sidecar),
 * a hand-edited field chant owns, a contested field chant declares that a
 * foreign manager currently holds, and an accepted baseline — driven through
 * the real reader and core's real `diffDeepObservation`, with `k8sPlugin`'s
 * real static hooks.
 */
describe("end to end: managed-fields-derived drift (#1076)", () => {
  const declared = makeEntities([
    // "web": HPA owns replicas (undeclared → pruned), Istio injects a sidecar
    // (undeclared → pruned), and someone changed a label chant owns.
    {
      name: "web",
      entityType: "K8s::Apps::Deployment",
      props: {
        metadata: {
          name: "web",
          namespace: "prod",
          labels: { app: "web", tier: "backend" },
          annotations: { "build-id": "42" },
        },
        spec: {
          selector: { matchLabels: { app: "web" } },
          template: {
            metadata: { labels: { app: "web" } },
            spec: { containers: [{ name: "app", image: "web:1.0" }] },
          },
        },
      },
    },
    // "worker": chant declares replicas: 5, but a foreign manager currently
    // holds spec.replicas (transferred by a direct kubectl scale) at 9 — a
    // contested field, and drift-relevant precisely because chant declared it.
    {
      name: "worker",
      entityType: "K8s::Apps::Deployment",
      props: {
        metadata: { name: "worker", namespace: "prod", labels: { app: "worker" } },
        spec: {
          replicas: 5,
          selector: { matchLabels: { app: "worker" } },
          template: { metadata: { labels: { app: "worker" } }, spec: { containers: [{ name: "app", image: "worker:1.0" }] } },
        },
      },
    },
    // No operation surface at all for this made-up type.
    { name: "cache", entityType: "K8s::Totally::Unknown", props: { metadata: { name: "cache" } } },
    // The read itself fails.
    { name: "broken", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "broken", namespace: "prod" } } },
  ]);

  const webLive = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "web",
      namespace: "prod",
      uid: "uid-web",
      resourceVersion: "42",
      generation: 7,
      creationTimestamp: "2026-01-01T00:00:00Z",
      // GENUINE DRIFT: chant owns this label, and the live value moved.
      labels: { app: "web", tier: "frontend" },
      // ACCEPTED: chant owns this annotation; the platform's baseline accepts "43".
      annotations: { "build-id": "43" },
      managedFields: [
        {
          manager: "chant:web",
          operation: "Apply",
          apiVersion: "apps/v1",
          time: "2026-01-01T00:00:00Z",
          fieldsV1: {
            "f:metadata": {
              "f:labels": { "f:app": {}, "f:tier": {} },
              "f:annotations": { "f:build-id": {} },
            },
            "f:spec": {
              "f:selector": {},
              "f:template": {
                "f:spec": { "f:containers": { 'k:{"name":"app"}': { ".": {}, "f:name": {}, "f:image": {} } } },
              },
            },
          },
        },
        {
          // NOISE: HPA owns replicas, and chant never declared it.
          manager: "kube-controller-manager",
          operation: "Update",
          apiVersion: "apps/v1",
          time: "2026-01-02T00:00:00Z",
          fieldsV1: { "f:spec": { "f:replicas": {} } },
        },
        {
          // NOISE: a mutating webhook injected a whole sidecar container.
          manager: "istio-sidecar-injector",
          operation: "Update",
          apiVersion: "apps/v1",
          time: "2026-01-01T00:05:00Z",
          fieldsV1: {
            "f:spec": {
              "f:template": {
                "f:spec": { "f:containers": { 'k:{"name":"istio-proxy"}': { ".": {}, "f:name": {}, "f:image": {} } } },
              },
            },
          },
        },
        {
          // NOISE: status is a subresource write, excluded by default.
          manager: "kube-controller-manager",
          operation: "Update",
          subresource: "status",
          fieldsV1: { "f:status": { "f:readyReplicas": {} } },
        },
      ],
    },
    spec: {
      replicas: 7,
      selector: { matchLabels: { app: "web" } },
      template: {
        metadata: { labels: { app: "web" } },
        spec: {
          containers: [
            { name: "app", image: "web:1.0" },
            { name: "istio-proxy", image: "istio/proxyv2:1.20" },
          ],
        },
      },
    },
    status: { readyReplicas: 7, replicas: 7 },
  };

  const workerLive = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "worker",
      namespace: "prod",
      uid: "uid-worker",
      resourceVersion: "9",
      labels: { app: "worker" },
      managedFields: [
        {
          manager: "chant:web",
          operation: "Apply",
          apiVersion: "apps/v1",
          fieldsV1: {
            "f:metadata": { "f:labels": { "f:app": {} } },
            "f:spec": {
              "f:selector": {},
              "f:template": {
                "f:spec": { "f:containers": { 'k:{"name":"app"}': { ".": {}, "f:name": {}, "f:image": {} } } },
              },
            },
          },
        },
        {
          // Ownership of replicas transferred here via a direct scale —
          // chant's own apply entry above no longer lists it.
          manager: "kubectl-client-side-apply",
          operation: "Update",
          apiVersion: "apps/v1",
          fieldsV1: { "f:spec": { "f:replicas": {} } },
        },
      ],
    },
    spec: {
      replicas: 9,
      selector: { matchLabels: { app: "worker" } },
      template: { metadata: { labels: { app: "worker" } }, spec: { containers: [{ name: "app", image: "worker:1.0" }] } },
    },
  };

  const cluster = () =>
    fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod")]: webLive,
        [objectKey("apps/v1", "Deployment", "worker", "prod")]: workerLive,
      },
      respond: (req) => (req.path.endsWith("/deployments/broken") ? { status: 500, body: statusBody(500, "InternalError", "backend unavailable") } : undefined),
    });

  const baseline = {
    web: {
      type: "K8s::Apps::Deployment",
      accepted: [{ path: "metadata.annotations.build-id", value: "43" }],
    },
  };

  test("exactly the genuine + contested drift surfaces; controller noise and the accepted annotation do not", async () => {
    const live = normalizeDeepObservation(
      await observeResourcesDeepK8s({ environment: "prod", entityNames: [...declared.keys()], entities: declared }, cluster().connector),
    );
    const result = diffDeepObservation(declared, live, k8sDeepNormalizationHooks, baseline);

    expect(result.drifted).toEqual([
      {
        name: "web",
        type: "K8s::Apps::Deployment",
        changes: [{ path: "metadata.labels.tier", kind: "changed", declared: "backend", live: "frontend" }],
      },
      {
        name: "worker",
        type: "K8s::Apps::Deployment",
        changes: [{ path: "spec.replicas", kind: "changed", declared: 5, live: 9 }],
      },
    ]);

    expect(result.accepted).toEqual([
      {
        name: "web",
        type: "K8s::Apps::Deployment",
        changes: [{ path: "metadata.annotations.build-id", kind: "changed", declared: "42", live: "43", baseline: "43" }],
      },
    ]);

    // The HPA-owned replicas and the Istio sidecar never appear at all — not
    // as drift, not as "undeclared" noise. Pruned before the diff ever runs.
    const webDriftPaths = result.drifted.find((d) => d.name === "web")?.changes.map((c) => c.path) ?? [];
    expect(webDriftPaths).not.toContain("spec.replicas");
    expect(JSON.stringify(result)).not.toContain("istio-proxy");

    expect(result.unobserved).toEqual([
      { name: "broken", type: "K8s::Apps::Deployment", reason: "read-failed", detail: expect.stringContaining("500") },
      {
        name: "cache",
        type: "K8s::Totally::Unknown",
        reason: "unsupported-kind",
        detail: expect.stringContaining("no generated operation surface"),
      },
    ]);
  });

  test("without the baseline the annotation is drift too; accepting it is what silences it", async () => {
    const live = normalizeDeepObservation(
      await observeResourcesDeepK8s({ environment: "prod", entityNames: [...declared.keys()], entities: declared }, cluster().connector),
    );
    const result = diffDeepObservation(declared, live, k8sDeepNormalizationHooks);
    const web = result.drifted.find((d) => d.name === "web");
    expect(web?.changes.map((c) => c.path).sort()).toEqual(["metadata.annotations.build-id", "metadata.labels.tier"]);
    expect(result.accepted).toEqual([]);
  });

  test("a whole-lexicon failure (no client) is a hole for every declared entity, never a clean report", async () => {
    // The reader's contract (matching describe-resources.ts) is to *throw* for
    // an unrecognized connect failure, not to catch it — core's own
    // `observeDeep` orchestration is what turns the throw into NOT-OBSERVED
    // for every entity, so this drives that real composition rather than
    // asserting the reader swallows something it deliberately does not.
    const failingConnect = async () => {
      throw new Error("boom");
    };
    const failingPlugin = {
      observeResourcesDeep: (opts: Parameters<typeof observeResourcesDeepK8s>[0]) =>
        observeResourcesDeepK8s(opts, failingConnect as unknown as Parameters<typeof observeResourcesDeepK8s>[1]),
    };
    const live = await observeDeep(failingPlugin as Parameters<typeof observeDeep>[0], {
      environment: "prod",
      buildOutput: "",
      entities: declared,
    });
    expect(live.resources).toEqual({});
    expect(new Set(Object.values(live.unobserved).map((u) => u.reason))).toEqual(new Set(["read-failed"]));
    expect(Object.keys(live.unobserved).sort()).toEqual(["broken", "cache", "web", "worker"]);
  });
});

/**
 * The managed-fields-specific case named in #1076's acceptance: the same
 * live mutation on the same field is drift when chant owns it, and silence
 * when a controller owns it and source is silent.
 */
describe("the managed-fields twist: ownership decides drift vs silence for the same mutation (#1076)", () => {
  const liveWith = (owner: "chant" | "controller") => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "app",
      namespace: "prod",
      uid: "uid-app",
      managedFields:
        owner === "chant"
          ? [{ manager: "chant:web", operation: "Apply", fieldsV1: { "f:spec": { "f:template": { "f:spec": { "f:containers": { 'k:{"name":"app"}': { "f:image": {} } } } } } } }]
          : [{ manager: "vertical-pod-autoscaler", operation: "Update", fieldsV1: { "f:spec": { "f:template": { "f:spec": { "f:containers": { 'k:{"name":"app"}': { "f:image": {} } } } } } } }],
    },
    spec: { template: { spec: { containers: [{ name: "app", image: "app:2.0" }] } } },
  });

  const declaredWith = (declareImage: boolean) =>
    makeEntities([
      {
        name: "app",
        entityType: "K8s::Apps::Deployment",
        props: {
          metadata: { name: "app", namespace: "prod" },
          spec: {
            template: {
              spec: {
                containers: declareImage ? [{ name: "app", image: "app:1.0" }] : [{ name: "app" }],
              },
            },
          },
        },
      },
    ]);

  test("chant owns the field: the same mutated value is drift", async () => {
    const cluster = fakeCluster({ objects: { [objectKey("apps/v1", "Deployment", "app", "prod")]: liveWith("chant") } });
    const entities = declaredWith(true);
    const live = normalizeDeepObservation(
      await observeResourcesDeepK8s({ environment: "prod", entityNames: ["app"], entities }, cluster.connector),
    );
    const result = diffDeepObservation(entities, live, k8sDeepNormalizationHooks);
    // Addressed by key, not position (the k8s twist on core's set-addressing,
    // #1014) — containers are a set canonicalized by `name`, per this
    // lexicon's own `orderKey` hook.
    expect(result.drifted).toEqual([
      {
        name: "app",
        type: "K8s::Apps::Deployment",
        changes: [{ path: "spec.template.spec.containers[#app].image", kind: "changed", declared: "app:1.0", live: "app:2.0" }],
      },
    ]);
  });

  test("a controller owns the field and source is silent: the same mutated value is silence, not drift and not undeclared noise", async () => {
    const cluster = fakeCluster({ objects: { [objectKey("apps/v1", "Deployment", "app", "prod")]: liveWith("controller") } });
    const entities = declaredWith(false);
    const live = normalizeDeepObservation(
      await observeResourcesDeepK8s({ environment: "prod", entityNames: ["app"], entities }, cluster.connector),
    );
    const result = diffDeepObservation(entities, live, k8sDeepNormalizationHooks);
    expect(result.drifted).toEqual([]);
    expect(result.unchanged).toEqual(["app"]);
    expect(JSON.stringify(result)).not.toContain("app:2.0");
  });
});
