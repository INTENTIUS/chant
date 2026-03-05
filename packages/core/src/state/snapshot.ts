/**
 * Snapshot orchestration: queries plugins for deployed resource metadata,
 * assembles StateSnapshots, computes build digests, and writes to git.
 */
import type { LexiconPlugin, ResourceMetadata } from "../lexicon";
import type { BuildResult } from "../build";
import type { SerializerResult } from "../serializer";
import type { StateSnapshot } from "./types";
import { computeBuildDigest } from "./digest";
import { writeSnapshot, getHeadCommit, pushState } from "./git";
import { sortedJsonReplacer } from "../utils";

/** Patterns in attribute names that suggest sensitive data. */
const SENSITIVE_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /private.?key/i,
  /credential/i,
  /connection.?string/i,
];

/**
 * Check for potential sensitive data in resource attributes and return warnings.
 */
function checkSensitiveData(
  resources: Record<string, ResourceMetadata>,
): string[] {
  const warnings: string[] = [];
  for (const [name, meta] of Object.entries(resources)) {
    if (!meta.attributes) continue;
    for (const attrName of Object.keys(meta.attributes)) {
      if (SENSITIVE_PATTERNS.some((p) => p.test(attrName))) {
        warnings.push(
          `Potential sensitive data in ${name}.attributes.${attrName} — ensure it is scrubbed`,
        );
      }
    }
  }
  return warnings;
}

/**
 * Validate ResourceMetadata entries — resources must have at least type and status.
 * Returns { valid, dropped, warnings }.
 */
function validateResources(
  resources: Record<string, ResourceMetadata>,
): {
  valid: Record<string, ResourceMetadata>;
  dropped: string[];
  warnings: string[];
} {
  const valid: Record<string, ResourceMetadata> = {};
  const dropped: string[] = [];
  const warnings: string[] = [];

  for (const [name, meta] of Object.entries(resources)) {
    if (!meta.type || !meta.status) {
      dropped.push(name);
      warnings.push(`Dropped ${name}: missing type or status`);
      continue;
    }
    valid[name] = meta;
  }

  // Check for sensitive data in valid resources
  warnings.push(...checkSensitiveData(valid));

  return { valid, dropped, warnings };
}

export interface TakeSnapshotResult {
  snapshots: StateSnapshot[];
  commit: string;
  warnings: string[];
  errors: string[];
}

/**
 * Take state snapshots for all plugins that implement describeResources.
 */
export async function takeSnapshot(
  environment: string,
  plugins: LexiconPlugin[],
  buildResult: BuildResult,
  opts?: { cwd?: string },
): Promise<TakeSnapshotResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const snapshots: StateSnapshot[] = [];

  const headCommit = await getHeadCommit(opts);
  const timestamp = new Date().toISOString();
  const digest = computeBuildDigest(buildResult);

  for (const plugin of plugins) {
    if (!plugin.describeResources) continue;

    // Get serialized build output for this lexicon
    const rawOutput = buildResult.outputs.get(plugin.name);
    const buildOutput =
      rawOutput === undefined
        ? ""
        : typeof rawOutput === "string"
          ? rawOutput
          : (rawOutput as SerializerResult).primary;

    // Get entity names for this lexicon
    const entityNames: string[] = [];
    for (const [name, entity] of buildResult.entities) {
      if (entity.lexicon === plugin.name) {
        entityNames.push(name);
      }
    }

    try {
      const resources = await plugin.describeResources({
        environment,
        buildOutput,
        entityNames,
      });

      const { valid, dropped, warnings: validationWarnings } =
        validateResources(resources);
      warnings.push(...validationWarnings);

      if (dropped.length > 0) {
        warnings.push(
          `${plugin.name}: dropped ${dropped.length} invalid resource(s)`,
        );
      }

      if (Object.keys(valid).length === 0) {
        errors.push(`${plugin.name}: no valid resources returned`);
        continue;
      }

      const snapshot: StateSnapshot = {
        lexicon: plugin.name,
        environment,
        commit: headCommit,
        timestamp,
        resources: valid,
        digest,
      };

      snapshots.push(snapshot);
    } catch (err) {
      errors.push(
        `${plugin.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Write all successful snapshots to git
  let commitSha = "";
  for (const snapshot of snapshots) {
    const json = JSON.stringify(snapshot, sortedJsonReplacer, 2);
    commitSha = await writeSnapshot(
      snapshot.environment,
      snapshot.lexicon,
      json,
      opts,
    );
  }

  // Push to remote
  if (snapshots.length > 0) {
    await pushState(opts);
  }

  return {
    snapshots,
    commit: commitSha,
    warnings,
    errors,
  };
}
