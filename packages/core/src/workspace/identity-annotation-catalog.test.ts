/**
 * #5099: a ServiceAccount's Workload Identity or IRSA annotation to the cloud
 * identity, and a Workload Identity binding back to the ServiceAccount, over
 * a composed workspace graph with the k8s and terraform catalogs together.
 */
import { describe, expect, it } from "vitest";
import { EKS_ANNOTATION, GKE_ANNOTATION, k8sReferenceCatalog } from "../../../../lexicons/k8s/src/reference-catalog";
import { TERRAFORM_REFERENCE_CATALOG } from "../../../../lexicons/terraform/src/behaviour/reference-catalog";
import { placeCatalogPass, runCatalogPass } from "./catalog-edges";
import type { ComposedNode, WorkspaceGraph } from "./compose-graph";

const SA = "K8s::Core::ServiceAccount";
const GKE_RULE = `k8s:${SA}:${GKE_ANNOTATION}`;
const EKS_RULE = `k8s:${SA}:${EKS_ANNOTATION}`;
const MEMBER_RULE = "terraform:google_service_account_iam_member:member";
const BINDING_RULE = "terraform:google_service_account_iam_binding:members[]";

const sa = (name: string, namespace: string, annotations?: Record<string, string>, member = "k8s"): ComposedNode => ({
  id: `${member}/sa-${namespace}-${name}`,
  kind: SA,
  lexicon: "k8s",
  member,
  attrs: { metadata: { name, namespace, ...(annotations ? { annotations } : {}) } },
});
const tf = (address: string, body: Record<string, unknown>, member = "tf"): ComposedNode => ({
  id: `${member}/r/${address}`,
  kind: "Terraform::Resource",
  lexicon: "terraform",
  member,
  attrs: { address, type: address.split(".")[0], name: address.split(".")[1], body, source: "main.tf" },
});

const gsa = (address: string, accountId: string, project: string) => tf(address, { account_id: accountId, project });
const runner = sa("runner", "ci", { "iam.gke.io/gcp-service-account": "runner@demo-proj.iam.gserviceaccount.com" });
const binding = (member: string, address = "google_service_account_iam_member.runner", role = "roles/iam.workloadIdentityUser") =>
  tf(address, { service_account_id: "projects/demo-proj/serviceAccounts/runner@demo-proj.iam.gserviceaccount.com", role, member });

const pass = (nodes: ComposedNode[]) =>
  runCatalogPass(nodes, [
    { lexicon: "k8s", catalog: k8sReferenceCatalog },
    { lexicon: "terraform", catalog: TERRAFORM_REFERENCE_CATALOG },
  ]);
// A Namespace declared nowhere is dangling under the containment rule; these tests read the identity rules.
const identityDangling = (out: ReturnType<typeof pass>) => out.dangling.filter((d) => d.rule !== undefined && !d.rule.endsWith("metadata.namespace"));
const refEdges = (out: ReturnType<typeof pass>) =>
  out.edges.filter((e) => e.relation === "reference").map((e) => `${e.from} -> ${e.to} [${e.viaAttr}] ${e.rule}`);

describe("Workload Identity annotation (#5099)", () => {
  it("draws ServiceAccount to account and binding to ServiceAccount", () => {
    const out = pass([runner, gsa("google_service_account.runner", "runner", "demo-proj"), binding("serviceAccount:demo-proj.svc.id.goog[ci/runner]")]);
    expect(refEdges(out)).toEqual([
      `k8s/sa-ci-runner -> tf/r/google_service_account.runner [iam.gke.io/gcp-service-account] ${GKE_RULE}`,
      `tf/r/google_service_account_iam_member.runner -> k8s/sa-ci-runner [workload identity member] ${MEMBER_RULE}`,
    ]);
    expect(identityDangling(out)).toEqual([]);
  });

  it("joins only the account in the annotation's project", () => {
    const out = pass([runner, gsa("google_service_account.a", "runner", "other-proj"), gsa("google_service_account.b", "runner", "demo-proj")]);
    expect(refEdges(out)).toEqual([`k8s/sa-ci-runner -> tf/r/google_service_account.b [iam.gke.io/gcp-service-account] ${GKE_RULE}`]);
    expect(out.ambiguous).toEqual([]);
  });

  it("reports two accounts of one id in one project as ambiguous, with both candidates", () => {
    const out = pass([runner, gsa("google_service_account.a", "runner", "demo-proj"), gsa("google_service_account.b", "runner", "demo-proj")]);
    expect(refEdges(out)).toEqual([]);
    expect(out.ambiguous).toEqual([expect.objectContaining({ rule: GKE_RULE, candidates: ["tf/r/google_service_account.a", "tf/r/google_service_account.b"] })]);
  });

  it("lists an annotation that names an account not in the graph as dangling", () => {
    const out = pass([runner, gsa("google_service_account.other", "other", "demo-proj")]);
    expect(refEdges(out)).toEqual([]);
    expect(identityDangling(out)).toEqual([
      expect.objectContaining({ from: "k8s/sa-ci-runner", value: "runner@demo-proj.iam.gserviceaccount.com", rule: GKE_RULE, targetKind: "google_service_account" }),
    ]);
  });

  it("gives an account whose project is a variable no edge, and counts the argument", () => {
    const account = tf("google_service_account.runner", { account_id: "runner", project: "${var.project}" });
    const out = pass([runner, account]);
    expect(refEdges(out)).toEqual([]);
    expect(out.nonLiteral).toEqual({ "tf/r/google_service_account.runner": 1 });
    expect(identityDangling(out).map((d) => d.value)).toEqual(["runner@demo-proj.iam.gserviceaccount.com"]);
  });

  it("reads a binding's members list, and only for roles/iam.workloadIdentityUser", () => {
    const list = tf("google_service_account_iam_binding.runner", { role: "roles/iam.workloadIdentityUser", members: ["serviceAccount:demo-proj.svc.id.goog[ci/runner]", "user:a@example.com"] });
    expect(refEdges(pass([runner, list])).map((e) => e.split(" ").slice(0, 3).join(" "))).toEqual(["tf/r/google_service_account_iam_binding.runner -> k8s/sa-ci-runner"]);
    expect(refEdges(pass([runner, binding("serviceAccount:demo-proj.svc.id.goog[ci/runner]", "google_service_account_iam_member.x", "roles/iam.serviceAccountUser")]))).toEqual([]);
    expect(BINDING_RULE).toContain("members[]");
  });

  it("joins a binding to the ServiceAccount of that name in that namespace only, and reports none for a cluster that is not in the workspace", () => {
    const elsewhere = sa("runner", "other", undefined);
    const edges = refEdges(pass([runner, elsewhere, binding("serviceAccount:demo-proj.svc.id.goog[ci/runner]")])).filter((e) => e.includes(MEMBER_RULE));
    expect(edges.map((e) => e.split(" ")[2])).toEqual(["k8s/sa-ci-runner"]);
    const out = pass([binding("serviceAccount:demo-proj.svc.id.goog[ci/runner]")]);
    expect(refEdges(out)).toEqual([]);
    expect(identityDangling(out)).toEqual([]);
  });

  it("gives a binding whose member is built from a local no edge, and counts it", () => {
    const out = pass([runner, binding("serviceAccount:${local.pool}[ci/runner]")]);
    expect(refEdges(out)).toEqual([]);
    expect(out.nonLiteral).toEqual({ "tf/r/google_service_account_iam_member.runner": 1 });
  });
});

describe("IRSA annotation (#5099)", () => {
  const irsa = (arn: string) => sa("runner", "ci", { "eks.amazonaws.com/role-arn": arn });
  const role = (name: string, extra: Record<string, unknown> = {}) => tf(`aws_iam_role.${name.replace(/-/g, "_")}`, { name, assume_role_policy: "{}", ...extra });

  it("draws ServiceAccount to aws_iam_role by the role name in the ARN", () => {
    const out = pass([irsa("arn:aws:iam::111122223333:role/ci-runner"), role("ci-runner")]);
    expect(refEdges(out)).toEqual([`k8s/sa-ci-runner -> tf/r/aws_iam_role.ci_runner [eks.amazonaws.com/role-arn] ${EKS_RULE}`]);
  });

  it("requires the role's path and, when its arn is literal, its account to agree", () => {
    const arn = "arn:aws:iam::111122223333:role/service-role/ci-runner";
    expect(refEdges(pass([irsa(arn), role("ci-runner", { path: "/service-role/" })]))).toHaveLength(1);
    expect(refEdges(pass([irsa(arn), role("ci-runner", { path: "/other/" })]))).toHaveLength(0);
    expect(refEdges(pass([irsa(arn), role("ci-runner", { path: "/service-role/", arn: "arn:aws:iam::999999999999:role/service-role/ci-runner" })]))).toHaveLength(0);
    expect(refEdges(pass([irsa(arn), role("ci-runner", { path: "/service-role/", arn: "arn:aws:iam::111122223333:role/service-role/ci-runner" })]))).toHaveLength(1);
  });

  it("lists a role not in the graph as dangling, and a malformed value too", () => {
    const out = pass([irsa("arn:aws:iam::111122223333:role/missing"), sa("b", "ci", { "eks.amazonaws.com/role-arn": "not-an-arn" })]);
    expect(identityDangling(out).map((d) => d.value).sort()).toEqual(["arn:aws:iam::111122223333:role/missing", "not-an-arn"]);
  });
});

describe("placed rules", () => {
  it("names the annotation rules with their quoted-key ids and target kinds", () => {
    const graph = { version: 1, workspace: { name: "w", root: "." }, members: [], nodes: [], edges: [], groups: { byMember: {} }, exports: [], imports: [], links: [], collectors: [], records: [] } as unknown as WorkspaceGraph;
    placeCatalogPass(graph, pass([runner, gsa("google_service_account.runner", "runner", "demo-proj"), binding("serviceAccount:demo-proj.svc.id.goog[ci/runner]")]));
    expect(graph.catalog?.rules[GKE_RULE]).toMatchObject({ from: SA, path: GKE_ANNOTATION, targetKinds: ["google_service_account"], label: "acts as" });
    expect(graph.catalog?.rules[MEMBER_RULE]).toMatchObject({ targetKinds: [SA] });
  });
});
