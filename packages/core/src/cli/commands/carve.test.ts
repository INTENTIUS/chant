import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carveAdvise, carveJson, formatCarveReport, CARVE_REPORT_VERSION } from "./carve";
import { loadHcl2json } from "../../terraform/parse";

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
  environment {
    variables = {
      ASSETS_BUCKET = aws_s3_bucket.assets.bucket
    }
  }
}
resource "random_pet" "name" {
  length = 2
}
`;

async function withEstate<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chant-carve-"));
  try {
    writeFileSync(join(dir, "main.tf"), ESTATE);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("carveAdvise", () => {
  test("requires --from", async () => {
    const r = await carveAdvise({});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("--from");
  });

  test("errors on a non-directory", async () => {
    const r = await carveAdvise({ from: join(tmpdir(), "definitely-not-here-xyz") });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Not a directory");
  });

  test("scores a real estate, ranks it, and writes a report (real wasm)", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const reportFile = join(dir, "report.json");
      const r = await carveAdvise({ from: dir, reportFile });
      expect(r.ok).toBe(true);

      const addrs = (r.results ?? []).map((x) => x.address);
      // versioning is folded into the bucket, so it is not ranked on its own.
      expect(addrs).not.toContain("aws_s3_bucket_versioning.assets");
      expect(addrs).toContain("aws_s3_bucket.assets");
      expect(addrs).toContain("random_pet.name");

      const bucket = r.results!.find((x) => x.address === "aws_s3_bucket.assets")!;
      expect(bucket.score).toBe(88);
      expect(bucket.band).toBe("clean leaf");

      const petunia = r.results!.find((x) => x.address === "random_pet.name")!;
      expect(petunia.score).toBe(0); // unsupported provider

      // report file is valid JSON with the advisory banner + band counts
      const payload = JSON.parse(readFileSync(reportFile, "utf-8"));
      expect(payload.version).toBe(CARVE_REPORT_VERSION);
      expect(payload.advisory).toContain("read-only");
      expect(payload.bands["clean leaf"]).toBeGreaterThanOrEqual(1);
      expect(payload.count).toBe(r.results!.length);

      // The written report carries the edge lists, not just the counts (#1636).
      const written = payload.resources.find((x: { address: string }) => x.address === "aws_s3_bucket.assets");
      expect(written.boundary.inbound).toEqual([
        {
          direction: "inbound",
          survivor: "aws_lambda_function.api",
          carved: "aws_s3_bucket.assets",
          attrs: ["bucket"],
          via: ["environment"],
          bridge: "tf-data-source",
          required: "immediately",
        },
      ]);
      expect(written.boundary.outbound).toEqual([]);
    });
  });

  test("formatCarveReport groups by band and never suggests a mutation", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const r = await carveAdvise({ from: dir });
      const text = formatCarveReport(r);
      expect(text).toContain("CLEAN LEAF");
      expect(text).toContain("LEAVE IN TERRAFORM");
      expect(text).toContain("Advises only");
      expect(text).not.toMatch(/terraform state rm|apply|destroy/i);
    });
  });

  test("carveJson carries the read-only advisory banner and the schema version", () => {
    const payload = carveJson({ ok: true, from: "x", results: [] });
    expect(payload.advisory).toContain("read-only");
    expect(payload.count).toBe(0);
    expect(payload.version).toBe(1);
  });

  test("carveJson omits boundary entirely with no graph — 'none' and 'not reported' differ", () => {
    const payload = carveJson({
      ok: true,
      from: "x",
      results: [
        {
          address: "aws_vpc.main",
          kind: "resource",
          score: 100,
          band: "clean leaf",
          breakdown: {
            inbound: 0,
            outbound: 0,
            tier: 1,
            hasDynamic: false,
            instances: 1,
            penalties: { inbound: 0, outbound: 0, tier: 0, dynamic: 0, instances: 0 },
          },
        },
      ],
    });
    expect(payload.resources[0]).not.toHaveProperty("boundary");
  });
});
