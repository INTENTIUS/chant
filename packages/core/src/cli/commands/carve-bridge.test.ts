import { describe, test, expect } from "vitest";
import { execFileSync } from "child_process";
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

  test("emits one git-applyable patch carrying the whole survivor edit", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      const res = await carveBridge({ from: dir, select: "aws_s3_bucket.assets", output: out });
      expect(res.ok).toBe(true);
      expect(res.patchPath).toBe(join(out, "aws_s3_bucket-assets-bridge.patch"));
      expect(res.written).toContain(res.patchPath);

      const patch = readFileSync(res.patchPath!, "utf-8");
      expect(patch).toContain("diff --git a/aws_s3_bucket-assets-datasources.tf b/aws_s3_bucket-assets-datasources.tf");
      expect(patch).toContain("new file mode 100644");
      expect(patch).toContain("diff --git a/api.tf b/api.tf");
      expect(patch).toContain("-      ASSETS_BUCKET = aws_s3_bucket.assets.bucket");
      expect(patch).toContain("+      ASSETS_BUCKET = data.aws_s3_bucket.assets.bucket");

      const m = readCarveManifest(res.manifestPath!)!;
      expect(m.bridge!.patch).toBe(res.patchPath);
      expect(formatCarveBridge(res)).toContain("git apply");

      // The patch really applies: `git apply` from the estate reproduces the
      // rewired survivor and the new data-source file.
      try {
        execFileSync("git", ["apply", res.patchPath!], { cwd: dir });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // no git on this machine
        throw err;
      }
      expect(readFileSync(join(dir, "api.tf"), "utf-8")).toContain("data.aws_s3_bucket.assets.bucket");
      expect(readFileSync(join(dir, "aws_s3_bucket-assets-datasources.tf"), "utf-8")).toContain('data "aws_s3_bucket" "assets"');
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

      // api.tf rewritten in place; bucket.tf's carved declaration excised
      // (#998 — after `terraform state rm`, the block would re-create it).
      const api = readFileSync(join(dir, "api.tf"), "utf-8");
      expect(api).toContain("data.aws_s3_bucket.assets.bucket");
      expect(readFileSync(join(dir, "bucket.tf"), "utf-8")).not.toContain('resource "aws_s3_bucket" "assets"');
    });
  });

  test("an output-only dependency is patched, not left dangling (#1638)", async () => {
    if (!parserAvailable) return;
    const dir = mkdtempSync(join(tmpdir(), "chant-bridge-outputs-"));
    try {
      // Nothing but an output reads the bucket. Before outputs entered the
      // graph this produced no data source and no rewrite at all, so the
      // surviving plan broke on the dangling reference at handoff.
      writeFileSync(join(dir, "bucket.tf"), BUCKET_TF);
      writeFileSync(
        join(dir, "outputs.tf"),
        `output "assets_bucket" {\n  value = aws_s3_bucket.assets.bucket\n}\n`,
      );
      const out = join(dir, "carveout");
      const res = await carveBridge({ from: dir, select: "aws_s3_bucket.assets", output: out });
      expect(res.ok).toBe(true);
      expect(res.plan!.outputRewrites).toEqual(["output.assets_bucket"]);

      expect(readFileSync(join(out, "aws_s3_bucket-assets-datasources.tf"), "utf-8")).toContain(
        'data "aws_s3_bucket" "assets"',
      );
      expect(readFileSync(join(out, "outputs.tf"), "utf-8")).toContain("value = data.aws_s3_bucket.assets.bucket");

      const patch = readFileSync(res.patchPath!, "utf-8");
      expect(patch).toContain("diff --git a/outputs.tf b/outputs.tf");
      expect(patch).toContain("-  value = aws_s3_bucket.assets.bucket");
      expect(patch).toContain("+  value = data.aws_s3_bucket.assets.bucket");
      expect(formatCarveBridge(res)).toContain("1 output block(s) repointed at the data source: output.assets_bucket");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
