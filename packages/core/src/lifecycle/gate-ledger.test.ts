import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendGateResolution, readGateResolutions, latestResolutionSince } from "./gate-ledger";
import { readBlobFromPath } from "./git";

function git(args: string[], cwd: string): { stdout: string; exitCode: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", exitCode: r.status ?? -1 };
}

async function initRepo(dir: string): Promise<void> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

describe("lifecycle/gate-ledger", () => {
  test("appendGateResolution + readGateResolutions round-trip", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      const { record } = await appendGateResolution(
        { op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" },
        { cwd: dir },
      );
      expect(record.version).toBe(1);

      const { records, malformed } = await readGateResolutions("fountain-apply", { cwd: dir });
      expect(malformed).toBe(0);
      expect(records).toEqual([record]);
    });
  });

  test("stores under a global _gates namespace, keyed by op — not per-environment", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await appendGateResolution(
        { op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" },
        { cwd: dir },
      );
      const raw = await readBlobFromPath("_gates", "fountain-apply.jsonl", { cwd: dir });
      expect(raw).toContain("rollout-gate");
    });
  });

  test("readGateResolutions returns [] for an op with no resolutions yet", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      expect(await readGateResolutions("no-such-op", { cwd: dir })).toEqual({ records: [], malformed: 0 });
    });
  });

  test("appends without clobbering — multiple gates/resolutions on the same op accumulate", async () => {
    await withTestDir(async (dir) => {
      await initRepo(dir);
      await appendGateResolution(
        { op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" },
        { cwd: dir },
      );
      await appendGateResolution(
        { op: "fountain-apply", gate: "prod-gate", resolvedBy: "sam", timestamp: "2026-01-02T00:00:00.000Z", note: "https://github.com/x/y/pull/1" },
        { cwd: dir },
      );
      const { records } = await readGateResolutions("fountain-apply", { cwd: dir });
      expect(records.map((r) => r.gate)).toEqual(["rollout-gate", "prod-gate"]);
      expect(records[1].note).toBe("https://github.com/x/y/pull/1");
    });
  });

  describe("latestResolutionSince", () => {
    test("finds a resolution recorded after the gated tick's own timestamp", () => {
      const records = [
        { version: 1 as const, op: "x", gate: "g1", resolvedBy: "a", timestamp: "2026-01-01T00:00:00.000Z" },
        { version: 1 as const, op: "x", gate: "g1", resolvedBy: "b", timestamp: "2026-01-03T00:00:00.000Z" },
      ];
      const found = latestResolutionSince(records, "g1", "2026-01-02T00:00:00.000Z");
      expect(found?.resolvedBy).toBe("b");
    });

    test("returns undefined when the only resolution predates the gated tick (a stale, superseded approval)", () => {
      const records = [
        { version: 1 as const, op: "x", gate: "g1", resolvedBy: "a", timestamp: "2026-01-01T00:00:00.000Z" },
      ];
      expect(latestResolutionSince(records, "g1", "2026-01-02T00:00:00.000Z")).toBeUndefined();
    });

    test("ignores resolutions for a different gate", () => {
      const records = [
        { version: 1 as const, op: "x", gate: "other-gate", resolvedBy: "a", timestamp: "2026-01-05T00:00:00.000Z" },
      ];
      expect(latestResolutionSince(records, "g1", "2026-01-01T00:00:00.000Z")).toBeUndefined();
    });

    test("undefined when there are no resolutions at all", () => {
      expect(latestResolutionSince([], "g1", "2026-01-01T00:00:00.000Z")).toBeUndefined();
    });
  });
});
