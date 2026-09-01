import { describe, test, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carveStatus, carveStatusJson, formatCarveStatus } from "./carve-status";
import { writeCarveManifest, type CarveManifest } from "../../terraform/manifest";
import type { CarveReport } from "../../terraform/carve";

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
  const dir = mkdtempSync(join(tmpdir(), "chant-carve-status-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("carve status", () => {
  test("walks the tree at any depth and reports target, stage, and root-relative path", () => {
    withDir((dir) => {
      // Flat under a named output dir…
      writeCarveManifest(join(dir, "carveout"), manifest("aws_s3_bucket.assets"));
      // …and nested deeper than the two levels a walker would guess at.
      const deep = { ...manifest("aws_sqs_queue.jobs"), tfType: "aws_sqs_queue" };
      deep.emit = { source: "tfstate" as const, files: ["src/jobs.ts"], at: "2026-08-30T00:00:00Z" };
      writeCarveManifest(join(dir, "stacks", "queues", "carveout"), deep);

      const res = carveStatus({ from: dir });
      expect(res.ok).toBe(true);
      expect(res.from).toBe(dir);
      expect(res.carves).toHaveLength(2);

      const [flat, nested] = res.carves!;
      expect(flat.path).toBe(join("carveout", "aws_s3_bucket-assets.carve.json"));
      expect(flat.target).toBe("aws_s3_bucket.assets");
      expect(flat.stage).toBe("planned"); // boundary only, no recorded step
      expect(flat.at).toEqual({});

      expect(nested.path).toBe(join("stacks", "queues", "carveout", "aws_sqs_queue-jobs.carve.json"));
      expect(nested.target).toBe("aws_sqs_queue.jobs");
      expect(nested.tfType).toBe("aws_sqs_queue");
      expect(nested.stage).toBe("emitted");
      expect(nested.at).toEqual({ emit: "2026-08-30T00:00:00Z" });
      expect(nested.emittedFiles).toEqual(["src/jobs.ts"]);
    });
  });

  test("stage is the highest recorded step: emitted < bridged < applied", () => {
    withDir((dir) => {
      const m = manifest("aws_s3_bucket.assets");
      m.emit = { source: "tfstate", files: ["src/assets.ts"], at: "t1" };
      m.bridge = { written: ["runbook.md"], appliedInPlace: false, at: "t2" };
      m.apply = { marker: { stack: "assets", env: "prod" }, ownershipTags: {}, at: "t3" };
      writeCarveManifest(dir, m);

      const res = carveStatus({ from: dir });
      expect(res.carves![0].stage).toBe("applied");
      expect(res.carves![0].at).toEqual({ emit: "t1", bridge: "t2", apply: "t3" });
    });
  });

  test("reports unreadable manifest files instead of failing or silently dropping them", () => {
    withDir((dir) => {
      writeCarveManifest(dir, manifest("aws_s3_bucket.assets"));
      writeFileSync(join(dir, "bad.carve.json"), "not json");

      const res = carveStatus({ from: dir });
      expect(res.ok).toBe(true);
      expect(res.carves).toHaveLength(1);
      expect(res.unreadable).toEqual(["bad.carve.json"]);
      expect(formatCarveStatus(res)).toContain("bad.carve.json");
    });
  });

  test("skips node_modules and .git", () => {
    withDir((dir) => {
      mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
      writeCarveManifest(join(dir, "node_modules", "dep"), manifest("aws_s3_bucket.vendored"));
      const res = carveStatus({ from: dir });
      expect(res.carves).toHaveLength(0);
      expect(formatCarveStatus(res)).toContain("No carve manifests");
    });
  });

  test("errors on a non-directory root", () => {
    const res = carveStatus({ from: "/definitely/not/a/dir" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Not a directory");
  });

  test("--json payload carries from, carves, and unreadable only when present", () => {
    withDir((dir) => {
      writeCarveManifest(dir, manifest("aws_s3_bucket.assets"));
      const res = carveStatus({ from: dir });
      const json = carveStatusJson(res);
      expect(Object.keys(json)).toEqual(["from", "carves"]);
      expect((json.carves as unknown[]).length).toBe(1);
    });
  });
});
