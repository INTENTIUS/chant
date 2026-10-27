/**
 * Pulumi URN to graph node (#4456): the stack-export render and a change set
 * over `pulumi preview --json` put each resource of one program on the same
 * node. The fixtures in `testdata/pulumi-urn-node` are recorded (#4475, see its
 * README): an export of the plunge corpus's aws-ts stack on floci and a
 * `preview --json --show-sames` of a change to it, pulumi 3.272.0. Nothing
 * here runs Pulumi.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pulumiNodeCandidates, pulumiNodeKey, pulumiPreviewNodes } from "@intentius/chant/pulumi-urn";
import { readPulumiMember } from "./workspace-member";

const dir = join(import.meta.dirname, "testdata", "pulumi-urn-node");
const preview = JSON.parse(readFileSync(join(dir, "preview.json"), "utf-8")) as unknown;
const exported = (JSON.parse(readFileSync(join(dir, "stack-export.json"), "utf-8")) as { deployment: { resources: { urn: string; type: string }[] } })
  .deployment.resources;

/** The node ids the export's render gives, without the workspace in front. */
function renderedIds(): Set<string> {
  return new Set(readPulumiMember({ member: { dir, label: "site" } }).entities.keys());
}

const urn = (type: string, name: string) => `urn:pulumi:floci::corpus-aws-ts::${type}::${name}`;

describe("Pulumi URN to graph node (#4456)", () => {
  test("every resource in both the export and the preview maps to the same node", () => {
    const ids = renderedIds();
    const byUrn = new Map<string, Set<string | null>>();
    for (const s of pulumiPreviewNodes(preview, "site")) {
      if (!byUrn.has(s.urn)) byUrn.set(s.urn, new Set());
      byUrn.get(s.urn)!.add(s.node);
    }
    // The preview lists every resource the export holds but the default provider, which preview --json never prints.
    const missing = exported.filter((r) => !byUrn.has(r.urn)).map((r) => r.urn);
    expect(missing).toEqual([expect.stringMatching(/::pulumi:providers:aws::default_/)]);
    for (const r of exported.filter((x) => byUrn.has(x.urn))) {
      const fromPreview = [...byUrn.get(r.urn)!];
      expect(fromPreview, r.urn).toHaveLength(1);
      const node = fromPreview[0];
      if (node === null) {
        // A provider or the stack: the render has no node for it either.
        expect(ids.has(`site/${r.urn.split("::").slice(2).join("::")}`), r.urn).toBe(false);
      } else {
        expect(ids.has(node), `${r.urn} -> ${node}`).toBe(true);
      }
    }
  });

  test("the nodes: the URN tail under the member, providers and the stack on none", () => {
    expect(pulumiPreviewNodes(preview, "site").map((s) => `${s.op} ${s.node}`)).toEqual([
      "same null",
      "same site/corpus:index:Site::docs",
      "same null",
      "replace site/aws:ec2/vpc:Vpc::main",
      "same site/aws:iam/role:Role::app-role",
      "update site/aws:sqs/queue:Queue::events",
      "update site/aws:ssm/parameter:Parameter::db-password",
      "same site/aws:s3/bucket:Bucket::site-bucket",
      "same site/aws:sqs/queue:Queue::worker-1",
      "same site/aws:sqs/queue:Queue::worker-0",
      "same site/corpus:index:Site$aws:s3/bucket:Bucket::docs-assets",
      "same site/corpus:index:Site$aws:sns/topic:Topic::docs-notify",
      "replace site/aws:ec2/securityGroup:SecurityGroup::app-sg",
      "same site/aws:sns/topic:Topic::alerts-west",
      "same site/aws:s3/bucketPolicy:BucketPolicy::site-bucket-policy",
      "delete site/aws:sqs/queue:Queue::worker-2",
      "delete site/aws:ssm/parameter:Parameter::vpc-id",
    ]);
    // Every custom resource and the component, the stack and the two providers left out.
    expect(renderedIds().size).toBe(15);
  });

  test("a resource the export does not hold has an id the graph lacks", () => {
    const ids = renderedIds();
    expect(ids.has("site/aws:sqs/queue:Queue::worker-3")).toBe(false);
    expect(ids.has("site/aws:sqs/queue:Queue::worker-2")).toBe(true);
  });

  test("a child nests under its component through the parent edge", () => {
    const { entities } = readPulumiMember({ member: { dir, label: "site" } });
    const refs = (key: string) => (entities.get(key) as unknown as { references: { to: string; viaAttr: string }[] }).references;
    expect(refs("site/corpus:index:Site$aws:s3/bucket:Bucket::docs-assets")).toContainEqual({ to: "site/corpus:index:Site::docs", viaAttr: "parent", grain: "instance" });
    expect(refs("site/aws:s3/bucket:Bucket::site-bucket").filter((r) => r.viaAttr === "parent")).toEqual([]);
  });

  test("the key ignores the stack and the project", () => {
    const at = (stack: string, project: string) => `urn:pulumi:${stack}::${project}::corpus:index:Site$aws:s3/bucket:Bucket::docs-assets`;
    expect(pulumiNodeKey(at("floci", "corpus-aws-ts"))).toBe(pulumiNodeKey(at("prod", "other")));
    expect(pulumiNodeKey(urn("aws:s3/bucket:Bucket", "a::b"))).toBe("aws:s3/bucket:Bucket::a::b");
    expect(pulumiNodeCandidates({ member: "site", address: "urn:pulumi:floci::corpus-aws-ts::corpus:index:Site$pulumi:providers:aws::east" })).toEqual([]);
  });
});
