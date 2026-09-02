import { describe, test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carveApply, formatCarveApply } from "./carve-apply";
import { loadHcl2json } from "../../terraform/parse";
import { readCarveManifest, writeCarveManifest, type CarveManifest } from "../../terraform/manifest";

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

describe("carveApply", () => {
  test("requires --from; without --select it needs a carve manifest", async () => {
    expect((await carveApply({})).error).toContain("--from");
    await withEstate(async (dir) => {
      const res = await carveApply({ from: dir });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("--select");
    });
  });

  test("composes with the carve manifest: target resolved without --select, graduation recorded", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      writeCarveManifest(out, manifestFor("aws_s3_bucket.assets", dir));

      const res = await carveApply({ from: dir, output: out, env: "prod", stack: "assets" });
      expect(res.ok).toBe(true);
      expect(res.selectFromManifest).toBe(true);
      expect(formatCarveApply(res)).toContain("target from the carve manifest");

      const m = readCarveManifest(res.manifestPath!)!;
      expect(m.apply!.marker).toEqual({ stack: "assets", env: "prod" });
      expect(m.apply!.ownershipTags["chant:managed-by"]).toBe("chant");
    });
  });

  test("--write-source stamps the ownership marker into the emitted source and records it", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      const emitted = join(out, "assets.ts");
      const manifest = manifestFor("aws_s3_bucket.assets", dir);
      manifest.emit = { source: "tfstate", files: [emitted], at: "t" };
      writeCarveManifest(out, manifest);
      writeFileSync(emitted, 'export const assets = new Bucket({\n  BucketName: "myapp-assets-prod",\n});\n');

      const res = await carveApply({ from: dir, output: out, env: "prod", stack: "assets", writeSource: true });
      expect(res.ok).toBe(true);
      expect(res.stamped).toEqual([emitted]);

      const stamped = readFileSync(emitted, "utf-8");
      expect(stamped).toContain('{"Key":"chant:managed-by","Value":"chant"}');
      expect(stamped).toContain('{"Key":"chant:stack","Value":"assets"}');
      expect(stamped).toContain('{"Key":"chant:env","Value":"prod"}');

      const m = readCarveManifest(res.manifestPath!)!;
      // Recorded relative to the manifest's directory (#2039), not the
      // run-time absolute path the stamping itself used.
      expect(m.apply!.stampedFiles).toEqual(["assets.ts"]);
      expect(m.emit!.files).toEqual(["assets.ts"]);
      expect(formatCarveApply(res)).toContain("Stamped the ownership marker into");

      // Idempotent: a second graduation leaves the source stable.
      const again = await carveApply({ from: dir, output: out, env: "prod", stack: "assets", writeSource: true });
      expect(again.ok).toBe(true);
      expect(readFileSync(emitted, "utf-8")).toBe(stamped);
    });
  });

  test("a RELATIVE --output still records stampedFiles relative to the manifest's directory, not the cwd (#2059)", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      // The behold carve-demo shape: run FROM the project dir with
      // `--output carveout`. The bug: resolveManifestFilePath joined against
      // the relative outDir, producing a cwd-relative path ("carveout/…")
      // that normalize-on-write passed through — two spellings in one manifest.
      const out = join(dir, "carveout");
      const manifest = manifestFor("aws_s3_bucket.assets", dir);
      manifest.emit = { source: "tfstate", files: [join("src", "assets.ts")], at: "t" };
      writeCarveManifest(out, manifest);
      mkdirSync(join(out, "src"), { recursive: true });
      writeFileSync(join(out, "src", "assets.ts"), 'export const assets = new Bucket({\n  BucketName: "b",\n});\n');

      const prevCwd = process.cwd();
      process.chdir(dir);
      try {
        const res = await carveApply({ from: ".", output: "carveout", env: "prod", stack: "assets", writeSource: true });
        expect(res.ok).toBe(true);
        const m = readCarveManifest(res.manifestPath!)!;
        // One spelling: manifest-dir-relative, same as emit.files — never
        // "carveout/src/assets.ts" (relative to wherever the command ran).
        expect(m.apply!.stampedFiles).toEqual([join("src", "assets.ts")]);
        expect(m.emit!.files).toEqual([join("src", "assets.ts")]);
      } finally {
        process.chdir(prevCwd);
      }
    });
  });

  test("--write-source without an emit record in the manifest is a clear error", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      writeCarveManifest(out, manifestFor("aws_s3_bucket.assets", dir));
      const res = await carveApply({ from: dir, output: out, env: "prod", writeSource: true });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("carve emit");
    });
  });

  test("falls back to the manifest's persisted boundary when the block is already excised", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      writeCarveManifest(out, manifestFor("aws_s3_bucket.gone", dir));

      const res = await carveApply({ from: dir, output: out, env: "prod" });
      expect(res.ok).toBe(true);
      expect(res.plan!.target).toBe("aws_s3_bucket.gone");
    });
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
