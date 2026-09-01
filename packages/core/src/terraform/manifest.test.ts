import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CARVE_MANIFEST_VERSION,
  carveManifestPath,
  listCarveManifests,
  readCarveManifest,
  resolveCarveManifest,
  resolveManifestFilePath,
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

  test("records file paths relative to its own directory, so the tree can move (#2039)", () => {
    withDir((dir) => {
      const m = manifest("aws_s3_bucket.assets");
      m.emit = { source: "tfstate", files: [join(dir, "src", "assets.ts")], at: "t" };
      m.bridge = {
        written: [join(dir, "aws_s3_bucket-assets-runbook.md"), join(dir, "..", "api.tf")],
        appliedInPlace: false,
        patch: join(dir, "aws_s3_bucket-assets-bridge.patch"),
        at: "t",
      };
      const path = writeCarveManifest(dir, m);
      const read = readCarveManifest(path)!;
      expect(read.version).toBe(CARVE_MANIFEST_VERSION);
      expect(read.emit!.files).toEqual([join("src", "assets.ts")]);
      expect(read.bridge!.written).toEqual(["aws_s3_bucket-assets-runbook.md", join("..", "api.tf")]);
      expect(read.bridge!.patch).toBe("aws_s3_bucket-assets-bridge.patch");
      // `from`/`statePath` locate the estate, a tree the manifest does not
      // travel with — they stay absolute.
      expect(read.from).toBe("/estate");
    });
  });

  test("resolveManifestFilePath joins relative entries and passes absolute (v1) entries through", () => {
    expect(resolveManifestFilePath("/moved/carveout", join("src", "assets.ts"))).toBe(join("/moved/carveout", "src", "assets.ts"));
    expect(resolveManifestFilePath("/moved/carveout", "/original/carveout/src/assets.ts")).toBe("/original/carveout/src/assets.ts");
  });

  test("reads a version-1 manifest (absolute paths) and migrates it on update", () => {
    withDir((dir) => {
      const path = carveManifestPath(dir, "aws_s3_bucket.assets");
      const v1: CarveManifest = {
        ...manifest("aws_s3_bucket.assets"),
        version: 1,
        emit: { source: "tfstate", files: [join(dir, "src", "assets.ts")], at: "t" },
      };
      writeFileSync(path, JSON.stringify(v1, null, 2) + "\n");
      // Readable as-is, absolute paths intact.
      expect(readCarveManifest(path)!.emit!.files).toEqual([join(dir, "src", "assets.ts")]);

      // Any update rewrites the whole manifest to the version-2 contract.
      updateCarveManifest(dir, "aws_s3_bucket.assets", {
        bridge: { written: [join(dir, "runbook.md")], appliedInPlace: false, at: "t" },
      });
      const migrated = readCarveManifest(path)!;
      expect(migrated.version).toBe(CARVE_MANIFEST_VERSION);
      expect(migrated.emit!.files).toEqual([join("src", "assets.ts")]);
      expect(migrated.bridge!.written).toEqual(["runbook.md"]);
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
