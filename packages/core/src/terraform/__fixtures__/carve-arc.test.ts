import { describe, test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carveEmit } from "../../cli/commands/carve-emit";
import { carveBridge } from "../../cli/commands/carve-bridge";
import { carveApply } from "../../cli/commands/carve-apply";
import { loadHcl2json } from "../parse";
import type { ImportResult, LiveImportOptions } from "../../cli/commands/import";
import type { LexiconPlugin } from "../../lexicon";

/**
 * End-to-end: one resource through the whole strangler-fig arc — emit → bridge
 * → apply — on a single estate, asserting the steps compose. Live import is
 * faked (no cloud). Skips when the wasm parser is absent.
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
resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_lambda_function" "api" {
  function_name = "myapp-api"
  environment { variables = { B = aws_s3_bucket.assets.bucket, A = aws_s3_bucket.assets.arn } }
}
`;

const fakeImport = vi.fn(
  async (_p: LexiconPlugin[], _o: LiveImportOptions): Promise<ImportResult> => ({
    success: true,
    generatedFiles: ["infra/assets.ts"],
    warnings: [],
    lexicon: "aws",
  }),
);

describe("carve arc: emit → bridge → apply", () => {
  test("carries aws_s3_bucket.assets from Terraform to chant-owned", async () => {
    if (!parserAvailable) return;
    const dir = mkdtempSync(join(tmpdir(), "chant-arc-"));
    try {
      writeFileSync(join(dir, "main.tf"), ESTATE);
      const sel = "aws_s3_bucket.assets";

      // 1. emit: adopt + boundary (Lambda inbound; versioning folded).
      const emit = await carveEmit({ from: dir, select: sel, env: "prod" }, { plugins: [], liveImport: fakeImport });
      expect(emit.ok).toBe(true);
      expect(emit.selector).toEqual({ type: "AWS::S3::Bucket", name: "myapp-assets-prod" });
      expect(emit.report!.inbound.map((e) => e.survivor)).toEqual(["aws_lambda_function.api"]);

      // 2. bridge: data source + rewired survivor (dry-run).
      const out = join(dir, "carveout");
      const bridge = await carveBridge({ from: dir, select: sel, output: out });
      expect(bridge.ok).toBe(true);
      expect(bridge.plan!.dataSources[0].type).toBe("aws_s3_bucket");
      const rewired = bridge.plan!.rewrites.find((r) => r.changed)!;
      expect(rewired.rewritten).toContain("data.aws_s3_bucket.assets.bucket");

      // 3. apply: ownership marker + graduation plan.
      const apply = await carveApply({ from: dir, select: sel, env: "prod", stack: "assets" });
      expect(apply.ok).toBe(true);
      expect(apply.plan!.ownershipTags["chant:managed-by"]).toBe("chant");
      expect(apply.plan!.steps.join("\n")).toMatch(/terraform import aws_s3_bucket\.assets/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
