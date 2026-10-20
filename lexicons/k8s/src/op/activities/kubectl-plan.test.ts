/**
 * `planManifest` (#3998): a dry-run apply of every declared document,
 * compared with the live object, against the fake cluster.
 *
 * The fake API server below answers a `dryRun=All` apply the way a real one
 * does in the respects the plan depends on: the live object merged with the
 * applied fields, a field the server defaults filled in, and fresh
 * bookkeeping (resource version, generation, managed fields) on every
 * answer. Nothing it answers is persisted.
 */

import { describe, test, expect } from "vitest";
import type { K8sObject } from "@intentius/chant-k8s-client";
import { statusBody, type RecordedRequest } from "@intentius/chant-k8s-client/testing";
import { fakeCluster, objectKey, ownedObject } from "../../api/fake-cluster";
import { planManifest } from "./kubectl";
import { diffFields, normalizeServerObject } from "./apply-diff";

type Obj = Record<string, any>;

function merge(base: Obj, patch: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" ? merge(out[k], v) : v;
  }
  return out;
}

/** The live objects, by API path. */
type Live = Record<string, Obj>;

/** A dry-run responder over `live`. `refuse` answers a path with a 422 instead. */
function dryRunServer(live: Live, refuse: Record<string, string> = {}, missingNamespaces: string[] = []) {
  return (req: RecordedRequest) => {
    if (req.method !== "PATCH") return undefined;
    if (req.query.dryRun !== "All") throw new Error(`a plan sent a PATCH without dryRun=All: ${req.path}`);
    const missing = missingNamespaces.find((ns) => req.path.includes(`/namespaces/${ns}/`));
    if (missing) return { status: 404, body: statusBody(404, "NotFound", `namespaces "${missing}" not found`) };
    if (refuse[req.path]) return { status: 422, body: statusBody(422, "Invalid", refuse[req.path]) };
    const body = JSON.parse(String(req.body)) as Obj;
    const before = live[req.path];
    const result = merge(before ?? {}, body);
    if (result.kind === "Deployment") result.spec = { revisionHistoryLimit: 10, ...(result.spec ?? {}) };
    const ns = req.path.match(/\/namespaces\/([^/]+)\//)?.[1];
    result.metadata = {
      ...result.metadata,
      ...(ns ? { namespace: ns } : {}),
      uid: before?.metadata?.uid ?? "uid-dry-run",
      resourceVersion: "99",
      generation: (before?.metadata?.generation ?? 0) + 1,
      creationTimestamp: before?.metadata?.creationTimestamp ?? "2026-10-19T00:00:00Z",
      managedFields: [{ manager: req.query.fieldManager, operation: "Apply" }],
    };
    return { body: result };
  };
}

const DEPLOY_PATH = "/apis/apps/v1/namespaces/prod/deployments/web";

const declared = (replicas: number): Obj => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "prod" },
  spec: { replicas },
});

/** The live Deployment as the server holds it after chant applied `replicas`. */
const liveWeb = (replicas: number): K8sObject =>
  ({
    ...ownedObject("apps/v1", "Deployment", "web", "prod", {
      metadata: {
        name: "web",
        namespace: "prod",
        labels: { "app.kubernetes.io/managed-by": "chant", "chant.intentius.io/stack": "web" },
        generation: 4,
        creationTimestamp: "2026-01-01T00:00:00Z",
        managedFields: [{ manager: "chant:web", operation: "Apply" }],
      } as never,
    }),
    spec: { replicas, revisionHistoryLimit: 10 },
    status: { readyReplicas: replicas },
  }) as K8sObject;

describe("planManifest (#3998)", () => {
  test("an object with no live counterpart plans as a create, and nothing is persisted", async () => {
    const cluster = fakeCluster({ respond: dryRunServer({}) });
    const plan = await planManifest({ manifest: "k8s.yaml", documents: [declared(3)], stack: "web" }, undefined, cluster.connector);
    expect(plan.fieldManager).toBe("chant:web");
    expect(plan.objects).toHaveLength(1);
    expect(plan.objects[0]).toMatchObject({
      ref: { apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: "prod" },
      action: "create",
      changes: [],
    });
    expect(plan.objects[0].object?.metadata).toMatchObject({ labels: { "chant.intentius.io/stack": "web" } });
    const patches = cluster.layer.requests.filter((r) => r.method === "PATCH");
    expect(patches.map((p) => p.query)).toEqual([{ fieldManager: "chant:web", force: "false", dryRun: "All" }]);
    expect(cluster.layer.requests.some((r) => r.method === "DELETE" || r.method === "POST" || r.method === "PUT")).toBe(false);
  });

  test("a manifest whose dry run equals the live object plans as no change, bookkeeping and defaults ignored", async () => {
    const live = liveWeb(3);
    const cluster = fakeCluster({
      objects: { [objectKey("apps/v1", "Deployment", "web", "prod")]: live },
      respond: dryRunServer({ [DEPLOY_PATH]: live as Obj }),
    });
    const plan = await planManifest({ manifest: "k8s.yaml", documents: [declared(3)], stack: "web" }, undefined, cluster.connector);
    expect(plan.objects.map((o) => [o.action, o.changes])).toEqual([["no-op", []]]);
  });

  test("a changed field plans as an update naming the field, before and after", async () => {
    const live = liveWeb(3);
    const cluster = fakeCluster({
      objects: { [objectKey("apps/v1", "Deployment", "web", "prod")]: live },
      respond: dryRunServer({ [DEPLOY_PATH]: live as Obj }),
    });
    const plan = await planManifest({ manifest: "k8s.yaml", documents: [declared(5)], stack: "web" }, undefined, cluster.connector);
    expect(plan.objects[0].action).toBe("update");
    expect(plan.objects[0].changes).toEqual([{ path: "spec.replicas", before: 3, after: 5 }]);
  });

  test("a change the server refuses as immutable plans as an update carrying the refusal", async () => {
    const live = liveWeb(3);
    const message = 'Deployment.apps "web" is invalid: spec.selector: Invalid value: field is immutable';
    const cluster = fakeCluster({
      objects: { [objectKey("apps/v1", "Deployment", "web", "prod")]: live },
      respond: dryRunServer({ [DEPLOY_PATH]: live as Obj }, { [DEPLOY_PATH]: message }),
    });
    const plan = await planManifest({ manifest: "k8s.yaml", documents: [declared(3)], stack: "web" }, undefined, cluster.connector);
    expect(plan.objects[0]).toMatchObject({ action: "update", changes: [], refused: message });
  });

  test("any other refusal fails the plan, as it would fail the apply", async () => {
    const cluster = fakeCluster({ respond: dryRunServer({}, { [DEPLOY_PATH]: "spec.replicas: Invalid value: -1" }) });
    await expect(
      planManifest({ manifest: "k8s.yaml", documents: [declared(-1)], stack: "web" }, undefined, cluster.connector),
    ).rejects.toThrow(/Invalid value: -1/);
  });

  test("an object in a namespace the same plan creates plans as a create without a dry run of its own", async () => {
    const cluster = fakeCluster({ respond: dryRunServer({}, {}, ["fresh"]) });
    const plan = await planManifest(
      {
        manifest: "k8s.yaml",
        documents: [
          { apiVersion: "v1", kind: "Namespace", metadata: { name: "fresh" } },
          { ...declared(1), metadata: { name: "web", namespace: "fresh" } },
        ],
        stack: "web",
      },
      undefined,
      cluster.connector,
    );
    expect(plan.objects.map((o) => [o.ref.kind, o.action])).toEqual([["Namespace", "create"], ["Deployment", "create"]]);
  });

  test("a namespace that does not exist and is not created here fails the plan", async () => {
    const cluster = fakeCluster({ respond: dryRunServer({}, {}, ["prod"]) });
    await expect(
      planManifest({ manifest: "k8s.yaml", documents: [declared(1)], stack: "web" }, undefined, cluster.connector),
    ).rejects.toThrow(/namespaces "prod" not found/);
  });

  describe("deletes come from the apply's prune scope", () => {
    const objects = () => ({
      [objectKey("apps/v1", "Deployment", "web", "prod")]: liveWeb(3),
      [objectKey("apps/v1", "Deployment", "old", "prod")]: ownedObject("apps/v1", "Deployment", "old", "prod"),
      [objectKey("apps/v1", "Deployment", "handmade", "prod")]: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "handmade", namespace: "prod", labels: { app: "handmade" } },
      },
      [objectKey("apps/v1", "Deployment", "elsewhere", "staging")]: ownedObject("apps/v1", "Deployment", "elsewhere", "staging"),
      [objectKey("v1", "Secret", "master-key", "prod")]: ownedObject("v1", "Secret", "master-key", "prod", {
        metadata: { labels: { "app.kubernetes.io/managed-by": "chant", "chant.intentius.io/generated-once": "true" } },
      }),
    });

    test("owned-only plans a delete for the owned, undeclared object in the touched namespace, and deletes nothing", async () => {
      const cluster = fakeCluster({ objects: objects(), respond: dryRunServer({ [DEPLOY_PATH]: liveWeb(3) as Obj }) });
      const plan = await planManifest(
        { manifest: "k8s.yaml", documents: [declared(3)], stack: "web", deleteMode: "owned-only" },
        undefined,
        cluster.connector,
      );
      expect(plan.deletes).toEqual([{ apiVersion: "apps/v1", kind: "Deployment", name: "old", namespace: "prod" }]);
      expect(plan.retained).toEqual([{ apiVersion: "v1", kind: "Secret", name: "master-key", namespace: "prod" }]);
      expect(cluster.layer.requests.filter((r) => r.method === "DELETE")).toEqual([]);
    });

    test("never plans no deletes and lists nothing", async () => {
      const cluster = fakeCluster({ objects: objects(), respond: dryRunServer({ [DEPLOY_PATH]: liveWeb(3) as Obj }) });
      const plan = await planManifest({ manifest: "k8s.yaml", documents: [declared(3)], stack: "web" }, undefined, cluster.connector);
      expect(plan.deletes).toEqual([]);
      expect(cluster.layer.requests.filter((r) => r.method === "GET" && r.path.endsWith("/deployments"))).toEqual([]);
    });
  });
});

describe("apply-diff (#3998)", () => {
  test("normalizing drops the server's bookkeeping and status, nothing else", () => {
    const normalized = normalizeServerObject({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "c", labels: { a: "1" }, uid: "u", resourceVersion: "9", generation: 2, creationTimestamp: "t", managedFields: [] },
      data: { k: "v" },
      status: { phase: "x" },
    });
    expect(normalized).toEqual({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "c", labels: { a: "1" } }, data: { k: "v" } });
  });

  test("objects are walked to their leaves, lists compared whole, odd keys bracketed", () => {
    const changes = diffFields(
      { metadata: { labels: { "app.kubernetes.io/name": "a", keep: "x" } }, spec: { ports: [{ port: 80 }], gone: 1 } },
      { metadata: { labels: { "app.kubernetes.io/name": "b", keep: "x" } }, spec: { ports: [{ port: 81 }], added: 2 } },
    );
    expect(changes).toEqual([
      { path: 'metadata.labels["app.kubernetes.io/name"]', before: "a", after: "b" },
      { path: "spec.added", after: 2 },
      { path: "spec.gone", before: 1 },
      { path: "spec.ports", before: [{ port: 80 }], after: [{ port: 81 }] },
    ]);
  });
});
