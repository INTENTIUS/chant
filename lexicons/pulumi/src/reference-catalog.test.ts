/**
 * The pulumi lexicon's reference catalog (#5330): each rule draws its edge,
 * the catalog is on the plugin, and a stack export shaped like
 * example-three-cloud's aws member gets catalog edges to its own resources
 * and to terraform and k8s members through the workspace graph's catalog pass.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildGraphIr } from "@intentius/chant/graph-ir";
import type { IRNode } from "@intentius/chant/graph-ir";
import { reconstructIndexedEdges, refRuleId } from "@intentius/chant/graph-refs";
import { runCatalogPass } from "../../../packages/core/src/workspace/catalog-edges";
import type { ComposedNode } from "../../../packages/core/src/workspace/compose-graph";
import { k8sReferenceCatalog } from "../../k8s/src/reference-catalog";
import { TERRAFORM_REFERENCE_CATALOG } from "../../terraform/src/behaviour/reference-catalog";
import { pulumiPlugin } from "./plugin";
import { PULUMI_REFERENCE_CATALOG, isUnresolvedKind } from "./reference-catalog";
import { referenceProps } from "./reference-props";
import { readPulumiMember } from "./workspace-member";
import { PULUMI_REFERENCE_CATALOG_FLOOR } from "./chant-floors";

const LEXICON = "pulumi";

/** `a.b[].c` as the nested attrs that path reads. */
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

describe("pulumi reference catalog on the plugin", () => {
  test("is the plugin's referenceCatalog, with a floor", () => {
    expect(pulumiPlugin.referenceCatalog).toBe(PULUMI_REFERENCE_CATALOG);
    expect(PULUMI_REFERENCE_CATALOG_FLOOR).toMatch(/^\d+\.\d+\.\d+$/);
  });

  describe("each targeted rule draws its edge", () => {
    for (const [i, rule] of PULUMI_REFERENCE_CATALOG.refs.entries()) {
      // A rule with a `join` looks the name up inside a namespace and has its own tests below.
      if (!rule.targetKind || rule.join) continue;
      test(`${rule.from} ${rule.path} -> ${rule.targetKind}`, () => {
        const value = `id-${i}-value`;
        const nodes: IRNode[] = [
          { id: `holder-${i}`, kind: rule.from, lexicon: LEXICON, attrs: atPath(rule.path, value) },
          { id: `target-${i}`, kind: rule.targetKind!, lexicon: LEXICON, attrs: {}, physicalId: value },
        ];
        const out = reconstructIndexedEdges(nodes, [{ lexicon: LEXICON, catalog: PULUMI_REFERENCE_CATALOG }], () => ({ account: "declared" }));
        const edge = out.edges.find((e) => e.from === `holder-${i}` && e.to === `target-${i}`);
        expect(edge?.rule).toBe(refRuleId(LEXICON, rule.from, rule.path));
      });
    }
  });

  test("every identity rule names a kind some rule reads or a kind that references nothing", () => {
    const targets = new Set(PULUMI_REFERENCE_CATALOG.refs.map((r) => r.targetKind));
    for (const id of PULUMI_REFERENCE_CATALOG.identities) {
      if (id.kind.startsWith("K8s::")) continue;
      expect(targets.has(id.kind) || !isUnresolvedKind(id.kind), id.kind).toBe(true);
    }
  });

  test("a kind with no rule is unresolved, one known to reference nothing is not", () => {
    expect(isUnresolvedKind("aws:ec2/vpc:Vpc")).toBe(false);
    expect(isUnresolvedKind("aws:ec2/subnet:Subnet")).toBe(false);
    expect(isUnresolvedKind("aws:somewhere/unwritten:Unwritten")).toBe(true);
  });
});

describe("referenceProps", () => {
  test("keeps inputs and top-level string outputs, and the id under outputs", () => {
    expect(
      referenceProps({
        type: "aws:ec2/subnet:Subnet",
        id: "subnet-1",
        inputs: { __defaults: ["x"], vpcId: "vpc-1", tags: { Name: "a" } },
        outputs: { arn: "arn:aws:ec2:::subnet/subnet-1", cidrBlock: "10.0.0.0/24", tags: { Name: "a" }, ipv6Native: false },
      }),
    ).toEqual({ vpcId: "vpc-1", tags: { Name: "a" }, outputs: { id: "subnet-1", arn: "arn:aws:ec2:::subnet/subnet-1", cidrBlock: "10.0.0.0/24" } });
  });

  test("leaves out secret envelopes, credential-like keys, long strings and a Kubernetes Secret's data", () => {
    const sig = { "4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", ciphertext: "v1:x" };
    const props = referenceProps({
      type: "aws:rds/instance:Instance",
      id: "db-1",
      inputs: { username: "admin", password: "plain", masterPassword: sig, secretArn: "arn:aws:secretsmanager:::secret:s", userData: "#!/bin/sh", policy: "x".repeat(2000), dbSubnetGroupName: "main" },
      outputs: { endpoint: "db.example.com", password: "plain", token: sig },
    });
    expect(props).toEqual({ username: "admin", secretArn: "arn:aws:secretsmanager:::secret:s", dbSubnetGroupName: "main", outputs: { id: "db-1", endpoint: "db.example.com" } });
    expect(
      referenceProps({ type: "kubernetes:core/v1:Secret", id: "ci/token", inputs: { metadata: { name: "token", namespace: "ci" }, stringData: { value: "hunter2" }, data: { value: "aHVudGVyMg==" } }, outputs: { data: { value: "aHVudGVyMg==" } } }),
    ).toEqual({ metadata: { name: "token", namespace: "ci" }, outputs: { id: "ci/token" } });
  });
});

describe("the three-cloud aws stack export through the catalog pass", () => {
  const dir = join(import.meta.dirname, "testdata", "three-cloud-aws");
  const read = readPulumiMember({ member: { dir, label: "aws" } });
  const ir = buildGraphIr(read.entities);
  const pulumiNodes: ComposedNode[] = ir.nodes.map((n) => ({ ...n, id: `aws/${n.id}`, lexicon: LEXICON, member: "aws" }));
  const node = (kindPart: string) => pulumiNodes.find((n) => n.kind.includes(kindPart))!;

  const tf = (address: string, body: Record<string, unknown>): ComposedNode => ({
    id: `tf/r/${address}`,
    kind: "Terraform::Resource",
    lexicon: "terraform",
    member: "tf",
    attrs: { address, type: address.split(".")[0], name: address.split(".")[1], body, source: "main.tf" },
  });
  const k8s = (kind: string, name: string, namespace?: string): ComposedNode => ({
    id: `k8s/${kind}-${namespace ?? "cluster"}-${name}`,
    kind,
    lexicon: "k8s",
    member: "k8s",
    attrs: { metadata: { name, ...(namespace ? { namespace } : {}) } },
  });

  const run = (extra: ComposedNode[]) =>
    runCatalogPass(
      [...pulumiNodes, ...extra],
      [
        { lexicon: LEXICON, catalog: PULUMI_REFERENCE_CATALOG },
        { lexicon: "terraform", catalog: TERRAFORM_REFERENCE_CATALOG },
        { lexicon: "k8s", catalog: k8sReferenceCatalog },
      ],
    );
  const lines = (out: ReturnType<typeof run>) => out.edges.filter((e) => e.rule?.startsWith("pulumi:")).map((e) => `${e.from.replace("aws/", "")} -> ${e.to.replace("aws/", "")} [${e.viaAttr}]`);

  test("draws edges between pulumi resources by ARN, id and name", () => {
    const out = run([]);
    const edges = lines(out);
    const id = (kind: string) => node(kind).id.replace("aws/", "");
    expect(edges).toContain(`${id("ecs/service:Service")} -> ${id("ecs/cluster:Cluster")} [cluster]`);
    expect(edges).toContain(`${id("ecs/service:Service")} -> ${id("ecs/taskDefinition:TaskDefinition")} [taskDefinition]`);
    expect(edges).toContain(`${id("ecs/service:Service")} -> ${id("ec2/securityGroup:SecurityGroup")} [networkConfiguration]`);
    expect(edges).toContain(`${id("ecs/taskDefinition:TaskDefinition")} -> ${id("iam/role:Role")} [taskRoleArn]`);
    expect(edges).toContain(`${id("iam/rolePolicyAttachment:RolePolicyAttachment")} -> ${id("iam/role:Role")} [role]`);
    expect(out.containment.map((c) => `${c.child} -> ${c.parent}`)).toContain(`${node("ec2/subnet:Subnet").id} -> ${node("ec2/vpc:Vpc").id}`);
  });

  test("a container's env value that names a bucket draws an edge to it", () => {
    expect(lines(run([]))).toContain(`${node("apps/v1:Deployment").id.replace("aws/", "")} -> ${node("bucketV2:BucketV2").id.replace("aws/", "")} [spec]`);
  });

  test("draws an edge to a terraform member's cluster by name", () => {
    const cluster = tf("aws_eks_cluster.prod", { name: "prod-eks" });
    expect(lines(run([cluster]))).toContain(`${node("eks/nodeGroup:NodeGroup").id.replace("aws/", "")} -> ${cluster.id} [clusterName]`);
  });

  test("draws edges to a k8s member's ServiceAccount, in the Deployment's namespace only, and to its Namespace", () => {
    const sa = k8s("K8s::Core::ServiceAccount", "runner", "ci");
    const elsewhere = k8s("K8s::Core::ServiceAccount", "runner", "other");
    const ns = k8s("K8s::Core::Namespace", "ci");
    const edges = lines(run([sa, elsewhere, ns]));
    const deployment = node("apps/v1:Deployment").id.replace("aws/", "");
    expect(edges).toContain(`${deployment} -> ${sa.id} [spec]`);
    expect(edges).not.toContain(`${deployment} -> ${elsewhere.id} [spec]`);
    expect(run([sa, ns]).containment.map((c) => `${c.child} -> ${c.parent}`)).toContain(`${node("apps/v1:Deployment").id} -> ${ns.id}`);
  });

  test("a name in two namespaces of one name is not ambiguous for a holder that names its namespace", () => {
    const out = run([k8s("K8s::Core::ServiceAccount", "runner", "ci"), k8s("K8s::Core::ServiceAccount", "runner", "other")]);
    expect(out.ambiguous).toEqual([]);
  });

  test("lists a ServiceAccount no member declares as dangling", () => {
    const out = run([]);
    expect(out.dangling).toContainEqual(expect.objectContaining({ from: node("apps/v1:Deployment").id, value: "runner", targetKind: "kubernetes:core/v1:ServiceAccount" }));
  });

  test("copies no secret into a node", () => {
    const text = JSON.stringify(ir);
    expect(text).not.toContain("ciphertext");
    expect(text).not.toContain("hunter2");
  });
});
