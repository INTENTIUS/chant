import { describe, test, expect, vi } from "vitest";
import { resolveK8sOwnerChain } from "./owner-chain";
import type { K8sObject } from "@intentius/chant-k8s-client";

function pod(uid: string, ownerRefs?: Array<Record<string, unknown>>): K8sObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "p", namespace: "prod", uid, ...(ownerRefs ? { ownerReferences: ownerRefs } : {}) },
  };
}

function ownerRef(kind: string, name: string, uid: string, controller = true): Record<string, unknown> {
  return { apiVersion: "apps/v1", kind, name, uid, controller };
}

describe("resolveK8sOwnerChain (#1077)", () => {
  test("no ownerReferences at all → unowned", async () => {
    const reader = { readIfPresent: vi.fn() };
    const result = await resolveK8sOwnerChain(pod("pod-uid"), {
      declaredByUid: new Map(),
      reader,
      namespace: "prod",
    });
    expect(result).toEqual({ root: "unowned" });
    expect(reader.readIfPresent).not.toHaveBeenCalled();
  });

  test("owner uid matches a declared entity directly → declared, no extra reads", async () => {
    const reader = { readIfPresent: vi.fn() };
    const result = await resolveK8sOwnerChain(pod("pod-uid", [ownerRef("Deployment", "web", "deploy-uid")]), {
      declaredByUid: new Map([["deploy-uid", "web"]]),
      reader,
      namespace: "prod",
    });
    expect(result).toEqual({ root: "declared", entity: "web" });
    expect(reader.readIfPresent).not.toHaveBeenCalled();
  });

  test("Pod → ReplicaSet (undeclared, read live) → Deployment (declared) resolves through the intermediate hop", async () => {
    const replicaSet: K8sObject = {
      apiVersion: "apps/v1",
      kind: "ReplicaSet",
      metadata: {
        name: "web-7d9f8c9c8",
        namespace: "prod",
        uid: "rs-uid",
        ownerReferences: [ownerRef("Deployment", "web", "deploy-uid")],
      },
    };
    const reader = { readIfPresent: vi.fn().mockResolvedValue(replicaSet) };
    const result = await resolveK8sOwnerChain(pod("pod-uid", [ownerRef("ReplicaSet", "web-7d9f8c9c8", "rs-uid")]), {
      declaredByUid: new Map([["deploy-uid", "web"]]),
      reader,
      namespace: "prod",
    });
    expect(result).toEqual({ root: "declared", entity: "web" });
    expect(reader.readIfPresent).toHaveBeenCalledTimes(1);
    expect(reader.readIfPresent).toHaveBeenCalledWith({
      apiVersion: "apps/v1",
      kind: "ReplicaSet",
      name: "web-7d9f8c9c8",
      namespace: "prod",
    });
  });

  test("chain resolves fully to a live, undeclared root → foreign", async () => {
    const replicaSet: K8sObject = {
      apiVersion: "apps/v1",
      kind: "ReplicaSet",
      metadata: { name: "other-rs", namespace: "prod", uid: "rs-uid" }, // no further owner
    };
    const reader = { readIfPresent: vi.fn().mockResolvedValue(replicaSet) };
    const result = await resolveK8sOwnerChain(pod("pod-uid", [ownerRef("ReplicaSet", "other-rs", "rs-uid")]), {
      declaredByUid: new Map(), // nothing declared at all
      reader,
      namespace: "prod",
    });
    expect(result).toEqual({ root: "foreign" });
  });

  test("an owner read that 404s (readIfPresent → undefined) is conservative unknown, not foreign", async () => {
    const reader = { readIfPresent: vi.fn().mockResolvedValue(undefined) };
    const result = await resolveK8sOwnerChain(pod("pod-uid", [ownerRef("ReplicaSet", "gone-rs", "rs-uid")]), {
      declaredByUid: new Map(),
      reader,
      namespace: "prod",
    });
    expect(result).toEqual({ root: "unknown" });
  });

  test("an owner read that throws (RBAC denial, transport error) is conservative unknown", async () => {
    const reader = { readIfPresent: vi.fn().mockRejectedValue(new Error("Forbidden")) };
    const result = await resolveK8sOwnerChain(pod("pod-uid", [ownerRef("ReplicaSet", "denied-rs", "rs-uid")]), {
      declaredByUid: new Map(),
      reader,
      namespace: "prod",
    });
    expect(result).toEqual({ root: "unknown" });
  });

  test("a cycle (A owns B, B owns A) terminates and classifies unknown rather than looping forever", async () => {
    const objA: K8sObject = {
      apiVersion: "v1",
      kind: "Widget",
      metadata: { name: "a", namespace: "prod", uid: "a-uid", ownerReferences: [ownerRef("Widget", "b", "b-uid")] },
    };
    const objB: K8sObject = {
      apiVersion: "v1",
      kind: "Widget",
      metadata: { name: "b", namespace: "prod", uid: "b-uid", ownerReferences: [ownerRef("Widget", "a", "a-uid")] },
    };
    const reader = {
      readIfPresent: vi.fn(async ({ name }: { name: string }) => (name === "a" ? objA : objB)),
    };
    const start: K8sObject = {
      apiVersion: "v1",
      kind: "Widget",
      metadata: { name: "start", namespace: "prod", uid: "start-uid", ownerReferences: [ownerRef("Widget", "a", "a-uid")] },
    };
    const result = await resolveK8sOwnerChain(start, { declaredByUid: new Map(), reader, namespace: "prod" });
    expect(result).toEqual({ root: "unknown" });
  });

  test("respects a custom maxDepth, fetching no more than maxDepth + 1 objects", async () => {
    // A chain 5 hops deep, but bounded to 2 — never reaches the declared root.
    const objects: Record<string, K8sObject> = {};
    for (let i = 0; i < 5; i++) {
      objects[`n${i}`] = {
        apiVersion: "v1",
        kind: "Widget",
        metadata: { name: `n${i}`, namespace: "prod", uid: `uid-${i}`, ownerReferences: [ownerRef("Widget", `n${i + 1}`, `uid-${i + 1}`)] },
      };
    }
    const reader = {
      readIfPresent: vi.fn(async ({ name }: { name: string }) => objects[name]),
    };
    const start: K8sObject = {
      apiVersion: "v1",
      kind: "Widget",
      metadata: { name: "start", namespace: "prod", uid: "start-uid", ownerReferences: [ownerRef("Widget", "n0", "uid-0")] },
    };
    const result = await resolveK8sOwnerChain(start, {
      declaredByUid: new Map([["uid-4", "deep-entity"]]), // reachable, but past the bound
      reader,
      namespace: "prod",
      maxDepth: 2,
    });
    expect(result).toEqual({ root: "unknown" });
    expect(reader.readIfPresent.mock.calls.length).toBeLessThanOrEqual(3); // maxDepth + 1
  });

  test("a starting object without a uid cannot be classified — unknown", async () => {
    const reader = { readIfPresent: vi.fn() };
    const noUid: K8sObject = { apiVersion: "v1", kind: "Pod", metadata: { name: "p", namespace: "prod" } };
    const result = await resolveK8sOwnerChain(noUid, { declaredByUid: new Map(), reader, namespace: "prod" });
    expect(result).toEqual({ root: "unknown" });
    expect(reader.readIfPresent).not.toHaveBeenCalled();
  });

  test("picks the controller:true owner reference when several are present", async () => {
    const reader = { readIfPresent: vi.fn() };
    const refs = [ownerRef("OtherOwner", "shared", "shared-uid", false), ownerRef("Deployment", "web", "deploy-uid", true)];
    const result = await resolveK8sOwnerChain(pod("pod-uid", refs), {
      declaredByUid: new Map([["deploy-uid", "web"]]),
      reader,
      namespace: "prod",
    });
    expect(result).toEqual({ root: "declared", entity: "web" });
  });
});
