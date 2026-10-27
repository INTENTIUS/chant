/**
 * behold#1029: the Kubernetes lister against a fake API server: discovery
 * (`/api/v1`, `/apis`, `/apis/<g>/<v>`), then LIST per served kind.
 */
import { describe, expect, it } from "vitest";
import { listCloud } from "./index";
import { kubeTargetFromKubeconfig } from "./kubernetes";
import { ListerConfigError } from "./credentials";
import { MASKED } from "./mask";
import { fakeFetcher, json, refusingChains, steppingClock } from "./fakes";
import type { WireCall } from "./guard";

const SERVER = "https://127.0.0.1:6443";

function cluster(call: WireCall) {
  const url = new URL(call.url);
  switch (url.pathname) {
    case "/api/v1":
      return json(200, {
        resources: [
          { name: "secrets", kind: "Secret", namespaced: true, verbs: ["get", "list", "create", "delete"] },
          { name: "namespaces", kind: "Namespace", namespaced: false, verbs: ["get", "list"] },
          { name: "pods", kind: "Pod", namespaced: true, verbs: ["get", "list"] },
          { name: "pods/log", kind: "Pod", namespaced: true, verbs: ["get"] },
          { name: "events", kind: "Event", namespaced: true, verbs: ["list"] },
          { name: "bindings", kind: "Binding", namespaced: true, verbs: ["create"] },
        ],
      });
    case "/apis":
      return json(200, { groups: [{ name: "apps", preferredVersion: { groupVersion: "apps/v1", version: "v1" }, versions: [{ groupVersion: "apps/v1", version: "v1" }] }] });
    case "/apis/apps/v1":
      return json(200, { resources: [{ name: "deployments", kind: "Deployment", namespaced: true, verbs: ["get", "list", "patch"] }] });
    case "/api/v1/secrets":
      return json(200, {
        items: [
          {
            metadata: {
              name: "db",
              namespace: "app",
              uid: "uid-secret",
              labels: { "app.kubernetes.io/managed-by": "chant", "chant.intentius.io/stack": "app" },
              annotations: { "kubectl.kubernetes.io/last-applied-configuration": '{"data":{"password":"aHVudGVyMg=="}}' },
              managedFields: [{ manager: "kubectl" }],
            },
            type: "Opaque",
            data: { password: "aHVudGVyMg==", user: "YWRtaW4=" },
          },
        ],
      });
    case "/api/v1/namespaces":
      return json(200, { items: [{ metadata: { name: "app", uid: "uid-ns" } }] });
    case "/api/v1/pods":
      if (!url.searchParams.get("continue")) {
        return json(200, { items: [{ metadata: { name: "web-1", namespace: "app", uid: "uid-p1" } }], metadata: { continue: "c2" } });
      }
      return json(200, { items: [{ metadata: { name: "other", namespace: "kube-system", uid: "uid-p2" } }] });
    case "/apis/apps/v1/deployments":
      return json(403, { kind: "Status", reason: "Forbidden", message: 'deployments.apps is forbidden: User "reader" cannot list resource "deployments"' });
  }
  return undefined;
}

describe("listing kubernetes", () => {
  it("discovers, lists, pages and masks", async () => {
    const fake = fakeFetcher(cluster);
    const result = await listCloud(
      { substrate: "kubernetes", scopeId: "kind-floci", types: "*", locations: "*" },
      { substrate: "kubernetes", kubernetes: { server: SERVER, token: "static" } },
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [] },
    );
    const paths = fake.calls.map((c) => new URL(c.url).pathname);
    expect(paths).not.toContain("/api/v1/events");
    expect(paths).not.toContain("/api/v1/bindings");
    expect(paths.filter((p) => p === "/api/v1/pods")).toHaveLength(2);
    expect(fake.calls.every((c) => c.method === "GET" && c.headers.authorization === "Bearer static")).toBe(true);

    const secret = result.resources.find((r) => r.listedType === "v1/Secret")!;
    expect(secret.id).toBe("kubernetes/kind-floci/app/v1%2FSecret/app/db");
    expect(secret.nativeId).toBe("app/db");
    expect(secret.cloudIds).toEqual([{ kind: "k8s-uid", value: "uid-secret" }]);
    expect(secret.properties.data).toEqual({ password: MASKED, user: MASKED });
    expect(JSON.stringify(secret)).not.toContain("aHVudGVyMg==");
    expect(JSON.stringify(secret)).not.toContain("YWRtaW4=");
    expect((secret.properties.metadata as Record<string, unknown>).managedFields).toBeUndefined();
    expect(secret.facts.markers).toEqual({ owner: "app", encoding: "plain", source: "live" });

    const ns = result.resources.find((r) => r.listedType === "v1/Namespace")!;
    expect(ns.location).toBe("cluster");
    expect(ns.nativeId).toBe("app");

    expect(result.resources.filter((r) => r.listedType === "v1/Pod").map((r) => r.nativeId)).toEqual(["app/web-1", "kube-system/other"]);

    expect(result.coverage).toEqual([
      { listedType: "apps/v1/Deployment", location: "*", verdict: "no-credentials", detail: expect.stringContaining("Forbidden") },
      { listedType: "v1/Namespace", location: "cluster", verdict: "listed" },
      { listedType: "v1/Pod", location: "*", verdict: "listed" },
      { listedType: "v1/Secret", location: "*", verdict: "listed" },
    ]);
    expect(result.notes.map((n) => n.code).sort()).toEqual(["default-types", "no-credentials"]);
  });

  it("keeps to the named namespaces and types, and notes a type the cluster cannot list", async () => {
    const fake = fakeFetcher(cluster);
    const result = await listCloud(
      { substrate: "kubernetes", scopeId: "kind-floci", types: ["v1/Pod", "example.com/v1/Widget"], locations: ["app"], tagFilter: { tier: "web" } },
      { substrate: "kubernetes", kubernetes: { server: SERVER, token: "static" } },
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [] },
    );
    const podList = fake.calls.find((c) => new URL(c.url).pathname === "/api/v1/pods")!;
    expect(new URL(podList.url).searchParams.get("labelSelector")).toBe("tier=web");
    expect(result.resources.map((r) => r.nativeId)).toEqual(["app/web-1"]);
    expect(result.coverage).toEqual([
      { listedType: "example.com/v1/Widget", location: "*", verdict: "unsupported-kind", detail: expect.any(String) },
      { listedType: "v1/Pod", location: "app", verdict: "filtered", detail: 'tag filter {"tier":"web"}' },
    ]);
    expect(result.notes.find((n) => n.code === "no-lister")?.listedType).toBe("example.com/v1/Widget");
  });
});

describe("kubeTargetFromKubeconfig", () => {
  const base = (user: string) => `apiVersion: v1
kind: Config
current-context: kind-floci
clusters:
- name: kind-floci
  cluster:
    server: https://127.0.0.1:6443
    certificate-authority-data: ${Buffer.from("CA PEM").toString("base64")}
contexts:
- name: kind-floci
  context:
    cluster: kind-floci
    user: reader
users:
- name: reader
  user:
${user}
`;

  it("reads a static token and the cluster CA", () => {
    const t = kubeTargetFromKubeconfig(base("    token: abc"));
    expect(t.server).toBe("https://127.0.0.1:6443");
    expect(t.token).toBe("abc");
    expect(t.tls?.ca).toBe("CA PEM");
    expect(t.clusterName).toBe("kind-floci");
  });

  it("reads a client certificate and key", () => {
    const t = kubeTargetFromKubeconfig(
      base(`    client-certificate-data: ${Buffer.from("CERT").toString("base64")}\n    client-key-data: ${Buffer.from("KEY").toString("base64")}`),
    );
    expect(t.tls?.cert).toBe("CERT");
    expect(t.tls?.key).toBe("KEY");
    expect(t.token).toBeUndefined();
  });

  it("refuses an exec plugin", () => {
    expect(() => kubeTargetFromKubeconfig(base("    exec:\n      apiVersion: client.authentication.k8s.io/v1\n      command: aws"))).toThrow(ListerConfigError);
  });
});
