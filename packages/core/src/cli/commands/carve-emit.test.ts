import { describe, test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carveEmit, formatCarveEmit } from "./carve-emit";
import { loadHcl2json } from "../../terraform/parse";
import { listCarveManifests } from "../../terraform/manifest";
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
resource "kubernetes_config_map" "demo" {
  metadata { name = "demo-config" }
}
`;

// A state file for the bucket, so the --state path reaches the same gate the
// --env path does rather than stopping at "not found in state".
const TFSTATE = JSON.stringify({
  version: 4,
  resources: [
    {
      mode: "managed",
      type: "kubernetes_config_map",
      name: "demo",
      instances: [{ attributes: { id: "default/demo-config" } }],
    },
  ],
});

async function withEstate<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chant-carve-emit-"));
  try {
    writeFileSync(join(dir, "main.tf"), ESTATE);
    writeFileSync(join(dir, "terraform.tfstate"), TFSTATE);
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

  test("a failed live import fails the emit and writes no carve manifest (#2015)", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      const li = vi.fn(
        async (_p: LexiconPlugin[], _o: LiveImportOptions): Promise<ImportResult> => ({
          success: false,
          generatedFiles: [],
          warnings: [],
          error: "no stack in prod exports AWS::S3::Bucket",
        }),
      );
      const res = await carveEmit(
        { from: dir, select: "aws_s3_bucket.assets", env: "prod", output: out },
        { plugins: noPlugins, liveImport: li },
      );

      expect(res.ok).toBe(false);
      expect(res.error).toContain("no stack in prod exports AWS::S3::Bucket");
      expect(res.manifestPath).toBeUndefined();
      // Bridge/apply compose from the manifest; one written here would make
      // bridge excise a `.tf` block for a resource that was never emitted.
      expect(listCarveManifests(out)).toEqual([]);
      expect(existsSync(out)).toBe(false);
      // No false "Adopted live" line on the failure path.
      expect(formatCarveEmit(res)).not.toContain("Adopted live");
    });
  });

  test("a type emit cannot carve is refused identically on --state and --env (#2015)", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const li = fakeImport();
      const live = await carveEmit(
        { from: dir, select: "kubernetes_config_map.demo", env: "prod" },
        { plugins: noPlugins, liveImport: li },
      );
      const state = await carveEmit(
        { from: dir, select: "kubernetes_config_map.demo", statePath: join(dir, "terraform.tfstate") },
        { plugins: noPlugins, liveImport: li },
      );

      expect(live.ok).toBe(false);
      expect(state.ok).toBe(false);
      expect(live.error).toBe(state.error);
      expect(live.error).toContain("kubernetes_config_map cannot be emitted yet");
      // advise ranks it (tier 2), so it gets past resolveTier — the emit gate
      // is what refuses it, before the AWS exporter is ever reached.
      expect(li).not.toHaveBeenCalled();
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
