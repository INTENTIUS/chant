/**
 * Artifact snapshot and restore for generation rollback.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { hashArtifact } from "../lexicon-integrity";

export interface ArtifactSnapshot {
  timestamp: string;
  files: Record<string, string>;
  hashes: Record<string, string>;
  resourceCount: number;
}

export interface SnapshotInfo {
  path: string;
  timestamp: string;
  resourceCount: number;
}

const DEFAULT_ARTIFACT_NAMES = ["lexicon.json", "index.d.ts", "index.ts"];

/**
 * Snapshot current generated artifacts.
 *
 * @param generatedDir - Directory containing generated artifacts
 * @param artifactNames - List of filenames to snapshot (defaults to generic names)
 */
export function snapshotArtifacts(
  generatedDir: string,
  artifactNames: string[] = DEFAULT_ARTIFACT_NAMES,
): ArtifactSnapshot {
  const files: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  let resourceCount = 0;

  for (const entry of artifactNames) {
    const path = join(generatedDir, entry);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      files[entry] = content;
      hashes[entry] = hashArtifact(content);

      // Count resources in any .json artifact
      if (entry.endsWith(".json")) {
        try {
          const parsed = JSON.parse(content);
          resourceCount = Object.values(parsed).filter(
            (e: any) => e && typeof e === "object" && e.kind === "resource"
          ).length;
        } catch {}
      }
    }
  }

  return {
    timestamp: new Date().toISOString(),
    files,
    hashes,
    resourceCount,
  };
}

/**
 * Save a snapshot to the .snapshots directory.
 */
export function saveSnapshot(snapshot: ArtifactSnapshot, snapshotsDir: string): string {
  mkdirSync(snapshotsDir, { recursive: true });

  const filename = `${snapshot.timestamp.replace(/[:.]/g, "-")}.json`;
  const path = join(snapshotsDir, filename);
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
  return path;
}

/**
 * Restore a snapshot to the generated directory.
 */
export function restoreSnapshot(snapshotPath: string, generatedDir: string): void {
  const raw = readFileSync(snapshotPath, "utf-8");
  const snapshot: ArtifactSnapshot = JSON.parse(raw);

  mkdirSync(generatedDir, { recursive: true });
  for (const [filename, content] of Object.entries(snapshot.files)) {
    writeFileSync(join(generatedDir, filename), content);
  }
}

/**
 * List available snapshots.
 */
export function listSnapshots(snapshotsDir: string): SnapshotInfo[] {
  if (!existsSync(snapshotsDir)) return [];

  const entries = readdirSync(snapshotsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  const snapshots: SnapshotInfo[] = [];
  for (const entry of entries) {
    try {
      const path = join(snapshotsDir, entry);
      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw);
      snapshots.push({
        path,
        timestamp: data.timestamp,
        resourceCount: data.resourceCount ?? 0,
      });
    } catch {}
  }

  return snapshots;
}
