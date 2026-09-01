import { describe, test, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carveEmit, formatCarveEmit } from "./carve-emit";
import { lintCommand } from "./lint";
import { loadHcl2json } from "../../terraform/parse";
import { readCarveManifest } from "../../terraform/manifest";
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
      expect(res.emittedFiles).toEqual([join(out, "src", "assets.ts")]);
      const emitted = readFileSync(res.emittedFiles![0], "utf-8");
      expect(emitted).toContain("new Bucket({");
      expect(emitted).toContain('BucketName: "myapp-assets-prod"');
      expect(emitted).toContain("Adopted from Terraform state");

      // Boundary still classified (the Lambda inbound).
      expect(res.report!.inbound.map((e) => e.survivor)).toEqual(["aws_lambda_function.api"]);

      // The carve state manifest persists boundary + selector for bridge/apply.
      expect(res.manifestPath).toBe(join(out, "aws_s3_bucket-assets.carve.json"));
      const manifest = readCarveManifest(res.manifestPath!)!;
      expect(manifest.target).toBe("aws_s3_bucket.assets");
      expect(manifest.statePath).toBe(join(dir, "terraform.tfstate"));
      expect(manifest.emit!.source).toBe("tfstate");
      // Recorded relative to the manifest's own directory (#2039) — the same
      // base the graph IR's sourceLoc uses, which is the #2040 join.
      expect(manifest.emit!.files).toEqual([join("src", "assets.ts")]);
      expect(manifest.boundary.inbound.map((e) => e.survivor)).toEqual(["aws_lambda_function.api"]);

      const text = formatCarveEmit(res);
      expect(text).toContain("Adopted from Terraform state (offline)");
      expect(text).toContain("State manifest");
      expect(text).toContain("Scaffolded a buildable chant project");
    });
  });

  test("scaffolds a buildable chant project around the emitted source, never overwriting", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      const res = await carveEmit(
        { from: dir, select: "aws_s3_bucket.assets", statePath: join(dir, "terraform.tfstate"), output: out },
        { plugins: [], liveImport },
      );
      expect(res.ok).toBe(true);
      expect(res.scaffolded!.map((f) => f.slice(out.length + 1)).sort()).toEqual([
        "chant.config.ts",
        "package.json",
        "tsconfig.json",
      ]);

      const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf-8"));
      expect(pkg.scripts.build).toBe("chant build src --lexicon aws");
      expect(Object.keys(pkg.dependencies)).toEqual(["@intentius/chant", "@intentius/chant-lexicon-aws"]);
      expect(readFileSync(join(out, "chant.config.ts"), "utf-8")).toContain('lexicons: ["aws"]');

      // A second emit into the same dir leaves the scaffold (and edits) alone.
      writeFileSync(join(out, "package.json"), '{"name":"edited"}');
      const again = await carveEmit(
        { from: dir, select: "aws_s3_bucket.assets", statePath: join(dir, "terraform.tfstate"), output: out },
        { plugins: [], liveImport },
      );
      expect(again.ok).toBe(true);
      expect(again.scaffolded).toEqual([]);
      expect(readFileSync(join(out, "package.json"), "utf-8")).toBe('{"name":"edited"}');
    });
  });

  test("deferred outbound inputs become declared build params (#998)", async () => {
    if (!parserAvailable) return;
    const dir = mkdtempSync(join(tmpdir(), "chant-emit-params-"));
    try {
      writeFileSync(
        join(dir, "main.tf"),
        `
resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }
resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}
`,
      );
      writeFileSync(
        join(dir, "terraform.tfstate"),
        JSON.stringify({
          version: 4,
          resources: [
            {
              mode: "managed",
              type: "aws_subnet",
              name: "a",
              instances: [{ attributes: { id: "subnet-0aa", vpc_id: "vpc-0abc", cidr_block: "10.0.1.0/24" } }],
            },
            {
              mode: "managed",
              type: "aws_vpc",
              name: "main",
              instances: [{ attributes: { id: "vpc-0abc", cidr_block: "10.0.0.0/16" } }],
            },
          ],
        }),
      );
      const out = join(dir, "carveout");
      const res = await carveEmit(
        { from: dir, select: "aws_subnet.a", statePath: join(dir, "terraform.tfstate"), output: out },
        { plugins: [], liveImport },
      );
      expect(res.ok).toBe(true);

      // The survivor-fed prop is a params reference; the rest stay literal.
      const emitted = readFileSync(join(out, "src", "a.ts"), "utf-8");
      expect(emitted).toContain('import { params } from "@intentius/chant/params";');
      expect(emitted).toContain("VpcId: params.vpc_id as string,");
      expect(emitted).toContain('CidrBlock: "10.0.1.0/24"');

      // The scaffolded config declares the param, defaulted from state.
      const config = readFileSync(join(out, "chant.config.ts"), "utf-8");
      expect(config).toContain("buildParams: {");
      expect(config).toContain("vpc_id: {");
      expect(config).toContain('default: "vpc-0abc",');
      expect(config).toContain("was aws_vpc.main.id in Terraform");

      // Recorded in the manifest, reported in the summary.
      const manifest = readCarveManifest(res.manifestPath!)!;
      expect(manifest.emit!.params).toEqual({
        vpc_id: { tfAttr: "vpc_id", survivor: "aws_vpc.main", attrs: ["id"], default: "vpc-0abc" },
      });
      expect(formatCarveEmit(res)).toContain("vpc_id — was aws_vpc.main.id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("folded sub-resources land in the emitted bucket's properties (#1637)", async () => {
    if (!parserAvailable) return;
    const dir = mkdtempSync(join(tmpdir(), "chant-emit-fold-"));
    try {
      writeFileSync(
        join(dir, "main.tf"),
        `
resource "aws_s3_bucket" "assets" { bucket = "myapp-assets-prod" }
resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
`,
      );
      const attrs = (extra: Record<string, unknown>) => ({ id: "myapp-assets-prod", bucket: "myapp-assets-prod", ...extra });
      writeFileSync(
        join(dir, "terraform.tfstate"),
        JSON.stringify({
          version: 4,
          resources: [
            {
              mode: "managed",
              type: "aws_s3_bucket",
              name: "assets",
              instances: [
                {
                  attributes: attrs({
                    arn: "arn:aws:s3:::myapp-assets-prod",
                    versioning: [{ enabled: true, mfa_delete: false }],
                    server_side_encryption_configuration: [
                      {
                        rule: [
                          {
                            apply_server_side_encryption_by_default: [{ sse_algorithm: "AES256", kms_master_key_id: "" }],
                            bucket_key_enabled: false,
                          },
                        ],
                      },
                    ],
                  }),
                },
              ],
            },
            {
              mode: "managed",
              type: "aws_s3_bucket_versioning",
              name: "assets",
              instances: [{ attributes: attrs({ versioning_configuration: [{ status: "Enabled", mfa_delete: "" }] }) }],
            },
            {
              mode: "managed",
              type: "aws_s3_bucket_public_access_block",
              name: "assets",
              instances: [
                {
                  attributes: attrs({
                    block_public_acls: true,
                    block_public_policy: true,
                    ignore_public_acls: true,
                    restrict_public_buckets: true,
                  }),
                },
              ],
            },
          ],
        }),
      );

      const out = join(dir, "carveout");
      const res = await carveEmit(
        { from: dir, select: "aws_s3_bucket.assets", statePath: join(dir, "terraform.tfstate"), output: out },
        { plugins: [], liveImport },
      );
      expect(res.ok).toBe(true);

      // The fold is applied, not merely announced: the emitted Bucket carries
      // the versioning and public-access block the Terraform declared.
      const emitted = readFileSync(join(out, "src", "assets.ts"), "utf-8");
      expect(emitted).toContain('VersioningConfiguration: {"Status":"Enabled"}');
      expect(emitted).toContain('"BlockPublicAcls":true');
      expect(emitted).toContain('"RestrictPublicBuckets":true');
      expect(emitted).toContain('BucketEncryption: {"ServerSideEncryptionConfiguration"');

      expect(res.folded).toEqual([
        { address: "aws_s3_bucket_public_access_block.assets", props: ["PublicAccessBlockConfiguration"] },
        { address: "aws_s3_bucket_versioning.assets", props: ["VersioningConfiguration"] },
      ]);
      const text = formatCarveEmit(res);
      expect(text).toContain("aws_s3_bucket_versioning.assets (VersioningConfiguration)");
      expect(text).toContain("aws_s3_bucket_public_access_block.assets (PublicAccessBlockConfiguration)");

      // And the emitted project still lints clean (no errors).
      const lint = await lintCommand({ path: out, format: "stylish" });
      expect(lint.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
