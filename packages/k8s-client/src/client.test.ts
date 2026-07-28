/**
 * The client, exercised against the real `@kubernetes/client-node` with its
 * HTTP send replaced (chant #1074).
 *
 * Nothing here reads an ambient kubeconfig: every case passes a literal one,
 * so the developer's real `~/.kube/config` and `KUBECONFIG` are never
 * consulted and no request can leave the process. What *does* run for real is
 * everything above the send: kubeconfig parsing, context selection, the
 * credential policy, the auth path that writes `Authorization`, discovery, and
 * URL construction.
 */

import { describe, test, expect } from "vitest";
import { createK8sClient } from "./client";
import { K8sApiError, K8sTransportError, ExecCredentialNotAllowedError, FieldManagerError, KubeConfigError, UnknownResourceError } from "./errors";
import { FieldManagerConflictError } from "./conflict";
import { apiResourceList, fakeKubeconfig, fakeRequestLayer, statusBody } from "./testing";
import type { RecordedRequest } from "./testing";

const CORE_V1 = apiResourceList("v1", [
  { name: "pods", kind: "Pod", singularName: "pod", shortNames: ["po"] },
  { name: "pods/status", kind: "Pod" },
  { name: "services", kind: "Service", singularName: "service", shortNames: ["svc"] },
  { name: "namespaces", kind: "Namespace", namespaced: false },
  { name: "configmaps", kind: "ConfigMap", shortNames: ["cm"] },
]);

const APPS_V1 = apiResourceList("apps/v1", [
  { name: "deployments", kind: "Deployment", singularName: "deployment", shortNames: ["deploy"] },
  { name: "statefulsets", kind: "StatefulSet" },
]);

const RAY_V1 = apiResourceList("ray.io/v1", [
  { name: "rayclusters", kind: "RayCluster", singularName: "raycluster" },
  { name: "rayjobs", kind: "RayJob" },
]);

const CERT_V1 = apiResourceList("cert-manager.io/v1", [
  { name: "certificates", kind: "Certificate", singularName: "certificate", shortNames: ["cert"] },
]);

const ROOT_DISCOVERY: Record<string, unknown> = {
  "/api": { kind: "APIVersions", versions: ["v1"] },
  "/apis": {
    kind: "APIGroupList",
    groups: [
      { name: "apps", preferredVersion: { groupVersion: "apps/v1", version: "v1" }, versions: [{ groupVersion: "apps/v1" }] },
      { name: "ray.io", preferredVersion: { groupVersion: "ray.io/v1", version: "v1" }, versions: [{ groupVersion: "ray.io/v1" }] },
      {
        name: "cert-manager.io",
        preferredVersion: { groupVersion: "cert-manager.io/v1", version: "v1" },
        versions: [{ groupVersion: "cert-manager.io/v1" }],
      },
    ],
  },
  "/api/v1": CORE_V1,
  "/apis/apps/v1": APPS_V1,
  "/apis/ray.io/v1": RAY_V1,
  "/apis/cert-manager.io/v1": CERT_V1,
};

function deployment(name: string, namespace = "prod"): Record<string, unknown> {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, uid: `uid-${name}`, resourceVersion: "42", labels: { app: name } },
    status: { replicas: 3, readyReplicas: 3 },
  };
}

/** A cluster that answers discovery plus whatever `objects` maps by path. */
function cluster(objects: Record<string, unknown> = {}, override?: (req: RecordedRequest) => unknown) {
  return fakeRequestLayer((req) => {
    const custom = override?.(req);
    if (custom !== undefined) return custom as { status?: number; body?: unknown };
    if (req.path in ROOT_DISCOVERY) return { body: ROOT_DISCOVERY[req.path] };
    if (req.path in objects) return { body: objects[req.path] };
    return { status: 404, body: statusBody(404, "NotFound", `${req.path} not found`) };
  });
}

async function client(layer: ReturnType<typeof cluster>, options: Record<string, unknown> = {}) {
  return createK8sClient({ kubeconfig: fakeKubeconfig(), requestLayer: layer, ...options });
}

describe("createK8sClient — kubeconfig and credential policy", () => {
  test("resolves the bound context explicitly, and records it as bound", async () => {
    const layer = cluster();
    const c = await createK8sClient({
      kubeconfig: fakeKubeconfig({
        contexts: [
          { name: "staging-eks", cluster: "staging", user: "staging-user" },
          { name: "prod-eks", cluster: "prod", user: "prod-user", namespace: "prod" },
        ],
        currentContext: "staging-eks",
      }),
      context: "prod-eks",
      contextSource: "bound",
      requestLayer: layer,
    });

    expect(c.provenance.context).toBe("prod-eks");
    expect(c.provenance.contextSource).toBe("bound");
    expect(c.provenance.kubeconfigSource).toBe("explicit-string");
    expect(c.defaultNamespace).toBe("prod");
  });

  test("a context the kubeconfig does not have refuses by name, before any request", async () => {
    const layer = cluster();
    await expect(
      createK8sClient({
        kubeconfig: fakeKubeconfig({ contexts: [{ name: "dev" }] }),
        context: "prod-eks",
        requestLayer: layer,
      }),
    ).rejects.toThrow(KubeConfigError);
    expect(layer.requests).toHaveLength(0);
  });

  test("an exec credential plugin off the allowlist refuses before it can run", async () => {
    const layer = cluster();
    await expect(
      createK8sClient({
        kubeconfig: fakeKubeconfig({ exec: { command: "/opt/evil/harvest-creds" } }),
        requestLayer: layer,
      }),
    ).rejects.toThrow(ExecCredentialNotAllowedError);
    expect(layer.requests).toHaveLength(0);
  });

  test("the three managed-cluster plugins are allowed by default, and recorded as provenance", async () => {
    for (const command of ["aws", "gke-gcloud-auth-plugin", "kubelogin"]) {
      const c = await createK8sClient({
        kubeconfig: fakeKubeconfig({ exec: { command, args: ["--version"] } }),
        requestLayer: cluster(),
      });
      expect(c.provenance.credential).toBe("exec-plugin");
      expect(c.provenance.execCommand).toBe(command);
    }
  });

  test("a static token authorizes every request through client-node's own auth path", async () => {
    const layer = cluster({ "/apis/apps/v1/namespaces/prod/deployments/web": deployment("web") });
    const c = await createK8sClient({
      kubeconfig: fakeKubeconfig({ token: "sekret-token" }),
      requestLayer: layer,
    });
    await c.read({ apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: "prod" });

    expect(layer.requests.length).toBeGreaterThan(0);
    for (const req of layer.requests) {
      expect(req.headers.Authorization).toBe("Bearer sekret-token");
    }
    expect(c.provenance.credential).toBe("token");
  });
});

describe("resource resolution through the cluster's own discovery", () => {
  test("a CRD resolves with no hand-maintained mapping anywhere", async () => {
    const c = await client(cluster());
    const info = await c.resolve({ apiVersion: "ray.io/v1", kind: "RayCluster" });
    expect(info).toMatchObject({ name: "rayclusters", namespaced: true, group: "ray.io", version: "v1" });
  });

  test("a cluster-scoped kind is reported as such, and its path carries no namespace", async () => {
    const layer = cluster({ "/api/v1/namespaces/ns-a": { apiVersion: "v1", kind: "Namespace", metadata: { name: "ns-a" } } });
    const c = await client(layer);
    const info = await c.resolve({ apiVersion: "v1", kind: "Namespace" });
    expect(info?.namespaced).toBe(false);

    await c.read({ apiVersion: "v1", kind: "Namespace", name: "ns-a" });
    expect(layer.paths()).toContain("/api/v1/namespaces/ns-a");
    expect(layer.paths().some((p) => p.includes("/namespaces/default/namespaces"))).toBe(false);
  });

  test("subresources are never mistaken for resources", async () => {
    const c = await client(cluster());
    const info = await c.resolve({ apiVersion: "v1", kind: "Pod" });
    expect(info?.name).toBe("pods");
  });

  test("a kind the cluster does not serve resolves to undefined rather than throwing", async () => {
    const c = await client(cluster());
    expect(await c.resolve({ apiVersion: "apps/v1", kind: "Widget" })).toBeUndefined();
    // A whole group/version the cluster has never heard of, likewise.
    expect(await c.resolve({ apiVersion: "widgets.example.com/v1", kind: "Widget" })).toBeUndefined();
  });

  test("discovery is fetched once per apiVersion no matter how many entities need it", async () => {
    const objects: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) objects[`/apis/apps/v1/namespaces/prod/deployments/web-${i}`] = deployment(`web-${i}`);
    const layer = cluster(objects);
    const c = await client(layer);

    await c.concurrently(
      Array.from({ length: 25 }, (_, i) => i),
      (i) => c.read({ apiVersion: "apps/v1", kind: "Deployment", name: `web-${i}`, namespace: "prod" }),
    );

    expect(layer.paths().filter((p) => p === "/apis/apps/v1")).toHaveLength(1);
    expect(c.discoveryCacheKeys()).toEqual(["apps/v1"]);
  });

  test("kubectl-style resource strings resolve the way kubectl resolves them", async () => {
    const c = await client(cluster());
    // plural.group — how waitForReady's callers have always spelled CRDs
    expect((await c.resolve({ resource: "raycluster.ray.io" }))?.name).toBe("rayclusters");
    // bare plural, searched across every served group-version
    expect((await c.resolve({ resource: "certificates" }))?.apiVersion).toBe("cert-manager.io/v1");
    // short name
    expect((await c.resolve({ resource: "deploy" }))?.name).toBe("deployments");
    // kind
    expect((await c.resolve({ resource: "StatefulSet" }))?.name).toBe("statefulsets");
    // explicit group argument
    expect((await c.resolve({ resource: "deployments", group: "apps" }))?.apiVersion).toBe("apps/v1");
    // nothing matching
    expect(await c.resolve({ resource: "widgets" })).toBeUndefined();
  });
});

describe("reads", () => {
  test("builds the namespaced object path from discovery and returns the raw object", async () => {
    const layer = cluster({ "/apis/apps/v1/namespaces/prod/deployments/web": deployment("web") });
    const c = await client(layer);
    const obj = await c.read({ apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: "prod" });

    expect(obj.metadata?.uid).toBe("uid-web");
    // Raw, not coerced into a model: nothing was dropped and nothing became a Date.
    expect(obj.metadata?.resourceVersion).toBe("42");
    expect(obj.status).toEqual({ replicas: 3, readyReplicas: 3 });
    expect(layer.paths()).toEqual(["/apis/apps/v1", "/apis/apps/v1/namespaces/prod/deployments/web"]);
  });

  test("an object with no namespace falls back to the context's namespace", async () => {
    const layer = cluster({ "/apis/apps/v1/namespaces/team-a/deployments/web": deployment("web", "team-a") });
    const c = await createK8sClient({
      kubeconfig: fakeKubeconfig({ contexts: [{ name: "ctx", namespace: "team-a" }] }),
      requestLayer: layer,
    });
    await c.read({ apiVersion: "apps/v1", kind: "Deployment", name: "web" });
    expect(layer.paths()).toContain("/apis/apps/v1/namespaces/team-a/deployments/web");
  });

  test("a 404 arrives as a typed error, not a parsed stderr line", async () => {
    const c = await client(cluster());
    const err = await c
      .read({ apiVersion: "apps/v1", kind: "Deployment", name: "gone", namespace: "prod" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(K8sApiError);
    expect((err as K8sApiError).statusCode).toBe(404);
    expect((err as K8sApiError).reason).toBe("NotFound");
    expect((err as K8sApiError).notFound).toBe(true);
    expect((err as K8sApiError).forbidden).toBe(false);
  });

  test.each([
    [401, "Unauthorized", "unauthorized"],
    [403, "Forbidden", "forbidden"],
    [409, "Conflict", "conflict"],
  ])("HTTP %i / %s classifies structurally", async (code, reason, flag) => {
    const layer = cluster({}, (req) =>
      req.path.endsWith("/deployments/web") ? { status: code, body: statusBody(code, reason, "nope") } : undefined,
    );
    const c = await client(layer);
    const err = (await c
      .read({ apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: "prod" })
      .catch((e: unknown) => e)) as K8sApiError;

    expect(err).toBeInstanceOf(K8sApiError);
    expect(err.statusCode).toBe(code);
    expect(err.reason).toBe(reason);
    expect(err[flag as "unauthorized" | "forbidden" | "conflict"]).toBe(true);
  });

  test("a kind the cluster does not serve is an UnknownResourceError, distinct from a 404", async () => {
    const c = await client(cluster());
    await expect(
      c.read({ apiVersion: "widgets.example.com/v1", kind: "Widget", name: "w", namespace: "prod" }),
    ).rejects.toThrow(UnknownResourceError);
  });

  test("a transport failure is a K8sTransportError carrying its cause", async () => {
    const layer = fakeRequestLayer(() => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:6443");
    });
    const c = await client(layer as unknown as ReturnType<typeof cluster>);
    const err = (await c
      .read({ apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: "prod" })
      .catch((e: unknown) => e)) as K8sTransportError;

    expect(err).toBeInstanceOf(K8sTransportError);
    expect(err.message).toContain("ECONNREFUSED");
  });

  test("readIfPresent turns a 404 into undefined and leaves other failures alone", async () => {
    const layer = cluster({ "/apis/apps/v1/namespaces/prod/deployments/web": deployment("web") }, (req) =>
      req.path.endsWith("/deployments/denied") ? { status: 403, body: statusBody(403, "Forbidden", "rbac") } : undefined,
    );
    const c = await client(layer);
    expect(await c.readIfPresent({ apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: "prod" })).toBeTruthy();
    expect(await c.readIfPresent({ apiVersion: "apps/v1", kind: "Deployment", name: "gone", namespace: "prod" })).toBeUndefined();
    await expect(
      c.readIfPresent({ apiVersion: "apps/v1", kind: "Deployment", name: "denied", namespace: "prod" }),
    ).rejects.toThrow(K8sApiError);
  });
});

describe("concurrency", () => {
  test("100 reads are not 100 serial round trips, and never exceed the ceiling", async () => {
    let inFlight = 0;
    let peak = 0;
    const objects: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) objects[`/apis/apps/v1/namespaces/prod/deployments/web-${i}`] = deployment(`web-${i}`);

    const layer = fakeRequestLayer(async (req) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      if (req.path in ROOT_DISCOVERY) return { body: ROOT_DISCOVERY[req.path] };
      if (req.path in objects) return { body: objects[req.path] };
      return { status: 404, body: statusBody(404, "NotFound", "no") };
    });

    const c = await createK8sClient({ kubeconfig: fakeKubeconfig(), requestLayer: layer, concurrency: 8 });
    const results = await c.concurrently(
      Array.from({ length: 100 }, (_, i) => i),
      (i) => c.read({ apiVersion: "apps/v1", kind: "Deployment", name: `web-${i}`, namespace: "prod" }),
    );

    expect(results).toHaveLength(100);
    expect(results[0].metadata?.name).toBe("web-0");
    expect(results[99].metadata?.name).toBe("web-99");
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });
});

describe("list", () => {
  test("lists across all namespaces and follows continue tokens", async () => {
    const layer = fakeRequestLayer((req) => {
      if (req.path in ROOT_DISCOVERY) return { body: ROOT_DISCOVERY[req.path] };
      if (req.path === "/apis/apps/v1/deployments") {
        return req.query.continue === "page2"
          ? { body: { items: [deployment("b")], metadata: {} } }
          : { body: { items: [deployment("a")], metadata: { continue: "page2" } } };
      }
      return { status: 404, body: statusBody(404, "NotFound", "no") };
    });
    const c = await client(layer as unknown as ReturnType<typeof cluster>);
    const items = await c.list({ apiVersion: "apps/v1", kind: "Deployment" });
    expect(items.map((i) => i.metadata?.name)).toEqual(["a", "b"]);
  });

  test("a namespace narrows the path", async () => {
    const layer = cluster({ "/apis/apps/v1/namespaces/prod/deployments": { items: [deployment("a")] } });
    const c = await client(layer);
    await c.list({ apiVersion: "apps/v1", kind: "Deployment" }, { namespace: "prod" });
    expect(layer.paths()).toContain("/apis/apps/v1/namespaces/prod/deployments");
  });

  test("a label selector is sent to the server, not filtered afterwards (chant #1075)", async () => {
    const layer = cluster({ "/apis/apps/v1/namespaces/prod/deployments": { items: [deployment("a")] } });
    const c = await client(layer);
    await c.list(
      { apiVersion: "apps/v1", kind: "Deployment" },
      { namespace: "prod", labelSelector: "app.kubernetes.io/managed-by=chant" },
    );
    const listed = layer.requests.find((r) => r.path === "/apis/apps/v1/namespaces/prod/deployments")!;
    expect(listed.query.labelSelector).toBe("app.kubernetes.io/managed-by=chant");
  });
});

describe("delete (chant #1075 — the prune path)", () => {
  test("DELETEs the addressed object", async () => {
    const layer = cluster({}, (req) => (req.method === "DELETE" ? { body: statusBody(200, "", "ok") } : undefined));
    const c = await client(layer);
    await c.delete({ apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: "prod" });
    const deleted = layer.requests.find((r) => r.method === "DELETE")!;
    expect(deleted.path).toBe("/apis/apps/v1/namespaces/prod/deployments/web");
    expect(deleted.query.propagationPolicy).toBeUndefined();
  });

  test("a propagation policy and a dry run are query parameters", async () => {
    const layer = cluster({}, (req) => (req.method === "DELETE" ? { body: {} } : undefined));
    const c = await client(layer);
    await c.delete(
      { apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: "prod" },
      { propagationPolicy: "Foreground", dryRun: true },
    );
    const deleted = layer.requests.find((r) => r.method === "DELETE")!;
    expect(deleted.query).toMatchObject({ propagationPolicy: "Foreground", dryRun: "All" });
  });

  test("a 404 surfaces as a typed notFound rather than being swallowed", async () => {
    const layer = cluster();
    const c = await client(layer);
    const err = (await c
      .delete({ apiVersion: "apps/v1", kind: "Deployment", name: "gone", namespace: "prod" })
      .catch((e: unknown) => e)) as K8sApiError;
    expect(err).toBeInstanceOf(K8sApiError);
    expect(err.notFound).toBe(true);
  });
});

describe("apply", () => {
  test("server-side applies with chant as the field manager", async () => {
    const layer = cluster({}, (req) =>
      req.path === "/apis/apps/v1/namespaces/prod/deployments/web" && req.method === "PATCH"
        ? { body: deployment("web") }
        : undefined,
    );
    const c = await client(layer);
    await c.apply(deployment("web") as never);

    const patch = layer.requests.find((r) => r.method === "PATCH")!;
    expect(patch.path).toBe("/apis/apps/v1/namespaces/prod/deployments/web");
    expect(patch.headers["Content-Type"]).toBe("application/apply-patch+yaml");
    expect(patch.query).toMatchObject({ fieldManager: "chant", force: "false" });
    expect(JSON.parse(String(patch.body)).metadata.name).toBe("web");
  });

  test("force and dryRun are query parameters, not a different code path", async () => {
    const layer = cluster({}, (req) => (req.method === "PATCH" ? { body: deployment("web") } : undefined));
    const c = await client(layer);
    await c.apply(deployment("web") as never, { force: true, dryRun: true, fieldManager: "chant-op" });
    const patch = layer.requests.find((r) => r.method === "PATCH")!;
    expect(patch.query).toMatchObject({ fieldManager: "chant-op", force: "true", dryRun: "All" });
  });

  test("a field-ownership conflict arrives as a typed 409", async () => {
    const layer = cluster({}, (req) =>
      req.method === "PATCH"
        ? { status: 409, body: statusBody(409, "Conflict", 'Apply failed with 1 conflict: conflict with "kubectl"') }
        : undefined,
    );
    const c = await client(layer);
    const err = (await c.apply(deployment("web") as never).catch((e: unknown) => e)) as K8sApiError;
    expect(err.conflict).toBe(true);
    expect(err.apiMessage).toContain("conflict with");
  });

  test("that 409 is presented, naming the owner and the contested paths (chant #1075)", async () => {
    const conflict = {
      ...statusBody(409, "Conflict", 'Apply failed with 1 conflict: conflict with "helm" using apps/v1'),
      details: {
        causes: [
          { type: "FieldManagerConflict", message: 'conflict with "helm" using apps/v1', field: ".spec.replicas" },
        ],
      },
    };
    const layer = cluster({}, (req) => (req.method === "PATCH" ? { status: 409, body: conflict } : undefined));
    const c = await client(layer);
    const err = (await c
      .apply(deployment("web") as never, { fieldManager: "chant:web" })
      .catch((e: unknown) => e)) as FieldManagerConflictError;

    expect(err).toBeInstanceOf(FieldManagerConflictError);
    expect(err.byManager).toEqual({ helm: [".spec.replicas"] });
    expect(err.fieldManager).toBe("chant:web");
    expect(err.message).toContain("apps/v1 Deployment prod/web");
    expect(err.message).toContain("chant does not force this for you");
  });

  test("a field manager the API server would reject is refused before any request", async () => {
    const layer = cluster();
    const c = await client(layer);
    await expect(c.apply(deployment("web") as never, { fieldManager: "chant web" })).rejects.toThrow(
      FieldManagerError,
    );
    expect(layer.requests).toHaveLength(0);
  });

  test("an object missing apiVersion/kind/name is refused before any request", async () => {
    const layer = cluster();
    const c = await client(layer);
    await expect(c.apply({ kind: "Deployment", metadata: { name: "x" } })).rejects.toThrow(KubeConfigError);
    await expect(c.apply({ apiVersion: "apps/v1", kind: "Deployment", metadata: {} })).rejects.toThrow(KubeConfigError);
    expect(layer.requests).toHaveLength(0);
  });
});
