import { describe, test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carveEmit, formatCarveEmit } from "./carve-emit";
import { loadHcl2json } from "../../terraform/parse";
import type { ImportResult, LiveImportOptions } from "./import";
import type { LexiconPlugin } from "../../lexicon";

let parserAvailable = false;
try {
  await loadHcl2json();
  parserAvailable = true;
} catch {
  parserAvailable = false;
}

const ESTATE = `
resource "aws_s3_bucket" "assets" {
  bucket = "myapp-assets-prod"
}
resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_lambda_function" "api" {
  function_name = "myapp-api"
  environment {
    variables = {
      ASSETS_BUCKET = aws_s3_bucket.assets.bucket
      ASSETS_ARN    = aws_s3_bucket.assets.arn
    }
  }
}
resource "random_pet" "suffix" {
  length = 2
}
`;

async function withEstate<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chant-carve-emit-"));
  try {
    writeFileSync(join(dir, "main.tf"), ESTATE);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fakeImport = (files: string[] = ["infra/assets.ts"]) =>
  vi.fn(
    async (_plugins: LexiconPlugin[], _options: LiveImportOptions): Promise<ImportResult> => ({
      success: true,
      generatedFiles: files,
      warnings: [],
      lexicon: "aws",
    }),
  );

const noPlugins: LexiconPlugin[] = [];

describe("carveEmit — validation", () => {
  test("requires --from, --select, --env", async () => {
    const li = fakeImport();
    expect((await carveEmit({}, { plugins: noPlugins, liveImport: li })).error).toContain("--from");
    expect((await carveEmit({ from: "/x" }, { plugins: noPlugins, liveImport: li })).error).toContain("--select");
    expect(li).not.toHaveBeenCalled();
  });
});

describe("carveEmit — emit + boundary", () => {
  test("adopts the selected resource with a native selector and reports the boundary", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const li = fakeImport(["infra/assets.ts"]);
      const reportFile = join(dir, "carveout-report.json");
      const res = await carveEmit(
        { from: dir, select: "aws_s3_bucket.assets", env: "prod", reportFile },
        { plugins: noPlugins, liveImport: li },
      );

      expect(res.ok).toBe(true);
      // Live selector is by native type: the CFN import filters by logical id,
      // which is not the Terraform physical name, so name is not passed here.
      expect(res.selector).toEqual({ type: "AWS::S3::Bucket" });
      expect(li).toHaveBeenCalledOnce();
      expect(li.mock.calls[0][1]).toMatchObject({
        environment: "prod",
        selector: { type: "AWS::S3::Bucket" },
      });

      // Boundary: one inbound edge from the Lambda; versioning folded away.
      expect(res.report!.inbound).toHaveLength(1);
      expect(res.report!.inbound[0].survivor).toBe("aws_lambda_function.api");
      expect(res.report!.outbound).toHaveLength(0);

      // Report written to disk.
      const written = JSON.parse(readFileSync(reportFile, "utf-8"));
      expect(written.target).toBe("aws_s3_bucket.assets");
      expect(written.reversible).toBe(true);
    });
  });

  test("refuses to emit an unsupported type (no native mapping)", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const li = fakeImport();
      const res = await carveEmit(
        { from: dir, select: "random_pet.suffix", env: "prod" },
        { plugins: noPlugins, liveImport: li },
      );
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/no known native mapping/i);
      expect(li).not.toHaveBeenCalled(); // never adopts something it can't map
    });
  });

  test("errors when the address is not in the estate", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const res = await carveEmit(
        { from: dir, select: "aws_s3_bucket.nope", env: "prod" },
        { plugins: noPlugins, liveImport: fakeImport() },
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("not found");
    });
  });

  test("formatCarveEmit describes the adoption and the pending boundary work", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const res = await carveEmit(
        { from: dir, select: "aws_s3_bucket.assets", env: "prod" },
        { plugins: noPlugins, liveImport: fakeImport(["infra/assets.ts"]) },
      );
      const text = formatCarveEmit(res);
      expect(text).toContain("observe position, reversible");
      expect(text).toContain("Adopted live as AWS::S3::Bucket");
      expect(text).toContain("inbound");
      expect(text).toContain("carve bridge"); // points at the next step
    });
  });

  test("--live-name narrows the live selector to a CFN logical id", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const li = fakeImport(["infra/assets.ts"]);
      const res = await carveEmit(
        { from: dir, select: "aws_s3_bucket.assets", env: "prod", liveName: "AssetsBucket" },
        { plugins: noPlugins, liveImport: li },
      );
      expect(res.ok).toBe(true);
      expect(res.selector).toEqual({ type: "AWS::S3::Bucket", name: "AssetsBucket" });
      expect(formatCarveEmit(res)).toContain('logical id "AssetsBucket"');
    });
  });
});
