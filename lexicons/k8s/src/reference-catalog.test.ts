/**
 * #4535: the k8s reference catalog. Each rule draws its edge on a fixture of
 * its own, the catalog keeps behold#1023's ruling (typed rules, no edge on
 * ambiguity, scoped join keys: a namespace is a scope over an index), and
 * behold#166's case, a Deployment's env var naming a bucket, is joined.
 */
import { describe, expect, it } from "vitest";
import type { IRNode } from "@intentius/chant/graph-ir";
import { reconstructIndexedEdges, refRuleId, type ReferenceCatalog } from "@intentius/chant/graph-refs";
import type { ComposedNode, WorkspaceGraph } from "@intentius/chant/workspace/compose-graph";
import { placeCatalogPass, runCatalogPass } from "@intentius/chant/workspace/catalog-edges";
import { k8sReferenceCatalog } from "./reference-catalog";
import { k8sPlugin } from "./plugin";

const LEXICON = "k8s";

/** attrs with `value` written at a catalog path (`a.b`, `arr[].c`). */
function atPath(path: string, value: string): Record<string, unknown> {
  const parts = path.split(".");
  const build = (i: number): unknown => {
    if (i === parts.length) return value;
    const part = parts[i];
    const isArr = part.endsWith("[]");
    const inner = build(i + 1);
    return { [isArr ? part.slice(0, -2) : part]: isArr ? [inner] : inner };
  };
  return build(0) as Record<string, unknown>;
}

/** A node of `kind` named `value` by the catalog's first identity path for it, else by its native id. */
function target(catalog: ReferenceCatalog, kind: string, id: string, value: string): IRNode {
  const path = catalog.identities.find((r) => r.kind === kind)?.ids[0];
  const lexicon = kind.startsWith("AWS::") ? "aws" : LEXICON;
  return path ? { id, kind, lexicon, attrs: atPath(path, value) } : { id, kind, lexicon, attrs: {}, nativeId: value };
}

const node = (id: string, kind: string, attrs: Record<string, unknown>, location?: string): IRNode => ({ id, kind, lexicon: LEXICON, attrs, ...(location ? { location } : {}) });

/** An index's scope: a namespaced object's location is its namespace, a cluster-scoped one's is `cluster`. */
const clusterScope = (n: IRNode) => ({ account: "kubernetes/k3d-demo", ...(n.location && n.location !== "cluster" ? { region: n.location } : {}) });

const derive = (nodes: IRNode[], scope: (n: IRNode) => { account: string; region?: string } = () => ({ account: "declared" }), catalogs = [{ lexicon: LEXICON, catalog: k8sReferenceCatalog }]) =>
  reconstructIndexedEdges(nodes, catalogs, scope);

describe("k8s reference catalog", () => {
  it("is the plugin's referenceCatalog", () => {
    expect(k8sPlugin.referenceCatalog).toBe(k8sReferenceCatalog);
  });

  it("names a target kind on every rule (behold#1023's ruling)", () => {
    expect(k8sReferenceCatalog.refs.filter((r) => !(r.targetKind ?? r.indexedTargetKind))).toEqual([]);
  });

  it("has no two rules for one holder kind, path and target kind", () => {
    const keys = k8sReferenceCatalog.refs.map((r) => `${r.from}|${r.path}|${r.targetKind}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  describe("each rule draws its edge", () => {
    for (const [i, rule] of k8sReferenceCatalog.refs.entries()) {
      const to = rule.targetKind ?? rule.indexedTargetKind!;
      it(`${rule.from} ${rule.path} -> ${to}`, () => {
        const value = `target-name-${i}`;
        const holder = node(`holder-${i}`, rule.from, atPath(rule.path, value));
        const out = derive([holder, target(k8sReferenceCatalog, to, `target-${i}`, value)]);
        const edge = out.edges.find((e) => e.from === holder.id && e.to === `target-${i}`);
        expect(edge?.rule).toBe(refRuleId(LEXICON, rule.from, rule.path));
        expect(edge?.relation).toBe(rule.relation);
      });
    }
  });

  describe("an app in one namespace, as an index lists it", () => {
    const nodes: IRNode[] = [
      node("ns/shop", "K8s::Core::Namespace", { metadata: { name: "shop" } }, "cluster"),
      node("shop/sa/web", "K8s::Core::ServiceAccount", { metadata: { name: "web", namespace: "shop" } }, "shop"),
      node("shop/cm/web-config", "K8s::Core::ConfigMap", { metadata: { name: "web-config", namespace: "shop" } }, "shop"),
      node("shop/secret/web-tls", "K8s::Core::Secret", { metadata: { name: "web-tls", namespace: "shop" } }, "shop"),
      node(
        "shop/deploy/web",
        "K8s::Apps::Deployment",
        {
          metadata: { name: "web", namespace: "shop" },
          spec: {
            template: {
              metadata: { labels: { app: "web" } },
              spec: { serviceAccountName: "web", containers: [{ name: "web", envFrom: [{ configMapRef: { name: "web-config" } }] }] },
            },
          },
        },
        "shop",
      ),
      node("shop/svc/web", "K8s::Core::Service", { metadata: { name: "web-svc", namespace: "shop" }, spec: { selector: { app: "web" } } }, "shop"),
      node(
        "shop/ing/web",
        "K8s::Networking::Ingress",
        { metadata: { name: "web", namespace: "shop" }, spec: { tls: [{ secretName: "web-tls" }], rules: [{ http: { paths: [{ backend: { service: { name: "web-svc" } } }] } }] } },
        "shop",
      ),
    ];
    const out = derive(nodes, clusterScope);

    it("draws the app's topology", () => {
      expect(out.edges.filter((e) => e.relation === "reference").map((e) => `${e.from} -> ${e.to} [${e.viaAttr}]`)).toEqual([
        "shop/deploy/web -> shop/cm/web-config [spec]",
        "shop/deploy/web -> shop/sa/web [spec]",
        "shop/ing/web -> shop/secret/web-tls [spec]",
        "shop/ing/web -> shop/svc/web [spec]",
        "shop/svc/web -> shop/deploy/web [spec]",
      ]);
    });

    it("places every namespaced object in its namespace, across the namespace-to-cluster scope", () => {
      expect(out.containment.map((c) => c.child).sort()).toEqual(nodes.filter((n) => n.location === "shop").map((n) => n.id).sort());
      expect(new Set(out.containment.map((c) => c.parent))).toEqual(new Set(["ns/shop"]));
    });

    it("leaves nothing ambiguous or dangling", () => {
      expect(out.ambiguous).toEqual([]);
      expect(out.dangling).toEqual([]);
    });
  });

  it("keeps a `default` service account inside its own namespace over an index", () => {
    const nodes: IRNode[] = [
      node("a/sa/default", "K8s::Core::ServiceAccount", { metadata: { name: "default", namespace: "a" } }, "a"),
      node("b/sa/default", "K8s::Core::ServiceAccount", { metadata: { name: "default", namespace: "b" } }, "b"),
      node("a/pod/x", "K8s::Core::Pod", { metadata: { name: "x", namespace: "a" }, spec: { serviceAccountName: "default" } }, "a"),
    ];
    expect(derive(nodes, clusterScope).edges.filter((e) => e.relation === "reference").map((e) => `${e.from} -> ${e.to}`)).toEqual(["a/pod/x -> a/sa/default"]);
  });

  it("draws no edge on a declared graph (one scope) where two namespaces share the name, and records both", () => {
    const nodes: IRNode[] = [
      node("sa-a", "K8s::Core::ServiceAccount", { metadata: { name: "default", namespace: "a" } }),
      node("sa-b", "K8s::Core::ServiceAccount", { metadata: { name: "default", namespace: "b" } }),
      node("pod", "K8s::Core::Pod", { metadata: { name: "x", namespace: "a" }, spec: { serviceAccountName: "default" } }),
    ];
    const out = derive(nodes);
    expect(out.edges.filter((e) => e.viaAttr === "spec")).toEqual([]);
    expect(out.ambiguous.map((a) => a.candidates)).toEqual([["sa-a", "sa-b"]]);
  });

  describe("behold#166: a Deployment's env var naming a bucket", () => {
    const deployment = node("assets-api", "K8s::Apps::Deployment", {
      metadata: { name: "assets-api" },
      spec: { template: { spec: { containers: [{ name: "api", env: [{ name: "ASSET_BUCKET", value: "loom-assets-1a2b3c" }, { name: "LOG_LEVEL", value: "info" }] }] } } },
    });
    const bucket: IRNode = { id: "AssetBucket", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: { BucketName: "loom-assets-1a2b3c" } };
    // The aws catalog's bucket identity is what names it; an inline copy keeps this test inside the k8s package.
    const aws: ReferenceCatalog = { identities: [{ kind: "AWS::S3::Bucket", ids: ["BucketName"] }], refs: [] };
    const out = derive([deployment, bucket], undefined, [
      { lexicon: "aws", catalog: aws },
      { lexicon: LEXICON, catalog: k8sReferenceCatalog },
    ]);

    it("joins the env value to the bucket", () => {
      expect(out.edges.map((e) => `${e.from} -> ${e.to} (${e.rule})`)).toEqual([
        "assets-api -> AssetBucket (k8s:K8s::Apps::Deployment:spec.template.spec.containers[].env[].value)",
      ]);
    });

    it("reports no other env value as dangling", () => {
      expect(out.dangling).toEqual([]);
    });

    it("does not join across substrates over an index, where the cluster and the account are two scopes", () => {
      const scoped = derive([deployment, bucket], (n) => ({ account: n.lexicon === "aws" ? "aws/000000000000" : "kubernetes/k3d-demo" }), [
        { lexicon: "aws", catalog: aws },
        { lexicon: LEXICON, catalog: k8sReferenceCatalog },
      ]);
      expect(scoped.edges).toEqual([]);
    });
  });
});

describe("on a composed workspace graph (#5097)", () => {
  const RULE = "k8s:K8s::Apps::Deployment:spec.template.spec.serviceAccountName";
  const composed = (member: string, id: string, kind: string, attrs: Record<string, unknown>): ComposedNode => ({ id: `${member}/${id}`, kind, lexicon: LEXICON, attrs, member });
  const deployment = (sa: string, namespace: string | null = "shop") =>
    composed("app", "web", "K8s::Apps::Deployment", { metadata: { name: "web", ...(namespace ? { namespace } : {}) }, spec: { template: { spec: { serviceAccountName: sa } } } });
  const account = (member: string, namespace: string | null = "shop") =>
    composed(member, "runner", "K8s::Core::ServiceAccount", { metadata: { name: "runner", ...(namespace ? { namespace } : {}) } });
  const pass = (nodes: ComposedNode[]) => runCatalogPass(nodes, [{ lexicon: LEXICON, catalog: k8sReferenceCatalog }]);
  const graphOf = (nodes: ComposedNode[]): WorkspaceGraph => ({
    version: 1,
    workspace: { name: "w", root: "." },
    members: [],
    nodes,
    edges: [],
    groups: { byMember: {} },
    exports: [],
    imports: [],
    links: [],
    collectors: [],
    records: [],
  });

  it("joins a Deployment in one member to the ServiceAccount another member holds in the same namespace", () => {
    const out = pass([deployment("runner"), account("rbac")]);
    expect(out.edges).toEqual([
      expect.objectContaining({ from: "app/web", to: "rbac/runner", rule: RULE, origin: "derived", relation: "reference", member: "app" }),
    ]);
    expect(out.dangling.filter((d) => d.rule === RULE)).toEqual([]);
  });

  it("lists a name no node holds in dangling with its rule", () => {
    const out = pass([deployment("missing"), account("rbac")]);
    expect(out.edges.filter((e) => e.rule === RULE)).toEqual([]);
    expect(out.dangling.filter((d) => d.rule === RULE)).toEqual([
      { from: "app/web", kind: "ref", path: "spec.template.spec.serviceAccountName", value: "missing", member: "app", rule: RULE, targetKind: "K8s::Core::ServiceAccount" },
    ]);
  });

  it("draws no edge when two members hold the name there, and records both candidates", () => {
    const out = pass([deployment("runner"), account("rbac"), account("rbac2")]);
    expect(out.edges.filter((e) => e.rule === RULE)).toEqual([]);
    expect(out.ambiguous).toEqual([
      { from: "app/web", member: "app", rule: RULE, path: "spec.template.spec.serviceAccountName", value: "runner", candidates: ["rbac/runner", "rbac2/runner"] },
    ]);
  });

  it("keeps a name inside its namespace, and a namespace-less object inside its member", () => {
    const missing = (nodes: ComposedNode[]) => pass(nodes).dangling.filter((d) => d.rule === RULE).map((d) => d.value);
    expect(missing([deployment("runner"), account("rbac", "other")])).toEqual(["runner"]);
    expect(missing([deployment("runner", null), account("rbac", null)])).toEqual(["runner"]);
    const same = [deployment("runner", null), { ...account("app", null), id: "app/runner" }];
    expect(pass(same).edges.map((e) => e.to)).toEqual(["app/runner"]);
    // The namespace is a node too: a Namespace any member declares contains the objects in it.
    const ns = composed("base", "shop", "K8s::Core::Namespace", { metadata: { name: "shop" } });
    expect(pass([deployment("runner"), account("rbac"), ns]).edges.filter((e) => e.relation === "containment").map((e) => `${e.from}>${e.to}`)).toEqual(["app/web>base/shop", "rbac/runner>base/shop"]);
  });

  it("places the pass on the document's nodes at --detail 0, and names the rule", () => {
    const graph = graphOf([]);
    placeCatalogPass(graph, pass([deployment("runner"), account("rbac")]), new Map([["app/web", "app/k8s"], ["rbac/runner", "rbac/k8s"]]));
    expect(graph.edges).toEqual([expect.objectContaining({ from: "app/k8s", to: "rbac/k8s", rule: RULE, member: "app" })]);
    expect(graph.catalog?.rules[RULE]).toEqual({ lexicon: LEXICON, from: "K8s::Apps::Deployment", path: "spec.template.spec.serviceAccountName", relation: "reference", targetKinds: ["K8s::Core::ServiceAccount"], label: "runs as" });
    expect(graph.catalog?.lexicons).toEqual([LEXICON]);
  });

  it("gives a pair the declared graph already joins no second edge", () => {
    const graph = graphOf([]);
    graph.edges = [{ from: "app/web", to: "rbac/runner", kind: "ref", member: "app" }];
    placeCatalogPass(graph, pass([deployment("runner"), account("rbac")]));
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].origin).toBeUndefined();
  });
});
