/**
 * Tests `r2-sync` (#1293, epic #1296, ./r2-sync.ts) against a
 * `MockProcessRunner` — no live `rclone`, no network call, ever. Asserts the
 * `r2://` destination shape mirrors `s3-sync`'s `s3://` shape, the
 * copy-vs-sync dispatch on `delete`, the uploaded/deleted count parsing, and
 * the `needs-opt-out` rollback disposition `s3-sync` also carries.
 */

import { describe, expect, it } from "vitest";
import {
  buildR2SyncArgs,
  createR2SyncCapability,
  parseRcloneStats,
  R2SyncInvalidDestinationError,
  toRcloneDest,
} from "./r2-sync";
import { ToolNotAvailableError } from "./process-runner";
import { createMockProcessRunner } from "./__tests__/mock-process-runner";

const ctx = { env: "prod", component: "assets" };

describe("toRcloneDest", () => {
  it("translates r2://bucket/prefix to the default 'r2' rclone remote", () => {
    expect(toRcloneDest("r2://my-bucket/assets")).toBe("r2:my-bucket/assets");
  });

  it("translates a bare bucket with no prefix", () => {
    expect(toRcloneDest("r2://my-bucket")).toBe("r2:my-bucket");
  });

  it("honours an explicit remote name override", () => {
    expect(toRcloneDest("r2://my-bucket/assets", "cf-r2")).toBe("cf-r2:my-bucket/assets");
  });

  it("throws R2SyncInvalidDestinationError for a non-r2:// URI (e.g. an s3:// one passed by mistake)", () => {
    expect(() => toRcloneDest("s3://my-bucket/assets")).toThrow(R2SyncInvalidDestinationError);
  });
});

describe("buildR2SyncArgs", () => {
  it("uses 'rclone copy' by default — never deletes destination-only keys, matching s3-sync's default", () => {
    const cmd = buildR2SyncArgs({ from: "dist/assets", to: "r2://my-bucket/assets" });
    expect(cmd).toBe(`rclone copy 'dist/assets' 'r2:my-bucket/assets' -v`);
  });

  it("uses 'rclone sync' when delete: true — matching s3-sync's opt-in delete", () => {
    const cmd = buildR2SyncArgs({ from: "dist/assets", to: "r2://my-bucket/assets", delete: true });
    expect(cmd).toBe(`rclone sync 'dist/assets' 'r2:my-bucket/assets' -v`);
  });
});

describe("parseRcloneStats", () => {
  it("counts new and replaced uploads together as 'uploaded'", () => {
    const stdout = [
      "2026/08/24 10:00:00 INFO  : a.txt: Copied (new)",
      "2026/08/24 10:00:00 INFO  : b.txt: Copied (replaced existing)",
      "2026/08/24 10:00:00 INFO  : c.txt: Copied (new)",
    ].join("\n");
    expect(parseRcloneStats(stdout)).toEqual({ uploaded: 3, deleted: 0 });
  });

  it("counts deletions separately", () => {
    const stdout = [
      "2026/08/24 10:00:00 INFO  : a.txt: Copied (new)",
      "2026/08/24 10:00:00 INFO  : stale.txt: Deleted",
    ].join("\n");
    expect(parseRcloneStats(stdout)).toEqual({ uploaded: 1, deleted: 1 });
  });

  it("returns zeros for a no-op sync", () => {
    expect(parseRcloneStats("2026/08/24 10:00:00 INFO  : There was nothing to transfer\n")).toEqual({
      uploaded: 0,
      deleted: 0,
    });
  });
});

describe("r2-sync capability", () => {
  it("round-trips a directory upload and reports the object count", async () => {
    const mock = createMockProcessRunner({
      responses: {
        "rclone copy": "2026/08/24 10:00:00 INFO  : a.txt: Copied (new)\n2026/08/24 10:00:00 INFO  : b.txt: Copied (new)\n",
      },
    });
    const capability = createR2SyncCapability(mock.runner);

    const output = await capability.run(ctx, { from: "dist/assets", to: "r2://my-bucket/assets" });

    expect(output).toEqual({ uploaded: 2, deleted: 0 });
    expect(mock.calls.some((c) => c.command === `rclone copy 'dist/assets' 'r2:my-bucket/assets' -v`)).toBe(true);
  });

  it("throws ToolNotAvailableError when rclone is absent, rather than silently skipping the sync", async () => {
    const mock = createMockProcessRunner({ tools: { rclone: false } });
    const capability = createR2SyncCapability(mock.runner);

    await expect(capability.run(ctx, { from: "dist/assets", to: "r2://my-bucket/assets" })).rejects.toBeInstanceOf(
      ToolNotAvailableError,
    );
  });

  it("declares rollbackPolicy: needs-opt-out — a mutating, destructive-capable sync with no native undo, same as s3-sync", () => {
    const capability = createR2SyncCapability(createMockProcessRunner().runner);
    expect(capability.rollbackPolicy).toBe("needs-opt-out");
    expect(capability.rollback).toBeUndefined();
  });
});
