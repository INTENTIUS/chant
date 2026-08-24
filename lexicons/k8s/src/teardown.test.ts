/**
 * Env teardown over the fake cluster (chant #1222) — the k8s halves of the
 * teardownOwned / executeTeardown capability pair, mirroring the typed-prune
 * tests in op/activities/kubectl.test.ts: a real client over a fake request
 * layer, so discovery, path construction, and the delete path all run for
 * real.
 */

import { describe, test, expect } from "vitest";
import { LABEL_OWNERSHIP_KEYS, OWNERSHIP_MANAGED_BY_VALUE } from "@intentius/chant/ownership";
import { statusBody } from "@intentius/chant-k8s-client/testing";
import { fakeCluster, objectKey, ownedObject } from "./api/fake-cluster";
import { teardownOwned, executeTeardown } from "./teardown";

const MARKER = { stack: "shop", env: "dev" };

function markerLabels(stack: string, env?: string): Record<string, string> {
  return {
    [LABEL_OWNERSHIP_KEYS.managedBy]: OWNERSHIP_MANAGED_BY_VALUE,
    [LABEL_OWNERSHIP_KEYS.stack]: stack,
    ...(env ? { [LABEL_OWNERSHIP_KEYS.env]: env } : {}),
  };
}

/** A cluster holding this env's estate plus every kind of near-miss. */
function estateCluster(overrides: Parameters<typeof fakeCluster>[0] = {}) {
  return fakeCluster({
    objects: {
      // Mine: full marker, this stack, this env.
      [objectKey("apps/v1", "Deployment", "web", "prod-ns")]: ownedObject("apps/v1", "Deployment", "web", "prod-ns", {
        metadata: { labels: markerLabels("shop", "dev") },
      }),
      [objectKey("v1", "Service", "cache", "prod-ns")]: ownedObject("v1", "Service", "cache", "prod-ns", {
        metadata: { labels: markerLabels("shop", "dev") },
      }),
      [objectKey("v1", "Namespace", "dev-ns")]: ownedObject("v1", "Namespace", "dev-ns", undefined, {
        metadata: { labels: markerLabels("shop", "dev") },
      }),
      // Near-misses: foreign stack, foreign env, env-less marker, unmarked.
      [objectKey("apps/v1", "Deployment", "their-web", "prod-ns")]: ownedObject("apps/v1", "Deployment", "their-web", "prod-ns", {
        metadata: { labels: markerLabels("blog", "dev") },
      }),
      [objectKey("apps/v1", "Deployment", "prod-twin", "prod-ns")]: ownedObject("apps/v1", "Deployment", "prod-twin", "prod-ns", {
        metadata: { labels: markerLabels("shop", "prod") },
      }),
      [objectKey("apps/v1", "Deployment", "no-env", "prod-ns")]: ownedObject("apps/v1", "Deployment", "no-env", "prod-ns", {
        metadata: { labels: markerLabels("shop") },
      }),
      [objectKey("apps/v1", "Deployment", "handmade", "prod-ns")]: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "handmade", namespace: "prod-ns", labels: { app: "handmade" } },
      },
    },
    ...overrides,
  });
}

describe("teardownOwned — marker-env-scoped enumeration", () => {
  test("selects exactly the objects carrying this stack + env, nothing near", async () => {
    const cluster = estateCluster();
    const enumeration = await teardownOwned({ environment: "dev", marker: MARKER }, cluster.connector);
    expect(enumeration.candidates.map((c) => c.name).sort()).toEqual(["dev-ns", "prod-ns/cache", "prod-ns/web"]);
    for (const candidate of enumeration.candidates) {
      expect(candidate.marker).toEqual(MARKER);
    }
    const web = enumeration.candidates.find((c) => c.name === "prod-ns/web")!;
    expect(web.type).toBe("K8s::Apps::Deployment");
    expect(web.physicalId).toBe("uid-web");
    expect(enumeration.holes ?? []).toEqual([]);
  });

  test("the selector is sent to the server: managed-by + stack + env", async () => {
    const cluster = estateCluster();
    await teardownOwned({ environment: "dev", marker: MARKER }, cluster.connector);
    const listQueries = cluster.layer.requests
      .filter((r) => r.method === "GET" && r.query.labelSelector !== undefined)
      .map((r) => r.query.labelSelector);
    expect(listQueries.length).toBeGreaterThan(0);
    for (const selector of listQueries) {
      expect(selector).toBe(
        `${LABEL_OWNERSHIP_KEYS.managedBy}=${OWNERSHIP_MANAGED_BY_VALUE},` +
        `${LABEL_OWNERSHIP_KEYS.stack}=shop,${LABEL_OWNERSHIP_KEYS.env}=dev`,
      );
    }
  });

  test("an object already terminating is not a candidate", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "leaving", "prod-ns")]: ownedObject("apps/v1", "Deployment", "leaving", "prod-ns", {
          metadata: { labels: markerLabels("shop", "dev"), deletionTimestamp: "2026-08-23T00:00:00Z" } as never,
        }),
      },
    });
    const enumeration = await teardownOwned({ environment: "dev", marker: MARKER }, cluster.connector);
    expect(enumeration.candidates).toEqual([]);
  });

  test("a kind that fails to list is a hole, and the others still enumerate (#1089)", async () => {
    const cluster = estateCluster({
      respond: (req) => {
        if (req.method === "GET" && req.path.endsWith("/deployments") && req.query.labelSelector !== undefined) {
          return { status: 500, body: statusBody(500, "InternalError", "etcd is unhappy") };
        }
        return undefined;
      },
    });
    const enumeration = await teardownOwned({ environment: "dev", marker: MARKER }, cluster.connector);
    expect(enumeration.candidates.map((c) => c.name).sort()).toEqual(["dev-ns", "prod-ns/cache"]);
    const hole = (enumeration.holes ?? []).find((h) => h.name === "K8s::Apps::Deployment");
    expect(hole).toBeDefined();
    expect(hole!.reason).toBe("read-failed");
  });
});

describe("executeTeardown — typed deletes, namespaces last", () => {
  const candidates = [
    { name: "dev-ns", type: "K8s::Core::Namespace", marker: MARKER },
    { name: "prod-ns/web", type: "K8s::Apps::Deployment", physicalId: "uid-web", marker: MARKER },
    { name: "prod-ns/cache", type: "K8s::Core::Service", marker: MARKER },
  ];

  test("deletes every candidate through the typed client, namespace last", async () => {
    const cluster = estateCluster();
    const execution = await executeTeardown({ environment: "dev", marker: MARKER, candidates }, cluster.connector);

    expect(execution.outcomes.map((o) => ({ name: o.name, outcome: o.outcome }))).toEqual([
      { name: "prod-ns/web", outcome: "deleted" },
      { name: "prod-ns/cache", outcome: "deleted" },
      { name: "dev-ns", outcome: "deleted" },
    ]);
    const deletes = cluster.layer.requests.filter((r) => r.method === "DELETE").map((r) => r.path);
    expect(deletes).toEqual([
      "/apis/apps/v1/namespaces/prod-ns/deployments/web",
      "/api/v1/namespaces/prod-ns/services/cache",
      "/api/v1/namespaces/dev-ns",
    ]);
  });

  test("an already-absent candidate is deleted (idempotent), with no DELETE issued", async () => {
    const cluster = fakeCluster({ objects: {} });
    const execution = await executeTeardown(
      { environment: "dev", marker: MARKER, candidates: [candidates[1]] },
      cluster.connector,
    );
    expect(execution.outcomes).toEqual([
      {
        name: "prod-ns/web",
        type: "K8s::Apps::Deployment",
        physicalId: "uid-web",
        outcome: "deleted",
        detail: "already absent",
      },
    ]);
    expect(cluster.layer.requests.filter((r) => r.method === "DELETE")).toEqual([]);
  });

  test("a live object whose marker changed since planning is not-prunable, never deleted", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "prod-ns")]: ownedObject("apps/v1", "Deployment", "web", "prod-ns", {
          metadata: { labels: markerLabels("blog", "dev") }, // re-stamped by someone else
        }),
      },
    });
    const execution = await executeTeardown(
      { environment: "dev", marker: MARKER, candidates: [candidates[1]] },
      cluster.connector,
    );
    expect(execution.outcomes[0].outcome).toBe("not-prunable");
    expect(execution.outcomes[0].detail).toContain("marker identity");
    expect(cluster.layer.requests.filter((r) => r.method === "DELETE")).toEqual([]);
  });

  test("a refused delete is a failed outcome with the server's message, not a throw", async () => {
    const cluster = estateCluster({
      respond: (req) =>
        req.method === "DELETE"
          ? { status: 403, body: statusBody(403, "Forbidden", "RBAC says no") }
          : undefined,
    });
    const execution = await executeTeardown(
      { environment: "dev", marker: MARKER, candidates: [candidates[1]] },
      cluster.connector,
    );
    expect(execution.outcomes[0].outcome).toBe("failed");
    expect(execution.outcomes[0].detail).toContain("RBAC says no");
  });

  test("a candidate of an unmapped type is not-prunable, not a crash", async () => {
    const cluster = fakeCluster({ objects: {} });
    const execution = await executeTeardown(
      {
        environment: "dev",
        marker: MARKER,
        candidates: [{ name: "mystery", type: "K8s::NotAThing::Widget", marker: MARKER }],
      },
      cluster.connector,
    );
    expect(execution.outcomes[0].outcome).toBe("not-prunable");
    expect(execution.outcomes[0].detail).toContain("no operation mapping");
  });
});
