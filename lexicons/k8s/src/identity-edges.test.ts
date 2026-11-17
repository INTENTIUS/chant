/**
 * #5250: the identity-match edges and the roleRef rule on a listing shaped
 * like a stock kind cluster. A cluster-scoped name is not an identity by
 * itself: it joins only at the field that names its kind.
 */
import { describe, expect, it } from "vitest";
import type { IRNode } from "@intentius/chant/graph-ir";
import { reconstructIdentityEdges, reconstructIndexedEdges } from "@intentius/chant/graph-refs";
import { k8sNodeIdentities } from "./index-identity";
import { k8sReferenceCatalog } from "./reference-catalog";

const node = (id: string, kind: string, name: string, namespace: string | undefined, attrs: Record<string, unknown> = {}): IRNode => ({
  id,
  kind,
  lexicon: "k8s",
  nativeId: namespace ? `${namespace}/${name}` : name,
  location: namespace ?? "cluster",
  attrs: { metadata: { name, ...(namespace ? { namespace } : {}) }, ...attrs },
});

const scopeOf = (n: IRNode) => ({ account: "kubernetes/kind", ...(n.location && n.location !== "cluster" ? { region: n.location } : {}) });
const identityEdges = (nodes: IRNode[]) => reconstructIdentityEdges(nodes, [{ lexicon: "k8s", identities: k8sNodeIdentities }], scopeOf);

describe("k8s identity-match on a stock cluster", () => {
  const nodes = [
    node("ns/default", "K8s::Core::Namespace", "default", undefined),
    node("sa/default/default", "K8s::Core::ServiceAccount", "default", "default"),
    node("pod/kube-system/dns", "K8s::Core::Pod", "dns", "kube-system", { spec: { serviceAccountName: "default", nodeName: "kind-control-plane", containers: [{ name: "dns", command: ["kube-controller-manager"] }] } }),
    node("cidr/kubernetes", "K8s::Networking::ServiceCIDR", "kubernetes", undefined),
    node("svc/default/kubernetes", "K8s::Core::Service", "kubernetes", "default"),
    node("fs/kube-controller-manager", "K8s::Flowcontrol::FlowSchema", "kube-controller-manager", undefined),
    node("node/cp", "K8s::Core::Node", "kind-control-plane", undefined),
    node("csinode/cp", "K8s::Storage::CSINode", "kind-control-plane", undefined),
    node("cr/edit", "K8s::Rbac::ClusterRole", "system-edit", undefined),
    node("crb/edit", "K8s::Rbac::ClusterRoleBinding", "system-edit", undefined),
  ];

  it("draws no join to a ServiceCIDR, a FlowSchema or a same-named ClusterRole by bare name", () => {
    const out = identityEdges(nodes);
    expect(out.edges.filter((e) => /cidr|fs\/|cr\/|crb\//.test(e.to))).toEqual([]);
  });

  it("names a Node only where a pod says nodeName, so a CSINode of the same name is not a candidate", () => {
    const out = identityEdges(nodes);
    expect(out.ambiguous).toEqual([]);
    expect(out.edges.filter((e) => e.to === "node/cp").map((e) => e.from)).toEqual(["pod/kube-system/dns"]);
    expect(out.edges.filter((e) => e.to === "csinode/cp")).toEqual([]);
  });

  it("joins a Namespace only at a namespace field, never at a ServiceAccount named default", () => {
    const holder = node("rb/x", "K8s::Rbac::RoleBinding", "x", "kube-system", { subjects: [{ kind: "ServiceAccount", name: "default", namespace: "default" }] });
    const out = identityEdges([...nodes, holder]);
    const toNs = out.edges.filter((e) => e.to === "ns/default");
    // The ServiceAccount and the Service sit in `default` (metadata.namespace); the binding's subject names it. The pod's serviceAccountName does not.
    expect(toNs.map((e) => `${e.from} ${e.viaAttr}`).sort()).toEqual(["rb/x subjects", "sa/default/default metadata", "svc/default/kubernetes metadata"]);
  });
});

describe("k8s RoleBinding roleRef", () => {
  const binding = (kind: string) =>
    node("rb/ns/bind", "K8s::Rbac::RoleBinding", "bind", "ns", { roleRef: { apiGroup: "rbac.authorization.k8s.io", kind, name: "provisioner" } });
  const role = node("role/ns/provisioner", "K8s::Rbac::Role", "provisioner", "ns");
  const clusterRole = node("cr/provisioner", "K8s::Rbac::ClusterRole", "provisioner", undefined);
  const edges = (kind: string) =>
    reconstructIndexedEdges([binding(kind), role, clusterRole], [{ lexicon: "k8s", catalog: k8sReferenceCatalog }], scopeOf).edges.filter((e) => e.from === "rb/ns/bind");

  it("joins the ClusterRole, not the same-named Role, when roleRef.kind is ClusterRole", () => {
    expect(edges("ClusterRole").map((e) => e.to)).toEqual(["cr/provisioner"]);
  });

  it("joins the Role when roleRef.kind is Role", () => {
    expect(edges("Role").map((e) => e.to)).toEqual(["role/ns/provisioner"]);
  });
});
