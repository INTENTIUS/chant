import { describe, test, expect } from "vitest";
import {
  K8S_OBJECT_ENVELOPE_PRUNE_PATTERNS,
  k8sListMapOrderKey,
  buildOwnershipSets,
  pruneByOwnership,
  type OwnershipSets,
} from "./managed-fields";
import { normalizeDeepProperties, type DeepNode } from "./deep-observation";

/** The naming scheme both the k8s lexicon (via `@intentius/chant-k8s-client`'s `isChantFieldManager`) and gcp restate use in their own tests. */
function isChantManager(manager: string | undefined): boolean {
  return !!manager && (manager === "chant" || manager.startsWith("chant:"));
}

function node(partial: Partial<DeepNode> & Pick<DeepNode, "path" | "pattern">): DeepNode {
  return {
    entityType: "Test::Entity",
    key: partial.pattern,
    value: undefined,
    side: "live",
    counterpart: "unknown",
    ...partial,
  };
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

describe("pruneByOwnership — the shared three-question rule", () => {
  const sets: OwnershipSets = {
    chantOwned: new Set(["metadata.labels.tier"]),
    foreignOwned: new Set(["spec.replicas", "metadata.annotations.noise"]),
    foreignContested: new Set(["spec.replicas"]),
  };

  test("never prunes the declared side", () => {
    expect(pruneByOwnership(node({ path: "spec.replicas", pattern: "spec.replicas", side: "declared" }), sets)).toBe(false);
  });

  test("never prunes a chant-owned path", () => {
    expect(pruneByOwnership(node({ path: "metadata.labels.tier", pattern: "metadata.labels.tier" }), sets)).toBe(false);
  });

  test("prunes a foreign-owned, uncontested (undeclared) path", () => {
    expect(pruneByOwnership(node({ path: "metadata.annotations.noise", pattern: "metadata.annotations.noise" }), sets)).toBe(true);
  });

  test("keeps a foreign-owned, contested (declared) path", () => {
    expect(pruneByOwnership(node({ path: "spec.replicas", pattern: "spec.replicas" }), sets)).toBe(false);
  });

  test("leaves a path with no ownership information alone (never pruned by this rule)", () => {
    expect(pruneByOwnership(node({ path: "spec.selector", pattern: "spec.selector" }), sets)).toBe(false);
  });
});
