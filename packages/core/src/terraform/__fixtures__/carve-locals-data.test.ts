import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carveAdvise, carveJson } from "../../cli/commands/carve";
import { carveBridge } from "../../cli/commands/carve-bridge";
import { loadHcl2json } from "../parse";

/**
 * The three-route estate from the blast-radius spike (#2324), through the real
 * wasm parser: one bucket with three dependents, one reading it directly, one
 * through a `locals` block and one through a `data` source. The advisor used to
 * report a single dependent and band the bucket a clean leaf, and `carve bridge`
 * left the other two routes pointing at a resource Terraform no longer manages.
 *
 * Skips cleanly when the optional parser is absent, like the other estate tests.
 */
let parserAvailable = false;
try {
  await loadHcl2json();
  parserAvailable = true;
} catch {
  parserAvailable = false;
}

const ESTATE = `resource "aws_s3_bucket" "assets" {
  bucket = "app-assets"
}

locals {
  assets_id = aws_s3_bucket.assets.id
}

resource "aws_lambda_function" "via_local" {
  function_name = "via-local"
  environment { variables = { B = local.assets_id } }
}

data "aws_s3_bucket" "lookup" {
  bucket = aws_s3_bucket.assets.bucket
}

resource "aws_lambda_function" "via_data" {
  function_name = "via-data"
  environment { variables = { B = data.aws_s3_bucket.lookup.arn } }
}

resource "aws_lambda_function" "direct" {
  function_name = "direct"
  environment { variables = { B = aws_s3_bucket.assets.arn } }
}
`;

/**
 * The same estate with the direct reference taken out, so every remaining route
 * to the bucket runs through a referrer. This is the case that actually breaks:
 * with no direct reference the advisor found no inbound edge at all, so
 * `carve bridge` generated no data source and rewrote nothing, and the excised
 * bucket left two dangling references behind.
 */
const INDIRECT_ONLY = ESTATE.split('resource "aws_lambda_function" "direct"')[0];

async function withEstate<T>(source: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chant-2324-"));
  try {
    writeFileSync(join(dir, "main.tf"), source);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("dependencies reached through locals and data blocks", () => {
  test("the advisor counts all three dependents, not just the direct one", async () => {
    if (!parserAvailable) return;
    await withEstate(ESTATE, async (dir) => {
      const report = carveJson(await carveAdvise({ from: dir }));
      const bucket = report.resources.find((r) => r.address === "aws_s3_bucket.assets")!;

      expect(bucket.breakdown.inbound).toBe(3);
      expect(bucket.boundary!.inbound.map((e) => e.survivor)).toEqual([
        "aws_lambda_function.direct",
        "aws_lambda_function.via_data",
        "aws_lambda_function.via_local",
      ]);

      // Three dependents at -12 each: no longer the top band on a third of the truth.
      expect(bucket.score).toBe(64);
      expect(bucket.band).toBe("carvable w/ edits");
    });
  });

  test("carve bridge rewires the locals and data routes, not only the direct one", async () => {
    if (!parserAvailable) return;
    await withEstate(ESTATE, async (dir) => {
      const bridge = await carveBridge({
        from: dir,
        select: "aws_s3_bucket.assets",
        output: join(dir, "carveout"),
      });
      expect(bridge.ok).toBe(true);

      const rewritten = bridge.plan!.rewrites.find((r) => r.changed)!.rewritten;
      // Every reference to the carved bucket now goes through the data source...
      expect(rewritten).toContain("assets_id = data.aws_s3_bucket.assets.id");
      expect(rewritten).toContain("bucket = data.aws_s3_bucket.assets.bucket");
      expect(rewritten).toContain("B = data.aws_s3_bucket.assets.arn");
      expect(rewritten).not.toMatch(/(?<!data\.)aws_s3_bucket\.assets\./);
      // ...and the carved block itself is gone, so the next apply cannot re-create it.
      expect(bridge.plan!.excised).toEqual(["aws_s3_bucket.assets"]);

      // The two indirect readers are untouched: their own references were never
      // to the bucket, and the referrers they read through still resolve.
      expect(rewritten).toContain("B = local.assets_id");
      expect(rewritten).toContain("B = data.aws_s3_bucket.lookup.arn");
    });
  });

  test("an estate whose only routes are indirect still gets a data source and a rewrite", async () => {
    if (!parserAvailable) return;
    await withEstate(INDIRECT_ONLY, async (dir) => {
      const bridge = await carveBridge({
        from: dir,
        select: "aws_s3_bucket.assets",
        output: join(dir, "carveout"),
      });
      expect(bridge.ok).toBe(true);

      // Without an inbound edge there is no data source to rewrite references
      // to, and the excised bucket leaves the locals and data bodies dangling.
      expect(bridge.plan!.dataSources.map((d) => d.address)).toEqual(["aws_s3_bucket.assets"]);
      const rewritten = bridge.plan!.rewrites.find((r) => r.changed)!.rewritten;
      expect(rewritten).toContain("assets_id = data.aws_s3_bucket.assets.id");
      expect(rewritten).toContain("bucket = data.aws_s3_bucket.assets.bucket");
      expect(rewritten).not.toMatch(/(?<!data\.)aws_s3_bucket\.assets\./);
    });
  });
});
