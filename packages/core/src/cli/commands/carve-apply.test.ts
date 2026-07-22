import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carveApply, formatCarveApply } from "./carve-apply";
import { loadHcl2json } from "../../terraform/parse";

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

async function withEstate<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chant-apply-"));
  try {
    writeFileSync(join(dir, "main.tf"), ESTATE);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("carveApply", () => {
  test("requires --from and --select", async () => {
    expect((await carveApply({})).error).toContain("--from");
    expect((await carveApply({ from: "/x" })).error).toContain("--select");
  });

  test("plans graduation with ownership marker; writes nothing by default", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const res = await carveApply({ from: dir, select: "aws_s3_bucket.assets", env: "prod", stack: "assets" });
      expect(res.ok).toBe(true);
      expect(res.written).toBeUndefined();
      expect(res.plan!.ownershipTags["chant:managed-by"]).toBe("chant");
      expect(res.plan!.marker).toEqual({ stack: "assets", env: "prod" });

      const text = formatCarveApply(res);
      expect(text).toContain("observe → apply");
      expect(text).toContain("no cloud call");
    });
  });

  test("--write emits the graduation doc", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      const res = await carveApply({
        from: dir,
        select: "aws_s3_bucket.assets",
        env: "prod",
        output: out,
        write: true,
      });
      expect(res.ok).toBe(true);
      expect(res.written).toBe(join(out, "aws_s3_bucket-assets-graduation.md"));
      expect(existsSync(res.written!)).toBe(true);
      const doc = readFileSync(res.written!, "utf-8");
      expect(doc).toContain("# Apply graduation: aws_s3_bucket.assets");
      expect(doc).toContain("chant:managed-by = chant");
    });
  });

  test("errors on an unknown target", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const res = await carveApply({ from: dir, select: "aws_s3_bucket.nope", env: "prod" });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("not found");
    });
  });
});
