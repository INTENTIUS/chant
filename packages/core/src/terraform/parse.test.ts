import { describe, test, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseTerraformDir, loadHcl2json, Hcl2JsonNotInstalled } from "./parse";

/**
 * `@cdktf/hcl2json` is an optional (dev-only in this repo) dependency. These
 * tests exercise the real wasm parser when it resolves and skip cleanly when it
 * does not, so a consumer install without the parser never fails the suite.
 */
let parserAvailable = false;
beforeAll(async () => {
  try {
    await loadHcl2json();
    parserAvailable = true;
  } catch {
    parserAvailable = false;
  }
});

describe("loadHcl2json", () => {
  test("missing parser throws an install-hint error, not a raw MODULE_NOT_FOUND", () => {
    const err = new Hcl2JsonNotInstalled(new Error("Cannot find module '@cdktf/hcl2json'"));
    expect(err.message).toContain("npm install -D @cdktf/hcl2json");
    expect(err.message).toContain("carve");
    expect(err.name).toBe("Hcl2JsonNotInstalled");
  });
});

describe.runIf(true)("parseTerraformDir (real wasm)", () => {
  test("parses a multi-file estate into the expected graph", async () => {
    if (!parserAvailable) return; // optional dep absent — skip
    const dir = mkdtempSync(join(tmpdir(), "chant-tf-"));
    try {
      writeFileSync(
        join(dir, "bucket.tf"),
        `resource "aws_s3_bucket" "assets" {\n  bucket = "myapp-assets-prod"\n}\n`,
      );
      writeFileSync(
        join(dir, "api.tf"),
        `resource "aws_lambda_function" "api" {\n  environment {\n    variables = {\n      ASSETS_BUCKET = aws_s3_bucket.assets.bucket\n      ASSETS_ARN    = aws_s3_bucket.assets.arn\n    }\n  }\n}\n`,
      );
      const g = await parseTerraformDir(dir);
      expect(g.nodes.map((n) => n.address)).toEqual([
        "aws_lambda_function.api",
        "aws_s3_bucket.assets",
      ]);
      expect(g.edges).toEqual([
        { from: "aws_lambda_function.api", to: "aws_s3_bucket.assets", attrs: ["arn", "bucket"] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
