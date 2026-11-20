/**
 * The pulumi lexicon's reference catalog through `chant workspace graph
 * --discover` end to end (#5330), on a workspace shaped like behold's
 * example-three-cloud: a pulumi member `aws` (a stack export), a terraform
 * member `tf` and a manifests member `k8s`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, scratchDir, writeFiles } from "../../../packages/core/src/workspace/__fixtures__/contract-repo";
import { CACHE_DIR_ENV } from "../../../packages/core/src/workspace/graph-cache";
import { workspaceGraph, type GraphDocument } from "../../../packages/core/src/workspace/graph-cli";

const TIMEOUT = 240_000;
const fixture = join(import.meta.dirname, "testdata", "three-cloud-aws");

let cacheBefore: string | undefined;
beforeAll(() => {
  cacheBefore = process.env[CACHE_DIR_ENV];
  process.env[CACHE_DIR_ENV] = scratchDir("chant-pulumi-cat-cache-");
});
afterAll(() => {
  if (cacheBefore === undefined) delete process.env[CACHE_DIR_ENV];
  else process.env[CACHE_DIR_ENV] = cacheBefore;
  cleanScratch();
});

const FX = {
  "aws/Pulumi.yaml": readFileSync(join(fixture, "Pulumi.yaml"), "utf-8"),
  "aws/stack-export.json": readFileSync(join(fixture, "stack-export.json"), "utf-8"),
  "tf/main.tf": ['resource "aws_eks_cluster" "prod" {', '  name     = "prod-eks"', '  role_arn = "arn:aws:iam::111122223333:role/eks"', "}", ""].join("\n"),
  "k8s/manifests.yaml": [
    "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ci\n",
    "apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: runner\n  namespace: ci\n",
  ].join("---\n"),
};

function result(doc: GraphDocument): Extract<GraphDocument, { nodes: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

describe("workspace graph: pulumi catalog edges (#5330)", () => {
  test(
    "draws edges between pulumi resources and to terraform and k8s members, and copies no secret",
    async () => {
      const root = scratchDir("chant-pulumi-cat-fx-");
      writeFiles(root, FX);
      const { doc, failed } = await workspaceGraph({ cwd: root, discover: true, noCache: false, catalog: true });
      const g = result(doc);
      expect(failed).toBe(false);

      // A pulumi node is `<member>/<label>/<type>::<name>` in the document.
      const tail = (id: string) => id.replace(/^aws\/aws\//, "");
      const derived = g.edges.filter((e) => e.origin === "derived" && e.rule?.startsWith("pulumi:"));
      const lines = derived.map((e) => `${tail(e.from)} -> ${tail(e.to)} [${e.viaAttr}]`);
      // Between pulumi resources: an ARN, a name and an id. The subnet's VPC is containment, so a box and not a line.
      expect(lines).toContain("aws:ecs/service:Service::web -> aws:ecs/cluster:Cluster::cluster [cluster]");
      expect(lines).toContain("aws:iam/rolePolicyAttachment:RolePolicyAttachment::web-logs -> aws:iam/role:Role::web [role]");
      expect(lines).toContain("aws:ecs/service:Service::web -> aws:ec2/securityGroup:SecurityGroup::service [networkConfiguration]");
      const vpc = g.nodes.find((n) => n.kind === "aws:ec2/vpc:Vpc")!.id;
      const subnet = g.nodes.find((n) => n.kind === "aws:ec2/subnet:Subnet")!.id;
      expect(g.groups.byContainer?.[vpc]).toContain(subnet);
      // To the terraform member.
      const eks = g.nodes.find((n) => n.member === "tf" && n.id.endsWith("aws_eks_cluster.prod"))!.id;
      expect(lines).toContain(`aws:eks/nodeGroup:NodeGroup::nodes -> ${eks} [clusterName]`);
      // To the k8s member.
      const sa = g.nodes.find((n) => n.kind === "K8s::Core::ServiceAccount")!.id;
      const ns = g.nodes.find((n) => n.kind === "K8s::Core::Namespace")!.id;
      expect(lines).toContain(`kubernetes:apps/v1:Deployment::api -> ${sa} [spec]`);
      expect(lines).toContain(`kubernetes:apps/v1:Deployment::api -> ${ns} [metadata]`);
      expect(derived.every((e) => e.grain === "property")).toBe(true);

      const text = JSON.stringify(g);
      expect(text).not.toContain("ciphertext");
      expect(text).not.toContain("hunter2");
    },
    TIMEOUT,
  );
});
