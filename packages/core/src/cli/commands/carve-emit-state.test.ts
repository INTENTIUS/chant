import { describe, test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carveEmit, formatCarveEmit } from "./carve-emit";
import { loadHcl2json } from "../../terraform/parse";
import type { ImportResult, LiveImportOptions } from "./import";
import type { LexiconPlugin } from "../../lexicon";

/**
 * Real (non-faked) adoption from `.tfstate` — #1009. A Terraform-managed
 * resource is not in any CloudFormation stack, so the live (CFN) import path
 * cannot adopt it; its resolved shape lives in the state file. This exercises
 * the offline state-adoption path end to end with real state data. Skips only
 * if the wasm parser (for the boundary report) is absent.
 */
let parserAvailable = false;
try {
  await loadHcl2json();
  parserAvailable = true;
} catch {
  parserAvailable = false;
}

const ESTATE = `
resource "aws_s3_bucket" "assets" { bucket = "myapp-assets-prod" }
resource "aws_lambda_function" "api" {
  environment { variables = { B = aws_s3_bucket.assets.bucket } }
}
`;

// A realistic terraform.tfstate v4 with the bucket's resolved attributes.
const TFSTATE = JSON.stringify({
  version: 4,
  terraform_version: "1.7.0",
  resources: [
    {
      mode: "managed",
      type: "aws_s3_bucket",
      name: "assets",
      provider: 'provider["registry.terraform.io/hashicorp/aws"]',
      instances: [
        {
          attributes: {
            id: "myapp-assets-prod",
            bucket: "myapp-assets-prod",
            arn: "arn:aws:s3:::myapp-assets-prod",
            tags: { Team: "web", Env: "prod" },
            force_destroy: false,
          },
        },
      ],
    },
  ],
});

// The live-import fake must never be called on the state path.
const liveImport = vi.fn(
  async (_p: LexiconPlugin[], _o: LiveImportOptions): Promise<ImportResult> => ({
    success: true,
    generatedFiles: [],
    warnings: [],
  }),
);

async function withEstate<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chant-emit-state-"));
  try {
    writeFileSync(join(dir, "main.tf"), ESTATE);
    writeFileSync(join(dir, "terraform.tfstate"), TFSTATE);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("carve emit --state (real adoption from tfstate)", () => {
  test("emits native chant source from real state attributes, no cloud call", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      const res = await carveEmit(
        { from: dir, select: "aws_s3_bucket.assets", statePath: join(dir, "terraform.tfstate"), output: out },
        { plugins: [], liveImport },
      );

      expect(res.ok).toBe(true);
      expect(res.source).toBe("tfstate");
      expect(liveImport).not.toHaveBeenCalled(); // offline — no cloud

      // A real .ts file with the native constructor + props from real state.
      expect(res.emittedFiles).toEqual([join(out, "assets.ts")]);
      const emitted = readFileSync(res.emittedFiles![0], "utf-8");
      expect(emitted).toContain("new Bucket({");
      expect(emitted).toContain('BucketName: "myapp-assets-prod"');
      expect(emitted).toContain("Adopted from Terraform state");

      // Boundary still classified (the Lambda inbound).
      expect(res.report!.inbound.map((e) => e.survivor)).toEqual(["aws_lambda_function.api"]);

      const text = formatCarveEmit(res);
      expect(text).toContain("Adopted from Terraform state (offline)");
    });
  });

  test("without --state or --env it explains both adoption sources", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const res = await carveEmit({ from: dir, select: "aws_s3_bucket.assets" }, { plugins: [], liveImport });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/--state .*or --env/);
    });
  });
});
