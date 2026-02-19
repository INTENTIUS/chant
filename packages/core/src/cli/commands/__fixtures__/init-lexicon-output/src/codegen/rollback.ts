import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, cpSync } from "fs";
import { join, basename } from "path";

export interface Snapshot {
  timestamp: string;
  resources: number;
  path: string;
}

/**
 * List available generation snapshots.
 */
export function listSnapshots(snapshotsDir: string): Snapshot[] {
  if (!existsSync(snapshotsDir)) return [];

  return readdirSync(snapshotsDir)
    .filter((d) => !d.startsWith("."))
    .sort()
    .reverse()
    .map((dir) => {
      const fullPath = join(snapshotsDir, dir);
      const metaPath = join(fullPath, "meta.json");
      let resources = 0;
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
          resources = meta.resources ?? 0;
        } catch {}
      }
      return { timestamp: dir, resources, path: fullPath };
    });
}

/**
 * Restore a snapshot to the generated directory.
 */
export function restoreSnapshot(timestamp: string, generatedDir: string): void {
  const snapshotsDir = join(generatedDir, "..", "..", ".snapshots");
  const snapshotDir = join(snapshotsDir, timestamp);
  if (!existsSync(snapshotDir)) {
    throw new Error(`Snapshot not found: ${timestamp}`);
  }
  mkdirSync(generatedDir, { recursive: true });
  cpSync(snapshotDir, generatedDir, { recursive: true });
}
