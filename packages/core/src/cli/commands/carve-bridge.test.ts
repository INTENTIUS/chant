import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carveBridge, formatCarveBridge } from "./carve-bridge";
import { loadHcl2json } from "../../terraform/parse";
import { readCarveManifest, writeCarveManifest, type CarveManifest } from "../../terraform/manifest";

let parserAvailable = false;
try {
  await loadHcl2json();
  parserAvailable = true;
} catch {
  parserAvailable = false;
}

const BUCKET_TF = `resource "aws_s3_bucket" "assets" {
  bucket = "myapp-assets-prod"
}
`;
const API_TF = `resource "aws_lambda_function" "api" {
  function_name = "myapp-api"
  environment {
    variables = {
      ASSETS_BUCKET = aws_s3_bucket.assets.bucket
      ASSETS_ARN    = aws_s3_bucket.assets.arn
    }
  }
}
`;

async function withEstate<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chant-bridge-"));
  try {
    writeFileSync(join(dir, "bucket.tf"), BUCKET_TF);
    writeFileSync(join(dir, "api.tf"), API_TF);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function manifestFor(target: string, dir: string): CarveManifest {
  return {
    version: 1,
    target,
    from: dir,
    boundary: {
      target,
      carveSet: [{ address: target, type: target.split(".")[0] }],
      peelability: 90,
      inbound: [],
      outbound: [],
      reversible: true,
      diagnostics: [],
    },
  };
}

describe("carveBridge", () => {
  test("requires --from; without --select it needs a carve manifest", async () => {
    expect((await carveBridge({})).error).toContain("--from");
    await withEstate(async (dir) => {
      const res = await carveBridge({ from: dir });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("--select");
      expect(res.error).toContain("carve emit");
    });
  });

  test("composes with the carve manifest: target resolved without --select, bridge recorded", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      writeCarveManifest(out, manifestFor("aws_s3_bucket.assets", dir));

      const res = await carveBridge({ from: dir, output: out });
      expect(res.ok).toBe(true);
      expect(res.selectFromManifest).toBe(true);
      expect(res.plan!.target).toBe("aws_s3_bucket.assets");
      expect(formatCarveBridge(res)).toContain("target from the carve manifest");

      const m = readCarveManifest(res.manifestPath!)!;
      expect(m.bridge!.written.length).toBeGreaterThan(0);
      expect(m.bridge!.appliedInPlace).toBe(false);
      // The boundary is refreshed from the estate, not left as the stub.
      expect(m.boundary.inbound.map((e) => e.survivor)).toEqual(["aws_lambda_function.api"]);
    });
  });

  test("dry-run: writes runbook + data sources + proposed survivor, touches no .tf in place", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      const res = await carveBridge({ from: dir, select: "aws_s3_bucket.assets", output: out });
      expect(res.ok).toBe(true);
      expect(res.appliedInPlace).toBeFalsy();

      // Runbook + data sources + proposed api.tf were written to the output dir.
      expect(existsSync(join(out, "aws_s3_bucket-assets-runbook.md"))).toBe(true);
      const ds = readFileSync(join(out, "aws_s3_bucket-assets-datasources.tf"), "utf-8");
      expect(ds).toContain('data "aws_s3_bucket" "assets"');
      const proposed = readFileSync(join(out, "api.tf"), "utf-8");
      expect(proposed).toContain("data.aws_s3_bucket.assets.bucket");

      // The ORIGINAL api.tf in the estate is untouched.
      expect(readFileSync(join(dir, "api.tf"), "utf-8")).toBe(API_TF);
    });
  });

  test("--apply-rewrites edits the survivor .tf in place", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const res = await carveBridge({
        from: dir,
        select: "aws_s3_bucket.assets",
        output: join(dir, "carveout"),
        applyRewrites: true,
      });
      expect(res.ok).toBe(true);
      expect(res.appliedInPlace).toBe(true);

      // api.tf rewritten in place; bucket.tf (the carved declaration) untouched.
      const api = readFileSync(join(dir, "api.tf"), "utf-8");
      expect(api).toContain("data.aws_s3_bucket.assets.bucket");
      expect(readFileSync(join(dir, "bucket.tf"), "utf-8")).toBe(BUCKET_TF);
    });
  });

  test("formatCarveBridge summarizes data sources, rewires, and safety", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const res = await carveBridge({ from: dir, select: "aws_s3_bucket.assets", output: join(dir, "carveout") });
      const text = formatCarveBridge(res);
      expect(text).toContain("data.aws_s3_bucket.assets");
      expect(text).toContain("Nothing in your Terraform changed");
      expect(text).toContain("runbook");
    });
  });
});
