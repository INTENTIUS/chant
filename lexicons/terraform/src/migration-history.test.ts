/**
 * chant#4910: a migration's history read back from the finished lines core's
 * `runStateMigration` writes, and the revert of one that applied. Plain text;
 * nothing reads git.
 */
import { describe, expect, test } from "vitest";
import { doneMigrations, finishedMigrationLines, migrationHistory, revertMigration } from "./migration-history";
import { MigrationError } from "./state-migration";

const finished = (gate: string, detail: Record<string, string>, timestamp = "2026-11-08T10:00:00Z") =>
  JSON.stringify({ version: 1, kind: "finished", op: "tf-migrate", gate, planDigest: `sha256:${gate}`, timestamp, detail });

const moved = finished("move-queues", {
  result: "applied",
  approved_by: "bo",
  file_digest: "sha256:file",
  change: "moves",
  migration_change: "moves",
  roots: "envs/a,envs/b",
  "envs/a.location": "s3://acme/a.tfstate",
  "envs/a.before": "a1",
  "envs/a.after": "a2",
  "envs/a.before_digest": "sha256:a1",
  "envs/a.after_digest": "sha256:a2",
  "envs/b.location": "s3://acme/b.tfstate",
  "envs/b.after": "b1",
  "envs/b.after_digest": "sha256:b1",
});

describe("finishedMigrationLines (chant#4910)", () => {
  test("each finished line as a history line; a run refused under the locks, or one with no result, has none", () => {
    const text = [moved, finished("refused-one", { result: "refused", roots: "x" }), finished("threw", {}), "not json", ""].join("\n");
    const lines = finishedMigrationLines(text, "tf-migrate");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      version: 1,
      kind: "migration",
      op: "tf-migrate",
      gate: "move-queues",
      timestamp: "2026-11-08T10:00:00Z",
      planDigest: "sha256:move-queues",
      file_digest: "sha256:file",
      result: "applied",
      approvedBy: "bo",
      change: "moves",
      roots: [
        { root: "envs/a", location: "s3://acme/a.tfstate", before: "a1", after: "a2", before_digest: "sha256:a1", after_digest: "sha256:a2" },
        { root: "envs/b", location: "s3://acme/b.tfstate", before: null, after: "b1", before_digest: null, after_digest: "sha256:b1" },
      ],
      source: "finished",
    });
  });

  test("the history reads the product's earlier lines first, and the newest line of a migration wins", () => {
    const earlier = JSON.stringify({ version: 1, kind: "migration", op: "tf-migrate", gate: "move-queues", timestamp: "2026-10-01T00:00:00Z", result: "failed", roots: [] });
    const files: Record<string, string> = { "_gates/tf-migrate/done.jsonl": `${earlier}\n`, "_gates/tf-migrate/applied.jsonl": `${moved}\n` };
    const history = migrationHistory((p) => files[p] ?? "", { op: "tf-migrate", earlier: "_gates/tf-migrate/done.jsonl" });
    expect(history.trim().split("\n")).toHaveLength(2);
    expect(doneMigrations(history).get("move-queues")).toEqual({ status: "applied", file_digest: "sha256:file", timestamp: "2026-11-08T10:00:00Z" });
  });
});

describe("revertMigration (chant#4910)", () => {
  const history = finishedMigrationLines(moved, "tf-migrate").map((l) => JSON.stringify(l)).join("\n");

  test("each root back to the version recorded before the write, from the one recorded after", () => {
    const r = revertMigration("move-queues", history, { header: ["Written by the product."] });
    expect(r.name).toBe("move-queues-revert");
    expect(r.restores).toEqual([
      { root: "envs/a", location: "s3://acme/a.tfstate", version_id: "a1", from_version_id: "a2" },
      { root: "envs/b", location: "s3://acme/b.tfstate", version_id: null, from_version_id: "b1" },
    ]);
    expect(r.text.split("\n").slice(0, 4)).toEqual(["# Written by the product.", "revert: move-queues", "restores:", "  - root: envs/a"]);
  });

  test("a migration never applied, a backend move, and a root with no version are refused with why", () => {
    expect(() => revertMigration("other", history, { where: "in its history" })).toThrow(new MigrationError("chant/lifecycle records no applied migration other, in its history"));
    const backends = finishedMigrationLines(finished("to-gcs", { result: "applied", migration_change: "backends", roots: "r" }), "tf-migrate").map((l) => JSON.stringify(l)).join("\n");
    expect(() => revertMigration("to-gcs", backends)).toThrow(/backend move the other way/);
    const pg = finishedMigrationLines(finished("pg", { result: "applied", migration_change: "moves", roots: "r", "r.location": "pg://db", "r.after_digest": "sha256:x" }), "tf-migrate").map((l) => JSON.stringify(l)).join("\n");
    expect(() => revertMigration("pg", pg)).toThrow(/keeps no versions/);
  });
});
