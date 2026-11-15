/**
 * Argo CD cluster Secrets as the graph reads them (#5101): the name and
 * server it joins on, decoded when they sit in `data`, and nothing else of
 * the Secret's credentials.
 */
import { describe, expect, it } from "vitest";
import type { IRNode } from "@intentius/chant/graph-ir";
import { runCatalogPass } from "@intentius/chant/workspace/catalog-edges";
import type { ComposedNode } from "@intentius/chant/workspace/compose-graph";
import { clusterSecretJoin, clusterSecretView, isClusterSecretDocument, k8sDeclaredNode, registersCluster } from "./cluster-secret";
import { k8sReferenceCatalog } from "./reference-catalog";

const LABEL = "argocd.argoproj.io/secret-type";
const b64 = (s: string) => Buffer.from(s).toString("base64");
const secret = (extra: Record<string, unknown>, labels: Record<string, string> = { [LABEL]: "cluster" }): Record<string, unknown> => ({
  apiVersion: "v1",
  kind: "Secret",
  metadata: { name: "cluster-prod", namespace: "argocd", labels },
  ...extra,
});

describe("a cluster Secret document", () => {
  it("is a v1 Secret with the cluster label", () => {
    expect(isClusterSecretDocument(secret({}))).toBe(true);
    expect(isClusterSecretDocument(secret({}, {}))).toBe(false);
    expect(isClusterSecretDocument(secret({}, { [LABEL]: "repository" }))).toBe(false);
    expect(isClusterSecretDocument({ ...secret({}), kind: "ConfigMap" })).toBe(false);
  });

  it("gives its name and server from stringData, or decoded from data, stringData first", () => {
    expect(clusterSecretJoin(secret({ stringData: { name: "prod", server: "https://10.0.0.1" } }))).toEqual({ name: "prod", server: "https://10.0.0.1" });
    expect(clusterSecretJoin(secret({ data: { name: b64("staging"), server: b64("https://10.0.0.2") } }))).toEqual({ name: "staging", server: "https://10.0.0.2" });
    expect(clusterSecretJoin(secret({ stringData: { name: "a" }, data: { name: b64("b"), server: b64("https://s") } }))).toEqual({ name: "a", server: "https://s" });
    expect(clusterSecretJoin(secret({ data: { name: Buffer.from([0xff, 0xfe]).toString("base64") } }))).toEqual({});
  });

  it("is cut down to its metadata, name and server, with the credentials gone", () => {
    const view = clusterSecretView(secret({ type: "Opaque", stringData: { name: "prod", server: "https://10.0.0.1", config: '{"bearerToken":"t"}' }, data: { config: b64("{}") } }));
    expect(view).toEqual({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "cluster-prod", namespace: "argocd", labels: { [LABEL]: "cluster" } },
      type: "Opaque",
      stringData: { name: "prod", server: "https://10.0.0.1" },
    });
  });
});

describe("the node the catalog reads", () => {
  const node = (attrs: Record<string, unknown>, kind = "K8s::Core::Secret"): IRNode => ({ id: "argo/s", kind, lexicon: "k8s", attrs });

  it("gives a cluster Secret argoCluster, decoded, and leaves its credentials out", () => {
    const { apiVersion: _a, kind: _k, ...attrs } = secret({ data: { name: b64("staging"), server: b64("https://10.0.0.2"), config: b64("{}") } });
    expect(k8sDeclaredNode(node(attrs))).toEqual({
      kind: "K8s::Core::Secret",
      attrs: { metadata: attrs.metadata, argoCluster: { name: "staging", server: "https://10.0.0.2" } },
      nonLiteral: 0,
    });
    expect(registersCluster(node(attrs))).toBe(true);
  });

  it("reads any other node as it is, a Secret with a name of its own included", () => {
    const plain = { metadata: { name: "db-login" }, stringData: { name: "orders" } };
    expect(k8sDeclaredNode(node(plain))).toBeUndefined();
    expect(registersCluster(node(plain))).toBe(false);
    expect(k8sDeclaredNode(node({ metadata: { labels: { [LABEL]: "cluster" } } }, "K8s::Core::ConfigMap"))).toBeUndefined();
  });
});

describe("the Argo CD rules on a composed graph", () => {
  const composed = (member: string, id: string, kind: string, attrs: Record<string, unknown>, lexicon = "k8s"): ComposedNode => ({ id: `${member}/${id}`, kind, lexicon, attrs, member });
  const app = (destination: Record<string, string>, namespace = "argocd") =>
    composed("argo", "app", "K8s::Argo::Application", { metadata: { name: "web", namespace }, spec: { destination } });
  const cluster = (name: string, server = "https://10.0.0.1", namespace = "argocd") =>
    composed("argo", "cluster", "K8s::Core::Secret", { metadata: { name: `cluster-${name}`, namespace, labels: { [LABEL]: "cluster" } }, stringData: { name, server } });
  // What the terraform catalog gives a cluster block: its provider type and the literal name.
  const tf = { lexicon: "terraform", catalog: { identities: [{ kind: "google_container_cluster", ids: ["name"] }], refs: [] } };
  const block = (member: string, name: string) => composed(member, `google_container_cluster.${name}`, "google_container_cluster", { name }, "terraform");
  const pass = (nodes: ComposedNode[]) => runCatalogPass(nodes, [{ lexicon: "k8s", catalog: k8sReferenceCatalog }, tf]);
  const DEST = "k8s:K8s::Argo::Application:spec.destination.name";
  const SERVER = "k8s:K8s::Argo::Application:spec.destination.server";
  const REG = "k8s:K8s::Core::Secret:argoCluster.name";

  it("joins an Application to its cluster Secret by name, and by server", () => {
    expect(pass([app({ name: "prod" }), cluster("prod")]).edges.map((e) => [e.from, e.to, e.rule])).toEqual([["argo/app", "argo/cluster", DEST]]);
    expect(pass([app({ server: "https://10.0.0.1" }), cluster("prod")]).edges.map((e) => [e.from, e.to, e.rule])).toEqual([["argo/app", "argo/cluster", SERVER]]);
  });

  it("does not report an in-cluster destination, or one in another namespace, as dangling", () => {
    expect(pass([app({ server: "https://kubernetes.default.svc" }), cluster("prod")]).dangling.filter((d) => d.rule === SERVER)).toEqual([]);
    expect(pass([app({ name: "prod" }, "other"), cluster("prod")]).edges).toEqual([]);
  });

  it("joins a cluster Secret's name to a cluster block of that name", () => {
    const out = pass([cluster("prod"), block("tf", "prod")]);
    expect(out.edges.map((e) => [e.from, e.to, e.rule])).toEqual([["argo/cluster", "tf/google_container_cluster.prod", REG]]);
    expect(out.dangling.filter((d) => d.rule === REG)).toEqual([]);
  });

  it("lists the Secret's name as dangling once, when no cluster block has it, whatever the kinds", () => {
    const out = pass([cluster("prod"), block("tf", "prod-gke")]);
    expect(out.edges).toEqual([]);
    expect(out.dangling.filter((d) => d.rule === REG)).toEqual([expect.objectContaining({ from: "argo/cluster", value: "prod", rule: REG })]);
  });

  it("draws no edge for two cluster blocks of one name, and records both", () => {
    const out = pass([cluster("prod"), block("a", "prod"), block("b", "prod")]);
    expect(out.edges).toEqual([]);
    expect(out.ambiguous).toEqual([expect.objectContaining({ from: "argo/cluster", rule: REG, value: "prod", candidates: ["a/google_container_cluster.prod", "b/google_container_cluster.prod"] })]);
  });

  it("does not read a Secret with a name of its own as a cluster", () => {
    const plain = composed("argo", "db", "K8s::Core::Secret", { metadata: { name: "db", namespace: "argocd" }, stringData: { name: "orders" } });
    expect(pass([plain, block("tf", "orders")]).edges).toEqual([]);
    expect(pass([plain]).dangling.filter((d) => d.rule === REG)).toEqual([]);
  });
});
