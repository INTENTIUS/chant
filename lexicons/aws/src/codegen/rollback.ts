/**
 * Re-export from core with AWS-specific artifact names.
 */
import {
  snapshotArtifacts as _snapshotArtifacts,
  saveSnapshot,
  restoreSnapshot,
  listSnapshots,
} from "@intentius/chant/codegen/rollback";
export type { ArtifactSnapshot, SnapshotInfo } from "@intentius/chant/codegen/rollback";
export { saveSnapshot, restoreSnapshot, listSnapshots };

const AWS_ARTIFACT_NAMES = ["lexicon-aws.json", "index.d.ts", "index.ts"];

/**
 * Snapshot AWS lexicon artifacts.
 */
export function snapshotArtifacts(generatedDir: string) {
  return _snapshotArtifacts(generatedDir, AWS_ARTIFACT_NAMES);
}
