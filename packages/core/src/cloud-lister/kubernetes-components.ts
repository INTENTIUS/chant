/**
 * chant#5252: the applications in a live Kubernetes read, inferred from the
 * objects and drawn as chant components.
 *
 * A cluster read (`listCloud` through `indexCloud`, ../lifecycle/cloud-index.ts)
 * gives every object and the references between them, and nothing declares
 * an application. {@link inferK8sComponents} draws one from each top-level
 * workload and what it reaches, and writes them in the shape `chant graph
 * --components --format ir` writes (../cli/handlers/graph.ts): one
 * `Component` node per application with `attrs.wave` and `attrs.liveNames`,
 * a `dependsOn` edge from consumer to producer, and `groups.byWave`. A reader
 * of the declared component graph reads this one with no new code.
 *
 * Seeds. A workload (Deployment, StatefulSet, DaemonSet, CronJob, Job,
 * ReplicaSet, Pod) that no other workload controls. Owner references are
 * followed by uid, and by kind and name in the namespace when the uid is not
 * in the read.
 *
 * Boundaries. The first of these on a seed's own labels and annotations
 * names its unit, and seeds of one namespace with the same unit are one
 * application: `app.kubernetes.io/part-of`, `argocd.argoproj.io/instance`,
 * the `meta.helm.sh/release-name` annotation, `app.kubernetes.io/instance`,
 * and `app.kubernetes.io/name` on an object a k8s composite made
 * (`app.kubernetes.io/managed-by: chant`). A seed with none stands alone.
 *
 * Membership. An application takes in its seeds' runtime children, the
 * Services that select their pods (with those Services' Endpoints and
 * EndpointSlices), the Ingresses and HTTPRoutes that reach those Services,
 * the autoscalers, disruption budgets and network policies that target them,
 * and the ConfigMaps, Secrets, claims and ServiceAccount the pod template
 * and the running Pods name, with any ExternalSecret that writes one of those
 * Secrets. An object two or more applications take in is shared: it is in no
 * application's members, and {@link InferredK8sComponents.shared} lists it.
 *
 * dependsOn. An env value in a seed's pod template, or a value in a
 * ConfigMap the application uses, that names another application's Service
 * by its cluster DNS name (`svc.ns.svc`, `svc.ns.svc.cluster.local`), or by
 * its bare name inside the reader's namespace when that is the whole value or
 * a URL's host.
 *
 * What a live read cannot show: the lister masks keys matching /secret/i
 * (../sensitive-key.ts), so a Secret named only in `volumes[].secret` or
 * `secretKeyRef` is not taken in, and a note says so. Pure, and it reads only
 * each node's listed type, location, native id, attributes and uid, so a
 * graph typed without the k8s lexicon gives the same answer.
 */
import { MASKED as TYPED_MASKED } from "../deep-observation";
import type { GraphIR, IREdge, IRNode } from "../graph-ir";
import { NEXT_RELEASE } from "../release-floors";
import { MASKED as LISTED_MASKED } from "./mask";

/** The first chant with `inferK8sComponents`, the applications of a live Kubernetes read as a component graph (#5252). */
export const K8S_COMPONENTS_FLOOR = NEXT_RELEASE;

/** What a member is to its application, so a reader can fold without knowing Kubernetes kinds. */
export type K8sMemberRole = "workload" | "runtime" | "service" | "route" | "policy" | "config" | "storage" | "identity" | "bookkeeping";

export interface K8sComponentMember {
  /** The node id in the read's graph. */
  id: string;
  role: K8sMemberRole;
}

/** A name a member gives for something outside the cluster: a cloud identity or a cloud secret. */
export interface K8sOutsideName {
  /** The node id that names it. */
  from: string;
  /** Where: an annotation key, or `remoteRef.key`. */
  key: string;
  value: string;
}

/** How an application's boundary was drawn. `workload`: no label named a unit, so it is one workload. */
export interface K8sBoundary {
  by: "part-of" | "argocd" | "helm" | "instance" | "chant" | "workload";
  value: string;
}

/** An object two or more applications use. */
export interface K8sSharedObject {
  id: string;
  role: K8sMemberRole;
  /** The applications that use it, sorted. */
  usedBy: string[];
  outside?: K8sOutsideName[];
}

export interface InferredK8sComponents {
  /** The component graph, in `chant graph --components --format ir`'s shape. */
  ir: GraphIR;
  shared: K8sSharedObject[];
  notes: string[];
}

type Rec = Record<string, unknown>;

const WORKLOAD_KINDS: ReadonlySet<string> = new Set(["Deployment", "StatefulSet", "DaemonSet", "CronJob", "Job", "ReplicaSet", "Pod"]);
const WORKLOAD_GROUPS: ReadonlySet<string> = new Set(["", "apps", "batch"]);
const ROLE_OF_KIND: Readonly<Record<string, K8sMemberRole>> = {
  Service: "service",
  Endpoints: "bookkeeping",
  EndpointSlice: "bookkeeping",
  Ingress: "route",
  HTTPRoute: "route",
  HorizontalPodAutoscaler: "policy",
  PodDisruptionBudget: "policy",
  NetworkPolicy: "policy",
  ConfigMap: "config",
  Secret: "config",
  ExternalSecret: "config",
  PersistentVolumeClaim: "storage",
  ServiceAccount: "identity",
};
const OUTSIDE_ANNOTATIONS: readonly string[] = ["eks.amazonaws.com/role-arn", "iam.gke.io/gcp-service-account", "azure.workload.identity/client-id"];
const SERVICE_NAME_LABEL = "kubernetes.io/service-name";
const HELM_RELEASE = "meta.helm.sh/release-name";

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const rec = (v: unknown): Rec => (isRec(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const isMasked = (v: unknown): boolean => v === LISTED_MASKED || v === TYPED_MASKED;
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One listed object, read loosely. */
interface Obj {
  id: string;
  kind: string;
  group: string;
  ns: string;
  name: string;
  attrs: Rec;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  uid?: string;
}

function readObj(n: IRNode): Obj | undefined {
  const type = (n.listedType ?? "").split("/");
  if (type.length < 2) return undefined;
  const kind = type[type.length - 1];
  const group = type.length === 3 ? type[0] : "";
  const attrs = rec(n.attrs);
  const meta = rec(attrs.metadata);
  const native = n.nativeId ?? "";
  const name = str(meta.name) ?? native.split("/").pop() ?? "";
  if (!name) return undefined;
  const ns = n.location && n.location !== "cluster" ? n.location : "";
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...rec(meta.labels), ...(n.tags ?? {}) })) if (typeof v === "string") labels[k] = v;
  const annotations: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec(meta.annotations))) if (typeof v === "string") annotations[k] = v;
  const uid = n.facts?.cloudIds?.find((c) => c.kind === "k8s-uid")?.value ?? str(meta.uid);
  return { id: n.id, kind, group, ns, name, attrs, labels, annotations, ...(uid ? { uid } : {}) };
}

const isWorkload = (o: Pick<Obj, "kind" | "group">) => WORKLOAD_KINDS.has(o.kind) && WORKLOAD_GROUPS.has(o.group);

/** The pod template of a workload (the Pod itself for a Pod): its labels and its pod spec. */
function podTemplate(o: Obj): { labels: Record<string, string>; spec: Rec } | undefined {
  if (o.kind === "Pod") return { labels: o.labels, spec: rec(o.attrs.spec) };
  const spec = rec(o.attrs.spec);
  const template = o.kind === "CronJob" ? rec(rec(rec(spec.jobTemplate).spec).template) : rec(spec.template);
  if (!isRec(spec.template) && !isRec(rec(spec.jobTemplate).spec)) return undefined;
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec(rec(template.metadata).labels))) if (typeof v === "string") labels[k] = v;
  return { labels, spec: rec(template.spec) };
}

/** A label selector (`matchLabels`, `matchExpressions`) against a label set. `plain` is a Service's map selector. */
function selects(selector: unknown, labels: Record<string, string>, opts: { plain?: boolean; emptyMatchesAll?: boolean } = {}): boolean {
  const sel = rec(selector);
  if (opts.plain) {
    const pairs = Object.entries(sel).filter(([, v]) => typeof v === "string");
    return pairs.length > 0 && pairs.every(([k, v]) => labels[k] === v);
  }
  const matchLabels = Object.entries(rec(sel.matchLabels)).filter(([, v]) => typeof v === "string");
  const expressions = arr(sel.matchExpressions).filter(isRec);
  if (matchLabels.length === 0 && expressions.length === 0) return opts.emptyMatchesAll === true;
  if (!matchLabels.every(([k, v]) => labels[k] === v)) return false;
  return expressions.every((e) => {
    const key = str(e.key);
    if (!key) return false;
    const values = arr(e.values).filter((v): v is string => typeof v === "string");
    switch (e.operator) {
      case "In":
        return key in labels && values.includes(labels[key]);
      case "NotIn":
        return !(key in labels) || !values.includes(labels[key]);
      case "Exists":
        return key in labels;
      case "DoesNotExist":
        return !(key in labels);
      default:
        return false;
    }
  });
}

interface PodRefs {
  configMaps: Set<string>;
  secrets: Set<string>;
  claims: Set<string>;
  serviceAccount: string;
  /** Where a reference was masked: a volume, an env entry or `imagePullSecrets`, so a template and its Pods count once. */
  masked: Set<string>;
}

/** The objects a pod spec names, and how many references the read masked. */
function podRefs(spec: Rec, into?: PodRefs): PodRefs {
  const out = into ?? { configMaps: new Set(), secrets: new Set(), claims: new Set(), serviceAccount: "", masked: new Set() };
  const name = (at: string, v: unknown, field = "name"): string | undefined => {
    const n = isMasked(v) ? v : rec(v)[field];
    if (isMasked(n)) {
      out.masked.add(at);
      return undefined;
    }
    return str(n);
  };
  const add = (set: Set<string>, n: string | undefined) => n && set.add(n);
  const sa = str(spec.serviceAccountName) ?? str(spec.serviceAccount);
  if (!out.serviceAccount) out.serviceAccount = sa ?? "default";
  for (const v of arr(spec.volumes).filter(isRec)) {
    const at = `volume ${String(v.name)}`;
    if ("configMap" in v) add(out.configMaps, name(at, v.configMap));
    if ("secret" in v) add(out.secrets, name(at, v.secret, "secretName"));
    if ("persistentVolumeClaim" in v) add(out.claims, name(at, v.persistentVolumeClaim, "claimName"));
    arr(rec(v.projected).sources).filter(isRec).forEach((s, i) => {
      if ("configMap" in s) add(out.configMaps, name(`${at} ${i}`, s.configMap));
      if ("secret" in s) add(out.secrets, name(`${at} ${i}`, s.secret));
    });
  }
  const ips = spec.imagePullSecrets;
  if (isMasked(ips)) out.masked.add("imagePullSecrets");
  arr(ips).forEach((p, i) => add(out.secrets, name(`imagePullSecrets ${i}`, p)));
  for (const c of [...arr(spec.containers), ...arr(spec.initContainers)].filter(isRec)) {
    for (const e of arr(c.env).filter(isRec)) {
      const from = rec(e.valueFrom);
      const at = `env ${String(c.name)} ${String(e.name)}`;
      if ("configMapKeyRef" in from) add(out.configMaps, name(at, from.configMapKeyRef));
      if ("secretKeyRef" in from) add(out.secrets, name(at, from.secretKeyRef));
    }
    arr(c.envFrom).filter(isRec).forEach((e, i) => {
      const at = `envFrom ${String(c.name)} ${i}`;
      if ("configMapRef" in e) add(out.configMaps, name(at, e.configMapRef));
      if ("secretRef" in e) add(out.secrets, name(at, e.secretRef));
    });
  }
  return out;
}

/** `(name, value)` for each plain env value in a pod spec's containers. */
function envValues(spec: Rec): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const c of [...arr(spec.containers), ...arr(spec.initContainers)].filter(isRec)) {
    for (const e of arr(c.env).filter(isRec)) {
      const n = str(e.name);
      const v = e.value;
      if (n && typeof v === "string" && !isMasked(v)) out.push([n, v]);
    }
  }
  return out;
}

const DNS_NAME = /(?:^|[^a-z0-9.-])([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)\.([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)\.svc(?:\.cluster\.local)?(?!\.?[a-z0-9-])/g;
const BARE_NAME = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)(?::\d+)?(?:\/\S*)?$/;

/**
 * The Services a string names: `[namespace, name]` for each cluster DNS name
 * in it, and the bare name in `ns` when the whole string is a name, a
 * `name:port` or a URL whose host is the name. Exported for tests.
 */
export function serviceNamesIn(value: string, ns: string): Array<[string, string]> {
  const v = value.trim().toLowerCase();
  const out: Array<[string, string]> = [];
  for (const m of v.matchAll(DNS_NAME)) out.push([m[2], m[1]]);
  if (out.length === 0) {
    const bare = BARE_NAME.exec(v);
    if (bare) out.push([ns, bare[1]]);
  }
  return out;
}

interface Unit {
  key: string;
  ns: string;
  boundary: K8sBoundary;
  seeds: Obj[];
  name: string;
}

function unitOf(o: Obj): K8sBoundary {
  const l = o.labels;
  if (l["app.kubernetes.io/part-of"]) return { by: "part-of", value: l["app.kubernetes.io/part-of"] };
  if (l["argocd.argoproj.io/instance"]) return { by: "argocd", value: l["argocd.argoproj.io/instance"] };
  if (o.annotations[HELM_RELEASE]) return { by: "helm", value: o.annotations[HELM_RELEASE] };
  if (l["app.kubernetes.io/instance"]) return { by: "instance", value: l["app.kubernetes.io/instance"] };
  if (l["app.kubernetes.io/managed-by"] === "chant" && l["app.kubernetes.io/name"]) return { by: "chant", value: l["app.kubernetes.io/name"] };
  return { by: "workload", value: o.name };
}

/** Infer the applications of a live Kubernetes read (an `IndexDocument`'s `graph`). */
export function inferK8sComponents(graph: Pick<GraphIR, "nodes">): InferredK8sComponents {
  const notes: string[] = [];
  const objs = graph.nodes.map(readObj).filter((o): o is Obj => o !== undefined);
  const byId = new Map(objs.map((o) => [o.id, o]));
  const byUid = new Map<string, Obj>();
  for (const o of objs) if (o.uid) byUid.set(o.uid, o);
  const keyOf = (ns: string, kind: string, name: string) => `${ns}\u0000${kind}\u0000${name}`;
  const byKey = new Map<string, Obj>();
  for (const o of objs) {
    const k = keyOf(o.ns, o.kind, o.name);
    if (!byKey.has(k) || o.group === "" || WORKLOAD_GROUPS.has(o.group)) byKey.set(k, o);
  }
  const find = (ns: string, kind: string, name: string | undefined) => (name ? byKey.get(keyOf(ns, kind, name)) : undefined);

  // The controlling owner of each object, when the read holds it.
  const ownerOf = (o: Obj): Obj | undefined => {
    const refs = arr(rec(o.attrs.metadata).ownerReferences).filter(isRec);
    const ref = refs.find((r) => r.controller === true) ?? refs[0];
    if (!ref) return undefined;
    const uid = str(ref.uid);
    return (uid ? byUid.get(uid) : undefined) ?? find(o.ns, String(ref.kind ?? ""), str(ref.name));
  };

  // Seeds: workloads no workload controls.
  const seeds = objs.filter((o) => {
    if (!isWorkload(o) || !o.ns) return false;
    const owner = ownerOf(o);
    return !owner || !isWorkload(owner);
  });

  // Units, then their names.
  const units = new Map<string, Unit>();
  for (const s of seeds) {
    const boundary = unitOf(s);
    const key = boundary.by === "workload" ? `${s.ns}\u0000workload\u0000${s.kind}\u0000${s.name}` : `${s.ns}\u0000${boundary.by}\u0000${boundary.value}`;
    const u = units.get(key) ?? { key, ns: s.ns, boundary, seeds: [], name: "" };
    u.seeds.push(s);
    units.set(key, u);
  }
  const ordered = [...units.values()].sort((a, b) => {
    const wa = a.boundary.by === "workload" ? 1 : 0;
    const wb = b.boundary.by === "workload" ? 1 : 0;
    return wa - wb || byString(a.ns, b.ns) || byString(a.key, b.key);
  });
  const taken = new Map<string, string>();
  for (const u of ordered) {
    const plain = u.boundary.value;
    const inNs = `${u.ns}\u0000${plain}`;
    u.name = taken.has(inNs) ? (u.boundary.by === "workload" ? `${u.seeds[0].kind.toLowerCase()}-${plain}` : `${u.boundary.by}-${plain}`) : plain;
    taken.set(`${u.ns}\u0000${u.name}`, u.key);
  }
  const nsOfName = new Map<string, Set<string>>();
  for (const u of ordered) (nsOfName.get(u.name) ?? nsOfName.set(u.name, new Set()).get(u.name)!).add(u.ns);
  for (const u of ordered) if (nsOfName.get(u.name)!.size > 1) u.name = `${u.ns}/${u.name}`;
  const unitOfSeed = new Map<string, Unit>();
  for (const u of ordered) for (const s of u.seeds) unitOfSeed.set(s.id, u);

  // What each application takes in: object id -> the applications and the role.
  const usedBy = new Map<string, Set<string>>();
  const roleOf = new Map<string, K8sMemberRole>();
  const take = (o: Obj | undefined, component: string, role?: K8sMemberRole) => {
    if (!o) return;
    (usedBy.get(o.id) ?? usedBy.set(o.id, new Set()).get(o.id)!).add(component);
    if (!roleOf.has(o.id)) roleOf.set(o.id, role ?? ROLE_OF_KIND[o.kind] ?? "config");
  };
  const users = (o: Obj): Set<string> => usedBy.get(o.id) ?? new Set();

  for (const s of seeds) take(s, unitOfSeed.get(s.id)!.name, "workload");

  // Runtime children: an owner chain that ends at a seed.
  const seedIds = new Set(seeds.map((s) => s.id));
  const seedOfChain = (o: Obj): Obj | undefined => {
    const seen = new Set<string>();
    let cur: Obj | undefined = o;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (seedIds.has(cur.id)) return cur;
      cur = ownerOf(cur);
    }
    return undefined;
  };
  const runtimePods = new Map<string, Obj[]>();
  for (const o of objs) {
    if (seedIds.has(o.id)) continue;
    const seed = seedOfChain(o);
    if (!seed) continue;
    take(o, unitOfSeed.get(seed.id)!.name, "runtime");
    if (o.kind === "Pod") (runtimePods.get(seed.id) ?? runtimePods.set(seed.id, []).get(seed.id)!).push(o);
  }

  const templates = new Map<string, { labels: Record<string, string>; spec: Rec }>();
  for (const s of seeds) {
    const t = podTemplate(s);
    if (t) templates.set(s.id, t);
  }
  const ofKind = (kind: string) => objs.filter((o) => o.kind === kind && o.ns);

  // Services that select a seed's pods, and their bookkeeping.
  const services = ofKind("Service");
  for (const svc of services) {
    for (const s of seeds) {
      const t = templates.get(s.id);
      if (s.ns === svc.ns && t && selects(rec(svc.attrs.spec).selector, t.labels, { plain: true })) take(svc, unitOfSeed.get(s.id)!.name);
    }
  }
  for (const svc of services) {
    for (const c of users(svc)) {
      take(find(svc.ns, "Endpoints", svc.name), c);
      for (const es of ofKind("EndpointSlice")) if (es.ns === svc.ns && es.labels[SERVICE_NAME_LABEL] === svc.name) take(es, c);
    }
  }

  // Routes to those Services.
  for (const ing of ofKind("Ingress")) {
    const spec = rec(ing.attrs.spec);
    const names = new Set<string>();
    const backend = (b: unknown) => {
      const n = str(rec(rec(b).service).name) ?? str(rec(b).serviceName);
      if (n) names.add(n);
    };
    backend(spec.defaultBackend ?? spec.backend);
    for (const r of arr(spec.rules).filter(isRec)) for (const p of arr(rec(r.http).paths).filter(isRec)) backend(p.backend);
    for (const n of names) {
      const svc = find(ing.ns, "Service", n);
      if (svc) for (const c of users(svc)) take(ing, c);
    }
  }
  for (const route of ofKind("HTTPRoute")) {
    for (const r of arr(rec(route.attrs.spec).rules).filter(isRec)) {
      for (const b of arr(r.backendRefs).filter(isRec)) {
        if (b.kind !== undefined && b.kind !== "Service") continue;
        const svc = find(str(b.namespace) ?? route.ns, "Service", str(b.name));
        if (svc) for (const c of users(svc)) take(route, c);
      }
    }
  }

  // Policies that target the seeds.
  for (const hpa of ofKind("HorizontalPodAutoscaler")) {
    const ref = rec(rec(hpa.attrs.spec).scaleTargetRef);
    const target = find(hpa.ns, String(ref.kind ?? ""), str(ref.name));
    if (target && unitOfSeed.has(target.id)) take(hpa, unitOfSeed.get(target.id)!.name);
  }
  for (const [kind, field, all] of [["PodDisruptionBudget", "selector", false], ["NetworkPolicy", "podSelector", true]] as const) {
    for (const p of ofKind(kind)) {
      for (const s of seeds) {
        const t = templates.get(s.id);
        if (s.ns === p.ns && t && selects(rec(p.attrs.spec)[field], t.labels, { emptyMatchesAll: all })) take(p, unitOfSeed.get(s.id)!.name);
      }
    }
  }

  // What the pod template and the running Pods name.
  const maskedBy = new Map<string, number>();
  for (const s of seeds) {
    const c = unitOfSeed.get(s.id)!.name;
    const t = templates.get(s.id);
    const refs = podRefs(t?.spec ?? {});
    for (const pod of runtimePods.get(s.id) ?? []) podRefs(rec(pod.attrs.spec), refs);
    for (const n of refs.configMaps) take(find(s.ns, "ConfigMap", n), c);
    for (const n of refs.secrets) take(find(s.ns, "Secret", n), c);
    for (const n of refs.claims) take(find(s.ns, "PersistentVolumeClaim", n), c);
    take(find(s.ns, "ServiceAccount", refs.serviceAccount), c);
    if (refs.masked.size > 0) maskedBy.set(c, (maskedBy.get(c) ?? 0) + refs.masked.size);
  }
  for (const es of objs.filter((o) => o.kind === "ExternalSecret" && o.ns)) {
    const target = find(es.ns, "Secret", str(rec(rec(es.attrs.spec).target).name) ?? es.name);
    if (target) for (const c of users(target)) take(es, c);
  }

  // Bookkeeping roles, and what members name outside the cluster.
  for (const [id] of usedBy) {
    const o = byId.get(id)!;
    if ((o.kind === "ConfigMap" && o.name === "kube-root-ca.crt") || (o.kind === "ServiceAccount" && o.name === "default")) roleOf.set(id, "bookkeeping");
  }
  const outsideOf = (o: Obj): K8sOutsideName[] => {
    const out: K8sOutsideName[] = [];
    if (o.kind === "ServiceAccount") {
      for (const key of OUTSIDE_ANNOTATIONS) if (o.annotations[key] && !isMasked(o.annotations[key])) out.push({ from: o.id, key, value: o.annotations[key] });
    }
    if (o.kind === "ExternalSecret") {
      const spec = rec(o.attrs.spec);
      for (const d of arr(spec.data).filter(isRec)) {
        const k = str(rec(d.remoteRef).key);
        if (k && !isMasked(k)) out.push({ from: o.id, key: "remoteRef.key", value: k });
      }
      for (const d of arr(spec.dataFrom).filter(isRec)) {
        const k = str(rec(d.extract).key);
        if (k && !isMasked(k)) out.push({ from: o.id, key: "remoteRef.key", value: k });
      }
    }
    return out;
  };

  // Members and shared objects.
  const members = new Map<string, K8sComponentMember[]>();
  const shares = new Map<string, string[]>();
  const outside = new Map<string, K8sOutsideName[]>();
  const shared: K8sSharedObject[] = [];
  for (const [id, set] of [...usedBy.entries()].sort(([a], [b]) => byString(a, b))) {
    const role = roleOf.get(id)!;
    const o = byId.get(id)!;
    const names = outsideOf(o);
    if (set.size === 1) {
      const c = [...set][0];
      (members.get(c) ?? members.set(c, []).get(c)!).push({ id, role });
      if (names.length) (outside.get(c) ?? outside.set(c, []).get(c)!).push(...names);
    } else {
      const usedByList = [...set].sort(byString);
      shared.push({ id, role, usedBy: usedByList, ...(names.length ? { outside: names } : {}) });
      for (const c of usedByList) (shares.get(c) ?? shares.set(c, []).get(c)!).push(id);
    }
  }

  // dependsOn from Service names in env values and ConfigMap data.
  const serviceOwner = (ns: string, name: string): string | undefined => {
    const svc = find(ns, "Service", name);
    const set = svc ? users(svc) : undefined;
    return set && set.size === 1 ? [...set][0] : undefined;
  };
  const deps = new Map<string, Map<string, string[]>>();
  const depend = (from: string, ns: string, value: string, via: string) => {
    for (const [tns, tname] of serviceNamesIn(value, ns)) {
      const to = serviceOwner(tns, tname);
      if (!to || to === from) continue;
      const m = deps.get(from) ?? deps.set(from, new Map()).get(from)!;
      const list = m.get(to) ?? m.set(to, []).get(to)!;
      if (!list.includes(via)) list.push(via);
    }
  };
  for (const s of seeds) {
    const c = unitOfSeed.get(s.id)!.name;
    for (const [n, v] of envValues(templates.get(s.id)?.spec ?? {})) depend(c, s.ns, v, `${s.kind} ${s.name} env ${n}`);
  }
  for (const [id, set] of usedBy) {
    const o = byId.get(id)!;
    if (o.kind !== "ConfigMap") continue;
    for (const [k, v] of Object.entries(rec(o.attrs.data))) {
      if (typeof v !== "string" || isMasked(v)) continue;
      for (const c of set) depend(c, o.ns, v, `ConfigMap ${o.name} data.${k}`);
    }
  }

  // Waves: Kahn layers, with any cycle in one last wave.
  const names = ordered.map((u) => u.name);
  const remaining = new Set(names);
  const waves: string[][] = [];
  while (remaining.size > 0) {
    let wave = [...remaining].filter((n) => [...(deps.get(n)?.keys() ?? [])].every((d) => !remaining.has(d))).sort(byString);
    if (wave.length === 0) {
      wave = [...remaining].sort(byString);
      notes.push(`these applications name each other's Services in a cycle and share the last wave: ${wave.join(", ")}`);
    }
    for (const n of wave) remaining.delete(n);
    waves.push(wave);
  }
  const waveOf = new Map<string, number>();
  waves.forEach((w, i) => w.forEach((n) => waveOf.set(n, i + 1)));

  for (const [c, n] of [...maskedBy.entries()].sort(([a], [b]) => byString(a, b))) {
    notes.push(`${c}: ${n} Secret reference${n === 1 ? " is" : "s are"} masked by the live read, so ${n === 1 ? "that Secret is" : "those Secrets are"} not taken in`);
  }

  const unitByName = new Map(ordered.map((u) => [u.name, u]));
  const nodes: IRNode[] = waves.flat().map((name) => {
    const u = unitByName.get(name)!;
    const mine = members.get(name) ?? [];
    return {
      id: name,
      kind: "Component",
      lexicon: "chant",
      attrs: {
        wave: waveOf.get(name) ?? null,
        liveNames: mine.map((m) => m.id),
        members: mine,
        namespace: u.ns,
        boundary: u.boundary,
        inferredFrom: "kubernetes",
        ...(shares.get(name)?.length ? { shares: shares.get(name) } : {}),
        ...(outside.get(name)?.length ? { outside: outside.get(name) } : {}),
      },
    };
  });
  const edges: IREdge[] = [];
  for (const from of [...deps.keys()].sort(byString)) {
    for (const [to, via] of [...deps.get(from)!.entries()].sort(([a], [b]) => byString(a, b))) {
      edges.push({ from, to, kind: "ref", origin: "derived", rule: "k8s:service-dns", viaAttr: via.sort(byString).join("; ") });
    }
  }
  const ir: GraphIR = {
    version: 1,
    nodes,
    edges,
    groups: { byWave: Object.fromEntries(waves.map((w, i) => [`wave-${i + 1}`, [...w]])) },
  };
  return { ir, shared, notes };
}
