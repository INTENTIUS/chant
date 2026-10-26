/**
 * The shipped pulumi example reads its member (#4468): `chant dev
 * check-lexicon` builds it, and this asserts what the build read, the two
 * resources of `infra/stack-export.json` with the edge between them, and
 * that the member report has no finding for PUL001 or PUL002.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pulumiPlugin } from "../src/plugin";
import { lastMemberReport } from "../src/workspace-member";

const example = join(import.meta.dirname, "workspace-member");

describe("pulumi examples", () => {
  it("workspace-member reads infra/ relative to the project root", async () => {
    const roots = await pulumiPlugin.buildRoots!({
      projectRoot: example,
      config: { pulumi: { member: { dir: "./infra", label: "infra" } } },
    } as never);
    expect([...roots.entities.keys()].sort()).toEqual([
      "infra/aws:s3/bucketV2:BucketV2::assets",
      "infra/aws:s3/bucketVersioningV2:BucketVersioningV2::assetsVersioning",
    ]);
    const versioning = roots.entities.get("infra/aws:s3/bucketVersioningV2:BucketVersioningV2::assetsVersioning") as unknown as {
      references: { to: string }[];
    };
    expect(versioning.references.map((r) => r.to)).toEqual(["infra/aws:s3/bucketV2:BucketV2::assets"]);
    expect(lastMemberReport()).toEqual({ export: "stack-export.json", objects: 2, exported: true });
  });
});
