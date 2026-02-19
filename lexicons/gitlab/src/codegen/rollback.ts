/**
 * Rollback and snapshot management for GitLab CI lexicon.
 *
 * Wraps the core rollback module with GitLab-specific artifact names.
 */

export type { ArtifactSnapshot, SnapshotInfo } from "@intentius/chant/codegen/rollback";
export {
  snapshotArtifacts,
  saveSnapshot,
  restoreSnapshot,
  listSnapshots,
} from "@intentius/chant/codegen/rollback";

/**
 * GitLab-specific artifact filenames to snapshot.
 */
export const GITLAB_ARTIFACT_NAMES = ["lexicon-gitlab.json", "index.d.ts", "index.ts"];

/**
 * Snapshot GitLab lexicon artifacts.
 */
export function snapshotGitLabArtifacts(generatedDir: string) {
  const { snapshotArtifacts } = require("@intentius/chant/codegen/rollback");
  return snapshotArtifacts(generatedDir, GITLAB_ARTIFACT_NAMES);
}
