/**
 * chant#5252: applications inferred from a live Kubernetes read. Each fixture
 * is served by a fake API server, listed by the real lister (so the masking
 * is the live read's) and typed as `indexCloud` types it.
 */
import { describe, expect, it } from "vitest";
import { listCloud } from "./index";
import { inferK8sComponents, serviceNamesIn } from "./kubernetes-components";
import { fakeFetcher, json, steppingClock } from "./fakes";
import type { WireCall } from "./guard";
import { typeListing } from "../lifecycle/type-listing";

type Obj = Record<string, unknown> & { kind: string; metadata: Record<string, unknown> };

const KINDS: Record<string, { group: string; version: string; plural: string }> = {
  Pod: { group: "", version: "v1", plural: "pods" },
  Service: { group: "", version: "v1", plural: "services" },
  Endpoints: { group: "", version: "v1", plural: "endpoints" },
  ConfigMap: { group: "", version: "v1", plural: "configmaps" },
  Secret: { group: "", version: "v1", plural: "secrets" },
  ServiceAccount: { group: "", version: "v1", plural: "serviceaccounts" },
  Deployment: { group: "apps", version: "v1", plural: "deployments" },
  ReplicaSet: { group: "apps", version: "v1", plural: "replicasets" },
  StatefulSet: { group: "apps", version: "v1", plural: "statefulsets" },
  EndpointSlice: { group: "discovery.k8s.io", version: "v1", plural: "endpointslices" },
  Job: { group: "batch", version: "v1", plural: "jobs" },
  CronJob: { group: "batch", version: "v1", plural: "cronjobs" },
  DaemonSet: { group: "apps", version: "v1", plural: "daemonsets" },
  Ingress: { group: "networking.k8s.io", version: "v1", plural: "ingresses" },
};

/** A fake API server that serves `objects` through discovery and LIST. */
function cluster(objects: Obj[]) {
  return (call: WireCall) => {
    const path = new URL(call.url).pathname;
    const resources = (group: string, version: string) =>
      Object.entries(KINDS)
        .filter(([, k]) => k.group === group && k.version === version)
        .map(([kind, k]) => ({ name: k.plural, kind, namespaced: true, verbs: ["get", "list"] }));
    if (path === "/api/v1") return json(200, { resources: resources("", "v1") });
    if (path === "/apis") {
      const groups = [...new Set(Object.values(KINDS).map((k) => k.group).filter(Boolean))];
      return json(200, { groups: groups.map((name) => ({ name, preferredVersion: { version: "v1" }, versions: [{ version: "v1" }] })) });
    }
    const m = /^\/apis\/([^/]+)\/v1$/.exec(path);
    if (m) return json(200, { resources: resources(m[1], "v1") });
    for (const [kind, k] of Object.entries(KINDS)) {
      const listPath = k.group === "" ? `/api/v1/${k.plural}` : `/apis/${k.group}/v1/${k.plural}`;
      if (path === listPath) return json(200, { items: objects.filter((o) => o.kind === kind) });
    }
    return undefined;
  };
}

async function infer(objects: Obj[]) {
  const { fetcher } = fakeFetcher(cluster(objects));
  const listing = await listCloud(
    { substrate: "kubernetes", scopeId: "scratch", locations: "*", types: "*" },
    { substrate: "kubernetes", kubernetes: { server: "https://127.0.0.1:6443", token: "t" } },
    { fetcher, now: steppingClock(), retryDelays: [] },
  );
  const doc = typeListing(listing, []);
  const ids = new Map(doc.graph.nodes.map((n) => [n.id, `${n.location}/${(n.listedType ?? "").split("/").pop()}/${(n.nativeId ?? "").split("/").pop()}`]));
  const result = inferK8sComponents(doc.graph);
  const short = (id: string) => ids.get(id) ?? id;
  return { result, short };
}

let uidSeq = 0;
const meta = (name: string, extra: Record<string, unknown> = {}) => ({ name, namespace: "shop", uid: `uid-${name}-${++uidSeq}`, ...extra });

/** A Deployment with one ReplicaSet and one Pod, as a cluster holds it. */
function deployment(
  name: string,
  opts: { labels?: Record<string, string>; annotations?: Record<string, string>; ns?: string; podSpec?: Record<string, unknown>; status?: { ready: number; replicas: number; restarts: number } } = {},
): Obj[] {
  const ns = opts.ns ?? "shop";
  const podSpec: Record<string, unknown> = { containers: [{ name, image: `${name}:1` }], ...(opts.podSpec ?? {}) };
  const d = { apiVersion: "apps/v1", kind: "Deployment", metadata: meta(name, { namespace: ns, labels: opts.labels ?? {}, annotations: opts.annotations ?? {} }), spec: { selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: podSpec } } } as Obj;
  const owner = (o: Obj) => [{ apiVersion: "apps/v1", kind: o.kind, name: o.metadata.name, uid: o.metadata.uid, controller: true }];
  const rs = { kind: "ReplicaSet", metadata: meta(`${name}-7d9f`, { namespace: ns, ownerReferences: owner(d), labels: { app: name, "pod-template-hash": "7d9f" } }), spec: { template: { metadata: { labels: { app: name } }, spec: podSpec } } } as Obj;
  const pod = {
    kind: "Pod",
    metadata: meta(`${name}-7d9f-x2k4p`, { namespace: ns, ownerReferences: owner(rs), labels: { app: name } }),
    spec: {
      ...podSpec,
      serviceAccountName: "default",
      volumes: [...((podSpec.volumes as unknown[]) ?? []), { name: "kube-api-access-abcde", projected: { sources: [{ serviceAccountToken: { path: "token" } }, { configMap: { name: "kube-root-ca.crt" } }] } }],
    },
  } as Obj;
  if (opts.status) {
    (d.spec as Record<string, unknown>).replicas = opts.status.replicas;
    d.status = { replicas: opts.status.replicas, readyReplicas: opts.status.ready };
    pod.status = { phase: "Running", containerStatuses: [{ name, restartCount: opts.status.restarts }], conditions: [{ type: "Ready", status: opts.status.ready > 0 ? "True" : "False" }] };
  }
  return [d, rs, pod];
}

function service(name: string, ns = "shop"): Obj[] {
  return [
    { kind: "Service", metadata: meta(name, { namespace: ns }), spec: { selector: { app: name }, ports: [{ port: 8080 }] } },
    { kind: "Endpoints", metadata: meta(name, { namespace: ns }), subsets: [] },
    { kind: "EndpointSlice", metadata: meta(`${name}-abcde`, { namespace: ns, labels: { "kubernetes.io/service-name": name } }), endpoints: [] },
  ];
}

const configMap = (name: string, data: Record<string, string>, ns = "shop"): Obj => ({ kind: "ConfigMap", metadata: meta(name, { namespace: ns }), data });
const namespaceObjects = (ns = "shop"): Obj[] => [
  { kind: "ServiceAccount", metadata: meta("default", { namespace: ns }) },
  configMap("kube-root-ca.crt", { "ca.crt": "-----BEGIN CERTIFICATE-----" }, ns),
];

describe("two workloads, one naming the other's Service", () => {
  const objects: Obj[] = [
    ...deployment("checkout", { podSpec: { containers: [{ name: "checkout", image: "checkout:1", envFrom: [{ configMapRef: { name: "checkout-config" } }] }] } }),
    ...service("checkout"),
    configMap("checkout-config", { PAYMENTS_URL: "http://payments.shop.svc:8080/charge", LOG_LEVEL: "info" }),
    ...deployment("payments", {
      podSpec: {
        containers: [{ name: "payments", image: "payments:1", env: [{ name: "MODE", value: "live" }] }],
        volumes: [{ name: "config", configMap: { name: "payments-config" } }, { name: "db", secret: { secretName: "payments-db" } }],
      },
    }),
    ...service("payments"),
    configMap("payments-config", { CURRENCY: "EUR" }),
    { kind: "Secret", metadata: meta("payments-db"), data: { password: "aHVudGVyMg==" } },
    ...namespaceObjects(),
  ];

  it("yields two applications, checkout depending on payments", async () => {
    const { result } = await infer(objects);
    expect(result.ir.nodes.map((n) => [n.id, n.kind, n.lexicon, n.attrs.wave])).toEqual([
      ["payments", "Component", "chant", 1],
      ["checkout", "Component", "chant", 2],
    ]);
    expect(result.ir.edges).toEqual([
      { from: "checkout", to: "payments", kind: "ref", origin: "derived", rule: "k8s:service-dns", viaAttr: "ConfigMap checkout-config data.PAYMENTS_URL" },
    ]);
    expect(result.ir.groups.byWave).toEqual({ "wave-1": ["payments"], "wave-2": ["checkout"] });
  });

  it("gives each its own Service and config, with the runtime and bookkeeping objects marked", async () => {
    const { result, short } = await infer(objects);
    const membersOf = (c: string) => (result.ir.nodes.find((n) => n.id === c)!.attrs.members as Array<{ id: string; role: string }>).map((m) => [short(m.id), m.role]);
    expect(membersOf("checkout")).toEqual(
      expect.arrayContaining([
        ["shop/Deployment/checkout", "workload"],
        ["shop/ReplicaSet/checkout-7d9f", "runtime"],
        ["shop/Pod/checkout-7d9f-x2k4p", "runtime"],
        ["shop/Service/checkout", "service"],
        ["shop/Endpoints/checkout", "bookkeeping"],
        ["shop/EndpointSlice/checkout-abcde", "bookkeeping"],
        ["shop/ConfigMap/checkout-config", "config"],
      ]),
    );
    expect(membersOf("checkout")).toHaveLength(7);
    expect(membersOf("payments").map(([id]) => id)).toContain("shop/ConfigMap/payments-config");
    expect(membersOf("payments").map(([id]) => id)).not.toContain("shop/ConfigMap/checkout-config");
    const checkout = result.ir.nodes.find((n) => n.id === "checkout")!;
    expect((checkout.attrs.liveNames as string[]).map(short).sort()).toEqual(membersOf("checkout").map(([id]) => id).sort());
    expect(checkout.attrs.boundary).toEqual({ by: "workload", value: "checkout" });
    expect(checkout.attrs.namespace).toBe("shop");
  });

  it("shares the default ServiceAccount and kube-root-ca.crt, and belongs them to neither", async () => {
    const { result, short } = await infer(objects);
    expect(result.shared.map((s) => [short(s.id), s.role, s.usedBy])).toEqual([
      ["shop/ConfigMap/kube-root-ca.crt", "bookkeeping", ["checkout", "payments"]],
      ["shop/ServiceAccount/default", "bookkeeping", ["checkout", "payments"]],
    ]);
    for (const n of result.ir.nodes) expect((n.attrs.liveNames as string[]).map(short)).not.toContain("shop/ServiceAccount/default");
  });

  it("takes in a mounted Secret, whose name the live read keeps", async () => {
    const { result, short } = await infer(objects);
    const payments = result.ir.nodes.find((n) => n.id === "payments")!;
    expect((payments.attrs.members as Array<{ id: string; role: string }>).map((m) => [short(m.id), m.role])).toContainEqual(["shop/Secret/payments-db", "config"]);
    expect(result.notes).toEqual([]);
  });

  it("notes a Secret reference that still reads as masked, and leaves it out", () => {
    const node = (kind: string, name: string, attrs: Record<string, unknown>) => ({ id: `k/${kind}/${name}`, kind, lexicon: "kubernetes", listedType: kind === "Deployment" ? "apps/v1/Deployment" : `v1/${kind}`, location: "shop", nativeId: `shop/${name}`, attrs: { metadata: { name, namespace: "shop" }, ...attrs } });
    const result = inferK8sComponents({
      nodes: [
        node("Deployment", "old", { spec: { template: { metadata: { labels: { app: "old" } }, spec: { containers: [{ name: "c" }], volumes: [{ name: "db", secret: "<masked>" }] } } } }),
        node("Secret", "db", {}),
      ],
    });
    expect(result.ir.nodes[0].attrs.liveNames).toEqual(["k/Deployment/old"]);
    expect(result.notes).toEqual(["old: 1 Secret reference is masked by the live read, so that Secret is not taken in"]);
  });
});

describe("labels that set the boundary", () => {
  it("merges workloads with one app.kubernetes.io/part-of into one application", async () => {
    const partOf = { "app.kubernetes.io/part-of": "storefront" };
    const { result, short } = await infer([...deployment("web", { labels: partOf }), ...service("web"), ...deployment("api", { labels: partOf }), ...service("api"), ...deployment("audit"), ...namespaceObjects()]);
    expect(result.ir.nodes.map((n) => n.id).sort()).toEqual(["audit", "storefront"]);
    const storefront = result.ir.nodes.find((n) => n.id === "storefront")!;
    expect(storefront.attrs.boundary).toEqual({ by: "part-of", value: "storefront" });
    const workloads = (storefront.attrs.members as Array<{ id: string; role: string }>).filter((m) => m.role === "workload").map((m) => short(m.id));
    expect(workloads).toEqual(["shop/Deployment/api", "shop/Deployment/web"]);
    // Objects both of its workloads use are its own, not shared.
    expect((storefront.attrs.liveNames as string[]).map(short)).toContain("shop/Service/api");
    expect(result.shared.find((s) => short(s.id) === "shop/ServiceAccount/default")!.usedBy).toEqual(["audit", "storefront"]);
  });

  it("comes out as the Helm release, holding the release's Deployment and StatefulSet", async () => {
    const helm = { annotations: { "meta.helm.sh/release-name": "cache", "meta.helm.sh/release-namespace": "shop" }, labels: { "app.kubernetes.io/managed-by": "Helm", "app.kubernetes.io/instance": "cache" } };
    const sts: Obj = {
      kind: "StatefulSet",
      metadata: meta("cache-redis", { labels: helm.labels, annotations: helm.annotations }),
      spec: { serviceName: "cache-redis", selector: { matchLabels: { app: "cache-redis" } }, template: { metadata: { labels: { app: "cache-redis" } }, spec: { containers: [{ name: "redis", image: "redis:7" }] } } },
    };
    const { result, short } = await infer([...deployment("cache-metrics", helm), sts, ...service("cache-redis"), ...namespaceObjects()]);
    expect(result.ir.nodes.map((n) => [n.id, n.attrs.boundary])).toEqual([["cache", { by: "helm", value: "cache" }]]);
    const live = (result.ir.nodes[0].attrs.liveNames as string[]).map(short);
    expect(live).toEqual(expect.arrayContaining(["shop/Deployment/cache-metrics", "shop/StatefulSet/cache-redis", "shop/Service/cache-redis"]));
  });

  it("joins one Argo CD instance across the namespaces it deploys into, named by the instance", async () => {
    const argo = { labels: { "argocd.argoproj.io/instance": "shop-app" } };
    const { result, short } = await infer([
      ...deployment("web", { ...argo, ns: "front" }),
      ...deployment("api", { ...argo, ns: "back" }),
      ...deployment("api", { ns: "other" }),
      ...service("api", "back"),
      ...namespaceObjects("front"),
      ...namespaceObjects("back"),
      ...namespaceObjects("other"),
    ]);
    expect(result.ir.nodes.map((n) => n.id).sort()).toEqual(["api", "shop-app"]);
    const app = result.ir.nodes.find((n) => n.id === "shop-app")!;
    expect(app.attrs.boundary).toEqual({ by: "argocd", value: "shop-app" });
    expect(app.attrs.namespaces).toEqual(["back", "front"]);
    expect(app.attrs.namespace).toBeUndefined();
    const workloads = (app.attrs.members as Array<{ id: string; role: string }>).filter((m) => m.role === "workload").map((m) => short(m.id));
    expect(workloads).toEqual(["back/Deployment/api", "front/Deployment/web"]);
    // Each namespace's default ServiceAccount is its own, not shared across namespaces.
    expect((app.attrs.liveNames as string[]).map(short)).toEqual(expect.arrayContaining(["back/ServiceAccount/default", "front/ServiceAccount/default"]));
  });

  it("keeps the Argo CD instance's plain name and qualifies another namespace's workload of that name", async () => {
    const { result } = await infer([
      ...deployment("a", { labels: { "argocd.argoproj.io/instance": "web" }, ns: "x" }),
      ...deployment("b", { labels: { "argocd.argoproj.io/instance": "web" }, ns: "y" }),
      ...deployment("web", { ns: "z" }),
    ]);
    expect(result.ir.nodes.map((n) => n.id).sort()).toEqual(["web", "z/web"]);
  });

  it("comes out as the Argo CD application, which wins over a chart's release annotation", async () => {
    const argo = { labels: { "argocd.argoproj.io/instance": "guestbook" }, annotations: { "meta.helm.sh/release-name": "guestbook-ui" } };
    const { result } = await infer([...deployment("guestbook-ui", argo), ...deployment("guestbook-redis", { labels: { "argocd.argoproj.io/instance": "guestbook" } }), ...namespaceObjects()]);
    expect(result.ir.nodes.map((n) => [n.id, n.attrs.boundary])).toEqual([["guestbook", { by: "argocd", value: "guestbook" }]]);
    expect(result.shared).toEqual([]);
  });

  it("recognises a workload a chant k8s composite made by its name", async () => {
    const chant = { labels: { "app.kubernetes.io/managed-by": "chant", "app.kubernetes.io/name": "orders" } };
    const { result } = await infer([...deployment("orders-web", chant), ...deployment("orders-worker", chant), ...namespaceObjects()]);
    expect(result.ir.nodes.map((n) => [n.id, n.attrs.boundary])).toEqual([["orders", { by: "chant", value: "orders" }]]);
  });

  it("qualifies a name two namespaces give, and joins a dependsOn across namespaces", async () => {
    const { result } = await infer([
      ...deployment("web", { ns: "shop", podSpec: { containers: [{ name: "web", image: "web:1", env: [{ name: "API", value: "api.backend.svc.cluster.local:9000" }] }] } }),
      ...deployment("web", { ns: "backend" }),
      ...deployment("api", { ns: "backend" }),
      ...service("api", "backend"),
      ...namespaceObjects("shop"),
      ...namespaceObjects("backend"),
    ]);
    expect(result.ir.nodes.map((n) => n.id).sort()).toEqual(["api", "backend/web", "shop/web"]);
    expect(result.ir.edges.map((e) => [e.from, e.to, e.viaAttr])).toEqual([["shop/web", "api", "Deployment web env API"]]);
  });
});

describe("a Service shared by two applications", () => {
  it("is shared, and an Ingress that reaches it is shared too", async () => {
    const ingress: Obj = { kind: "Ingress", metadata: meta("front"), spec: { rules: [{ http: { paths: [{ path: "/", backend: { service: { name: "front", port: { number: 80 } } } }] } }] } };
    const front: Obj = { kind: "Service", metadata: meta("front"), spec: { selector: { tier: "front" } } };
    const withTier = (name: string) => {
      const objs = deployment(name);
      ((objs[0].spec as { template: { metadata: { labels: Record<string, string> } } }).template.metadata.labels).tier = "front";
      return objs;
    };
    const { result, short } = await infer([...withTier("blue"), ...withTier("green"), front, ingress, ...namespaceObjects()]);
    expect(result.shared.map((s) => [short(s.id), s.role, s.usedBy])).toEqual(
      expect.arrayContaining([
        ["shop/Service/front", "service", ["blue", "green"]],
        ["shop/Ingress/front", "route", ["blue", "green"]],
      ]),
    );
  });
});

describe("serviceNamesIn", () => {
  it("reads cluster DNS names and a bare name that is the whole value or a URL's host", () => {
    expect(serviceNamesIn("http://payments.shop.svc:8080/x", "shop")).toEqual([["shop", "payments"]]);
    expect(serviceNamesIn("payments.shop.svc.cluster.local", "web")).toEqual([["shop", "payments"]]);
    expect(serviceNamesIn("a.b.svc,c.d.svc.cluster.local:1", "x")).toEqual([["b", "a"], ["d", "c"]]);
    expect(serviceNamesIn("payments", "shop")).toEqual([["shop", "payments"]]);
    expect(serviceNamesIn("redis://cache:6379/0", "shop")).toEqual([["shop", "cache"]]);
  });

  it("does not read a name in a sentence or under another domain", () => {
    expect(serviceNamesIn("pay with payments today", "shop")).toEqual([]);
    expect(serviceNamesIn("payments.shop.svc.example.com", "shop")).toEqual([]);
    expect(serviceNamesIn("https://api.example.com", "shop")).toEqual([]);
  });
});

describe("seeds without a workload owner", () => {
  const podSpec = { containers: [{ name: "c", image: "busybox" }] };
  it("seeds an ownerless Job, ReplicaSet and Pod, and not a Job its CronJob owns", async () => {
    const cron: Obj = { kind: "CronJob", metadata: meta("nightly"), spec: { schedule: "0 1 * * *", jobTemplate: { spec: { template: { metadata: { labels: { app: "nightly" } }, spec: podSpec } } } } };
    const owned: Obj = { kind: "Job", metadata: meta("nightly-2911", { ownerReferences: [{ kind: "CronJob", name: "nightly", uid: cron.metadata.uid, controller: true }] }), spec: { template: { metadata: { labels: { app: "nightly" } }, spec: podSpec } } };
    const job: Obj = { kind: "Job", metadata: meta("migrate"), spec: { template: { metadata: { labels: { app: "migrate" } }, spec: podSpec } } };
    const rs: Obj = { kind: "ReplicaSet", metadata: meta("legacy"), spec: { template: { metadata: { labels: { app: "legacy" } }, spec: podSpec } } };
    const pod: Obj = { kind: "Pod", metadata: meta("debug", { labels: { app: "debug" } }), spec: podSpec };
    const { result, short } = await infer([cron, owned, job, rs, pod, ...namespaceObjects()]);
    expect(result.ir.nodes.map((n) => n.id).sort()).toEqual(["debug", "legacy", "migrate", "nightly"]);
    const role = (c: string) => (result.ir.nodes.find((n) => n.id === c)!.attrs.members as Array<{ id: string; role: string }>).map((m) => [short(m.id), m.role]);
    expect(role("migrate")).toContainEqual(["shop/Job/migrate", "workload"]);
    expect(role("legacy")).toContainEqual(["shop/ReplicaSet/legacy", "workload"]);
    expect(role("debug")).toContainEqual(["shop/Pod/debug", "workload"]);
    expect(role("nightly")).toEqual(expect.arrayContaining([["shop/CronJob/nightly", "workload"], ["shop/Job/nightly-2911", "runtime"]]));
  });
});

describe("health on each application", () => {
  it("sums ready over desired replicas and the restarts of every Pod", async () => {
    const partOf = { "app.kubernetes.io/part-of": "shop" };
    const { result } = await infer([
      ...deployment("web", { labels: partOf, status: { ready: 1, replicas: 1, restarts: 2 } }),
      ...deployment("api", { labels: partOf, status: { ready: 0, replicas: 1, restarts: 5 } }),
      ...deployment("quiet"),
    ]);
    expect(result.ir.nodes.find((n) => n.id === "shop")!.attrs.status).toEqual({ readyReplicas: 1, desiredReplicas: 2, restarts: 7 });
    expect(result.ir.nodes.find((n) => n.id === "quiet")!.attrs.status).toBeUndefined();
  });

  it("counts a bare Pod as one replica, and a DaemonSet by its scheduled pods", async () => {
    const pod: Obj = { kind: "Pod", metadata: meta("debug", { labels: { app: "debug" } }), spec: { containers: [{ name: "c" }] }, status: { phase: "Running", containerStatuses: [{ restartCount: 3 }], conditions: [{ type: "Ready", status: "True" }] } };
    const ds: Obj = { kind: "DaemonSet", metadata: meta("agent"), spec: { selector: { matchLabels: { app: "agent" } }, template: { metadata: { labels: { app: "agent" } }, spec: { containers: [{ name: "a" }] } } }, status: { desiredNumberScheduled: 3, numberReady: 2 } };
    const { result } = await infer([pod, ds]);
    expect(result.ir.nodes.find((n) => n.id === "debug")!.attrs.status).toEqual({ readyReplicas: 1, desiredReplicas: 1, restarts: 3 });
    expect(result.ir.nodes.find((n) => n.id === "agent")!.attrs.status).toEqual({ readyReplicas: 2, desiredReplicas: 3, restarts: 0 });
  });
});
