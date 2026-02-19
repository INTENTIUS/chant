import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { snapshotArtifacts, saveSnapshot, restoreSnapshot, listSnapshots } from "./rollback";

function makeTempDir(): string {
  const dir = join(tmpdir(), `chant-rollback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("rollback", () => {
  test("snapshot captures generated files with default artifact names", () => {
    const dir = makeTempDir();
    const genDir = join(dir, "generated");
    mkdirSync(genDir, { recursive: true });

    writeFileSync(join(genDir, "lexicon.json"), '{"Bucket":{"kind":"resource"}}');
    writeFileSync(join(genDir, "index.d.ts"), "declare class Bucket {}");
    writeFileSync(join(genDir, "index.ts"), "export const Bucket = {};");

    const snapshot = snapshotArtifacts(genDir);
    expect(snapshot.files["lexicon.json"]).toBeDefined();
    expect(snapshot.files["index.d.ts"]).toBeDefined();
    expect(snapshot.files["index.ts"]).toBeDefined();
    expect(snapshot.hashes["lexicon.json"]).toBeDefined();
    expect(snapshot.resourceCount).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  test("snapshot uses custom artifact names", () => {
    const dir = makeTempDir();
    const genDir = join(dir, "generated");
    mkdirSync(genDir, { recursive: true });

    writeFileSync(join(genDir, "my-lexicon.json"), '{"Resource":{"kind":"resource"}}');
    writeFileSync(join(genDir, "types.d.ts"), "declare class Resource {}");

    const snapshot = snapshotArtifacts(genDir, ["my-lexicon.json", "types.d.ts"]);
    expect(snapshot.files["my-lexicon.json"]).toBeDefined();
    expect(snapshot.files["types.d.ts"]).toBeDefined();
    expect(snapshot.resourceCount).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  test("save and list snapshots", () => {
    const dir = makeTempDir();
    const snapshotsDir = join(dir, ".snapshots");

    const snapshot = {
      timestamp: "2025-01-01T00:00:00.000Z",
      files: { "test.json": "{}" },
      hashes: { "test.json": "abc123" },
      resourceCount: 0,
    };

    saveSnapshot(snapshot, snapshotsDir);
    const list = listSnapshots(snapshotsDir);
    expect(list.length).toBe(1);
    expect(list[0].timestamp).toBe("2025-01-01T00:00:00.000Z");

    rmSync(dir, { recursive: true, force: true });
  });

  test("restore snapshot overwrites generated files", () => {
    const dir = makeTempDir();
    const genDir = join(dir, "generated");
    const snapshotsDir = join(dir, ".snapshots");
    mkdirSync(genDir, { recursive: true });

    writeFileSync(join(genDir, "lexicon.json"), '{"original":true}');

    const snapshot = snapshotArtifacts(genDir);
    const snapshotPath = saveSnapshot(snapshot, snapshotsDir);

    writeFileSync(join(genDir, "lexicon.json"), '{"modified":true}');
    expect(readFileSync(join(genDir, "lexicon.json"), "utf-8")).toBe('{"modified":true}');

    restoreSnapshot(snapshotPath, genDir);
    expect(readFileSync(join(genDir, "lexicon.json"), "utf-8")).toBe('{"original":true}');

    rmSync(dir, { recursive: true, force: true });
  });

  test("listSnapshots returns empty for nonexistent dir", () => {
    const list = listSnapshots("/nonexistent/path");
    expect(list).toHaveLength(0);
  });
});
