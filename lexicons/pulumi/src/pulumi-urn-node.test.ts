/**
 * Pulumi URN to graph node (#4456): the stack-export render and a change set
 * over `pulumi preview --json` put each resource of one program on the same
 * node. The fixtures in `testdata/pulumi-urn-node` are an export and a preview
 * of the same stack; nothing here runs Pulumi.
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

describe("Pulumi URN to graph node (#4456)", () => {
  test("every resource in both the export and the preview maps to the same node", () => {
    const ids = renderedIds();
    const byUrn = new Map<string, Set<string | null>>();
    for (const s of pulumiPreviewNodes(preview, "site")) {
      if (!byUrn.has(s.urn)) byUrn.set(s.urn, new Set());
      byUrn.get(s.urn)!.add(s.node);
    }
    const both = exported.filter((r) => byUrn.has(r.urn));
    expect(both.length).toBe(exported.length);
    for (const r of both) {
      const fromPreview = [...byUrn.get(r.urn)!];
      // A replace is three steps on one URN; all three land on one node.
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
      "same null",
      "update site/aws:s3/bucket:Bucket::assets",
      "same site/my:web:Site::site",
      "same null",
      "same site/my:web:Site$aws:s3/bucketPolicy:BucketPolicy::site-policy",
      "same site/my:web:Site$my:web:Cdn::site-cdn",
      "create-replacement site/my:web:Site$my:web:Cdn$aws:cloudfront/distribution:Distribution::site-cdn",
      "replace site/my:web:Site$my:web:Cdn$aws:cloudfront/distribution:Distribution::site-cdn",
      "create site/my:web:Site$aws:route53/record:Record::site-alias",
      "delete-replaced site/my:web:Site$my:web:Cdn$aws:cloudfront/distribution:Distribution::site-cdn",
      "delete site/aws:iam/role:Role::old-deployer",
    ]);
    expect([...renderedIds()].sort()).toEqual([
      "site/aws:iam/role:Role::old-deployer",
      "site/aws:s3/bucket:Bucket::assets",
      "site/my:web:Site$aws:s3/bucketPolicy:BucketPolicy::site-policy",
      "site/my:web:Site$my:web:Cdn$aws:cloudfront/distribution:Distribution::site-cdn",
      "site/my:web:Site$my:web:Cdn::site-cdn",
      "site/my:web:Site::site",
    ]);
  });

  test("a create the export does not hold yet has an id the graph lacks, so a mapped entry gets node: null", () => {
    const ids = renderedIds();
    const create = pulumiPreviewNodes(preview, "site").find((s) => s.op === "create")!;
    expect(ids.has(create.node!)).toBe(false);
  });

  test("a child nests under its component through the parent edge", () => {
    const { entities } = readPulumiMember({ member: { dir, label: "site" } });
    const refs = (key: string) => (entities.get(key) as unknown as { references: { to: string; viaAttr: string }[] }).references;
    const cdn = refs("site/my:web:Site$my:web:Cdn$aws:cloudfront/distribution:Distribution::site-cdn");
    expect(cdn).toContainEqual({ to: "site/my:web:Site$my:web:Cdn::site-cdn", viaAttr: "parent" });
    expect(refs("site/aws:s3/bucket:Bucket::assets").filter((r) => r.viaAttr === "parent")).toEqual([]);
  });

  test("the key ignores the stack and the project", () => {
    const urn = (stack: string, project: string) => `urn:pulumi:${stack}::${project}::my:web:Site$aws:s3/bucketPolicy:BucketPolicy::site-policy`;
    expect(pulumiNodeKey(urn("dev", "site"))).toBe(pulumiNodeKey(urn("prod", "other")));
    expect(pulumiNodeKey("urn:pulumi:dev::site::aws:s3/bucket:Bucket::a::b")).toBe("aws:s3/bucket:Bucket::a::b");
    expect(pulumiNodeCandidates({ member: "site", address: "urn:pulumi:dev::site::my:web:Site$pulumi:providers:aws::east" })).toEqual([]);
  });
});
