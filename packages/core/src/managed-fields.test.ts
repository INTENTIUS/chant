import { describe, test, expect } from "vitest";
import {
  K8S_OBJECT_ENVELOPE_PRUNE_PATTERNS,
  k8sListMapOrderKey,
  K8S_SYSTEM_METADATA_PRUNE_PATTERNS,
  buildOwnershipSets,
} from "./managed-fields";
import { normalizeDeepProperties } from "./deep-observation";

/** The naming scheme both the k8s lexicon (via `@intentius/chant-k8s-client`'s `isChantFieldManager`) and gcp restate use in their own tests. */
function isChantManager(manager: string | undefined): boolean {
  return !!manager && (manager === "chant" || manager.startsWith("chant:"));
}

describe("K8S_OBJECT_ENVELOPE_PRUNE_PATTERNS — the generic Kubernetes object envelope", () => {
  test("covers status and the server-minted metadata fields", () => {
    for (const p of [
      "status",
      "metadata.uid",
      "metadata.resourceVersion",
      "metadata.generation",
      "metadata.creationTimestamp",
      "metadata.managedFields",
      "metadata.selfLink",
    ]) {
      expect(K8S_OBJECT_ENVELOPE_PRUNE_PATTERNS.has(p)).toBe(true);
    }
  });

  test("does not cover a declared field with a similar name", () => {
    expect(K8S_OBJECT_ENVELOPE_PRUNE_PATTERNS.has("metadata.labels")).toBe(false);
    expect(K8S_OBJECT_ENVELOPE_PRUNE_PATTERNS.has("spec.status")).toBe(false);
  });
});

describe("k8sListMapOrderKey — Kubernetes' own list-map-key conventions", () => {
  test("orders containers, env and volumes by name", () => {
    const out = normalizeDeepProperties(
      {
        containers: [{ name: "sidecar" }, { name: "app" }],
        env: [{ name: "Z" }, { name: "A" }],
      },
      { entityType: "Any::Type", side: "live", hooks: { orderKey: k8sListMapOrderKey } },
    );
    expect((out.containers as Array<{ name: string }>).map((c) => c.name)).toEqual(["app", "sidecar"]);
    expect((out.env as Array<{ name: string }>).map((e) => e.name)).toEqual(["A", "Z"]);
  });

  test("orders container ports by containerPort+protocol and service ports by port+protocol", () => {
    const containerPorts = normalizeDeepProperties(
      { ports: [{ containerPort: 9090, protocol: "TCP" }, { containerPort: 8080, protocol: "TCP" }] },
      { entityType: "Any::Type", side: "live", hooks: { orderKey: k8sListMapOrderKey } },
    );
    expect((containerPorts.ports as Array<{ containerPort: number }>).map((p) => p.containerPort)).toEqual([8080, 9090]);

    const servicePorts = normalizeDeepProperties(
      { ports: [{ port: 443, protocol: "TCP" }, { port: 80, protocol: "TCP" }] },
      { entityType: "Any::Type", side: "live", hooks: { orderKey: k8sListMapOrderKey } },
    );
    expect((servicePorts.ports as Array<{ port: number }>).map((p) => p.port)).toEqual([80, 443]);
  });

  test("leaves an unrecognized array's order alone", () => {
    expect(k8sListMapOrderKey({ entityType: "Any", path: "widgets", pattern: "widgets", element: { z: 1 }, index: 0, side: "live" })).toBeUndefined();
  });
});

describe("buildOwnershipSets — resolving managedFields against live and declared trees", () => {
  test("a scalar owned by chant is chant-owned regardless of the declared tree", () => {
    const sets = buildOwnershipSets(
      [{ manager: "chant:web", operation: "Apply", fieldsV1: { "f:spec": { "f:replicas": {} } } }],
      { spec: { replicas: 3 } },
      {},
      isChantManager,
    );
    expect(sets.chantOwned.has("spec.replicas")).toBe(true);
    expect(sets.foreignOwned.has("spec.replicas")).toBe(false);
  });

  test("a scalar owned by a foreign manager and undeclared is foreign-owned, not contested", () => {
    const sets = buildOwnershipSets(
      [{ manager: "kube-controller-manager", operation: "Update", fieldsV1: { "f:spec": { "f:replicas": {} } } }],
      { spec: { replicas: 7 } },
      { spec: {} },
      isChantManager,
    );
    expect(sets.foreignOwned.has("spec.replicas")).toBe(true);
    expect(sets.foreignContested.has("spec.replicas")).toBe(false);
  });

  test("a scalar owned by a foreign manager AND declared is contested", () => {
    const sets = buildOwnershipSets(
      [{ manager: "kubectl-client-side-apply", operation: "Update", fieldsV1: { "f:spec": { "f:replicas": {} } } }],
      { spec: { replicas: 9 } },
      { spec: { replicas: 5 } },
      isChantManager,
    );
    expect(sets.foreignOwned.has("spec.replicas")).toBe(true);
    expect(sets.foreignContested.has("spec.replicas")).toBe(true);
  });

  test("a keyed list item resolves to its live index, independent of position in the declared array", () => {
    const sets = buildOwnershipSets(
      [
        {
          manager: "istio-sidecar-injector",
          operation: "Update",
          fieldsV1: { "f:spec": { "f:containers": { 'k:{"name":"istio-proxy"}': { ".": {}, "f:name": {} } } } },
        },
      ],
      { spec: { containers: [{ name: "istio-proxy" }, { name: "app" }] } },
      { spec: { containers: [{ name: "app" }] } },
      isChantManager,
    );
    expect(sets.foreignOwned.has("spec.containers[0]")).toBe(true);
    expect(sets.foreignContested.has("spec.containers[0]")).toBe(false);
  });

  test("a subresource entry (status) is excluded", () => {
    const sets = buildOwnershipSets(
      [{ manager: "kube-controller-manager", operation: "Update", subresource: "status", fieldsV1: { "f:status": { "f:readyReplicas": {} } } }],
      { status: { readyReplicas: 3 } },
      {},
      isChantManager,
    );
    expect(sets.foreignOwned.size).toBe(0);
  });

  test("an entry with no manager name is skipped", () => {
    const sets = buildOwnershipSets(
      [{ operation: "Update", fieldsV1: { "f:spec": {} } }],
      { spec: {} },
      {},
      isChantManager,
    );
    expect(sets.chantOwned.size).toBe(0);
    expect(sets.foreignOwned.size).toBe(0);
  });
});

describe("K8S_SYSTEM_METADATA_PRUNE_PATTERNS — what the controllers stamp, not what a human labels (#1191)", () => {
  test("covers client-side apply bookkeeping, the Deployment controller's rollout counters and the controllers' selector labels", () => {
    for (const p of [
      "metadata.annotations.kubectl.kubernetes.io/last-applied-configuration",
      "metadata.annotations.deployment.kubernetes.io/revision",
      "metadata.labels.pod-template-hash",
      "metadata.labels.controller-revision-hash",
    ]) {
      expect(K8S_SYSTEM_METADATA_PRUNE_PATTERNS.has(p)).toBe(true);
    }
  });

  test("an out-of-band user label is not on the list — it has to reach the diff as undeclared", () => {
    expect(K8S_SYSTEM_METADATA_PRUNE_PATTERNS.has("metadata.labels.team")).toBe(false);
    expect(K8S_SYSTEM_METADATA_PRUNE_PATTERNS.has("metadata.annotations.kubernetes.io/change-cause")).toBe(false);
  });
});

// #1189 — the three sets answer "which category owns this path". A reader needs
// the other question: `hpa-controller` and `kubectl-client-side-apply` are the
// same category and mean opposite things to an operator.
describe("buildOwnershipSets — owning manager per path (#1189)", () => {
  const entries = [
    { manager: "chant", operation: "Apply", fieldsV1: { "f:metadata": { "f:labels": { "f:tier": {} } } } },
    { manager: "hpa-controller", operation: "Apply", fieldsV1: { "f:spec": { "f:replicas": {} } } },
    {
      manager: "kubectl-client-side-apply",
      operation: "Update",
      fieldsV1: { "f:spec": { "f:template": { "f:spec": { "f:containers": {} } } } },
    },
  ];

  test("records which manager owns each path", () => {
    const sets = buildOwnershipSets(
      entries,
      { metadata: { labels: { tier: "web" } }, spec: { replicas: 3, template: { spec: { containers: [] } } } },
      { metadata: { labels: { tier: "web" } }, spec: { replicas: 2 } },
      (m) => m === "chant",
    );
    expect(sets.owners.get("metadata.labels.tier")).toBe("chant");
    expect(sets.owners.get("spec.replicas")).toBe("hpa-controller");
    expect(sets.owners.get("spec.template.spec.containers")).toBe("kubectl-client-side-apply");
  });

  test("the categories are unchanged by recording owners", () => {
    const sets = buildOwnershipSets(
      entries,
      { metadata: { labels: { tier: "web" } }, spec: { replicas: 3, template: { spec: { containers: [] } } } },
      { metadata: { labels: { tier: "web" } }, spec: { replicas: 2 } },
      (m) => m === "chant",
    );
    expect(sets.chantOwned.has("metadata.labels.tier")).toBe(true);
    expect(sets.foreignOwned.has("spec.replicas")).toBe(true);
    // Declared AND foreign-owned — contested, so still diffable.
    expect(sets.foreignContested.has("spec.replicas")).toBe(true);
  });

  test("is empty when the object carries no managedFields at all", () => {
    const sets = buildOwnershipSets([], { spec: {} }, { spec: {} }, (m) => m === "chant");
    expect(sets.owners.size).toBe(0);
  });
});
