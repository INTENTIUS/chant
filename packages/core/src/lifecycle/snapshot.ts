/**
 * Snapshot orchestration: queries plugins for deployed resource metadata,
 * assembles LifecycleSnapshots, computes build digests, and writes to git.
 */
import type { ObservationLexicon, ResourceMetadata, ArtifactMetadata } from "../lexicon";
import type { BuildResult } from "../build";
import type { SerializerResult } from "../serializer";
import type { LifecycleSnapshot } from "./types";
import { computeBuildDigest } from "./digest";
import { writeSnapshot, getHeadCommit, pushLifecycle } from "./git";
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
  snapshots: LifecycleSnapshot[];
  commit: string;
  warnings: string[];
  errors: string[];
}

/**
 * Take state snapshots for all plugins that implement describeResources.
 */
export async function takeSnapshot(
  environment: string,
  plugins: ObservationLexicon[],
  buildResult: BuildResult,
  opts?: { cwd?: string },
): Promise<TakeSnapshotResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const snapshots: LifecycleSnapshot[] = [];

  const headCommit = await getHeadCommit(opts);
  const timestamp = new Date().toISOString();
  const digest = computeBuildDigest(buildResult);

  for (const plugin of plugins) {
    if (!plugin.describeResources && !plugin.listArtifacts) continue;

    // Get serialized build output for this lexicon
    const rawOutput = buildResult.outputs.get(plugin.name);
    const buildOutput =
      rawOutput === undefined
        ? ""
        : typeof rawOutput === "string"
          ? rawOutput
          : (rawOutput as SerializerResult).primary;

    // Get entity names + entity props for this lexicon
    const entityNames: string[] = [];
    const entities = new Map<string, { entityType: string; props: Record<string, unknown> }>();
    for (const [name, entity] of buildResult.entities) {
      if (entity.lexicon === plugin.name) {
        entityNames.push(name);
        entities.set(name, {
          entityType: entity.entityType,
          props: ("props" in entity && entity.props != null
            ? entity.props
            : {}) as Record<string, unknown>,
        });
      }
    }

    let resources: Record<string, ResourceMetadata> = {};
    let artifacts: Record<string, ArtifactMetadata> = {};

    try {
      if (plugin.describeResources) {
        const raw = await plugin.describeResources({
          environment,
          buildOutput,
          entityNames,
          entities,
        });
        const { valid, dropped, warnings: validationWarnings } = validateResources(raw);
        warnings.push(...validationWarnings);
        if (dropped.length > 0) {
          warnings.push(`${plugin.name}: dropped ${dropped.length} invalid resource(s)`);
        }
        resources = valid;
      }

      if (plugin.listArtifacts) {
        const raw = await plugin.listArtifacts({ environment, entities });
        const { valid, dropped, warnings: validationWarnings } = validateResources(raw);
        warnings.push(...validationWarnings);
        if (dropped.length > 0) {
          warnings.push(`${plugin.name}: dropped ${dropped.length} invalid artifact(s)`);
        }
        artifacts = valid;
      }

      if (Object.keys(resources).length === 0 && Object.keys(artifacts).length === 0) {
        errors.push(`${plugin.name}: no valid resources or artifacts returned`);
        continue;
      }

      const snapshot: LifecycleSnapshot = {
        lexicon: plugin.name,
        environment,
        commit: headCommit,
        timestamp,
        resources,
        ...(Object.keys(artifacts).length > 0 && { artifacts }),
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
    await pushLifecycle(opts);
  }

  return {
    snapshots,
    commit: commitSha,
    warnings,
    errors,
  };
}
