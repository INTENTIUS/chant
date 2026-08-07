import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  carveManifestPath,
  listCarveManifests,
  readCarveManifest,
  resolveCarveManifest,
  updateCarveManifest,
  writeCarveManifest,
  type CarveManifest,
} from "./manifest";
import type { CarveReport } from "./carve";

function report(target: string): CarveReport {
  return {
    target,
    carveSet: [{ address: target, type: target.split(".")[0] }],
    peelability: 90,
    inbound: [],
    outbound: [],
    reversible: true,
    diagnostics: [],
  };
}

function manifest(target: string): CarveManifest {
  return { version: 1, target, from: "/estate", boundary: report(target) };
}

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "chant-manifest-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("carve manifest", () => {
  test("round-trips through the output dir, named by target slug", () => {
    withDir((dir) => {
      const path = writeCarveManifest(dir, manifest("aws_s3_bucket.assets"));
      expect(path).toBe(join(dir, "aws_s3_bucket-assets.carve.json"));
      expect(path).toBe(carveManifestPath(dir, "aws_s3_bucket.assets"));
      const read = readCarveManifest(path)!;
      expect(read.target).toBe("aws_s3_bucket.assets");
      expect(read.boundary.peelability).toBe(90);
    });
  });

  test("rejects missing, malformed, and wrong-version files", () => {
    withDir((dir) => {
      expect(readCarveManifest(join(dir, "nope.carve.json"))).toBeNull();
      writeFileSync(join(dir, "bad.carve.json"), "not json");
      expect(readCarveManifest(join(dir, "bad.carve.json"))).toBeNull();
      writeFileSync(join(dir, "v9.carve.json"), JSON.stringify({ version: 9, target: "x" }));
      expect(readCarveManifest(join(dir, "v9.carve.json"))).toBeNull();
    });
  });

  test("resolve: no select + exactly one manifest composes; none or several is a clear error", () => {
    withDir((dir) => {
      expect(resolveCarveManifest(dir).error).toContain("--select");

      writeCarveManifest(dir, manifest("aws_s3_bucket.assets"));
      const one = resolveCarveManifest(dir);
      expect(one.manifest!.target).toBe("aws_s3_bucket.assets");
      expect(one.error).toBeUndefined();

      writeCarveManifest(dir, manifest("aws_sqs_queue.jobs"));
      const many = resolveCarveManifest(dir);
      expect(many.error).toContain("aws_s3_bucket.assets");
      expect(many.error).toContain("aws_sqs_queue.jobs");
      expect(listCarveManifests(dir)).toHaveLength(2);

      // An explicit select still resolves its own manifest among several.
      const picked = resolveCarveManifest(dir, "aws_sqs_queue.jobs");
      expect(picked.manifest!.target).toBe("aws_sqs_queue.jobs");
    });
  });

  test("resolve with a select whose manifest is absent runs standalone (no error)", () => {
    withDir((dir) => {
      const res = resolveCarveManifest(dir, "aws_s3_bucket.assets");
      expect(res.manifest).toBeUndefined();
      expect(res.error).toBeUndefined();
    });
  });

  test("update patches an existing manifest and no-ops on a missing one", () => {
    withDir((dir) => {
      expect(updateCarveManifest(dir, "aws_s3_bucket.assets", { bridge: { written: [], appliedInPlace: false, at: "t" } })).toBeUndefined();

      writeCarveManifest(dir, manifest("aws_s3_bucket.assets"));
      const path = updateCarveManifest(dir, "aws_s3_bucket.assets", {
        apply: { marker: { stack: "assets", env: "prod" }, ownershipTags: { "chant:managed-by": "chant" }, at: "t" },
      })!;
      const read = readCarveManifest(path)!;
      expect(read.apply!.marker).toEqual({ stack: "assets", env: "prod" });
      expect(read.boundary.target).toBe("aws_s3_bucket.assets"); // untouched sections survive
    });
  });
});
