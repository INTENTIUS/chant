/**
 * Snapshot orchestration: queries plugins for deployed resource metadata,
 * assembles LifecycleSnapshots, computes build digests, and writes to git.
 */
import type { ObservationLexicon, ResourceMetadata, ArtifactMetadata } from "../lexicon";
import type { BuildResult } from "../build";
import type { SerializerResult } from "../serializer";
import type { LifecycleSnapshot } from "./types";
import { computeBuildDigest } from "./digest";
import { writeSnapshot, snapshotStorageKey, getHeadCommit, pushLifecycle } from "./git";
import { sortedJsonReplacer } from "../utils";
import { formatUnobserved, normalizeObservation, unobservedAll, type UnobservedEntity } from "../observation";

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
  opts?: { cwd?: string; stack?: string },
): Promise<TakeSnapshotResult> {
  const stack = opts?.stack;
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
    let unobserved: Record<string, UnobservedEntity> = {};

    try {
      if (plugin.describeResources) {
        const observed = normalizeObservation(
          await plugin.describeResources({
            environment,
            buildOutput,
            entityNames,
            entities,
            stack,
          }),
        );
        const { valid, dropped, warnings: validationWarnings } = validateResources(observed.resources);
        warnings.push(...validationWarnings);
        if (dropped.length > 0) {
          warnings.push(`${plugin.name}: dropped ${dropped.length} invalid resource(s)`);
        }
        resources = valid;
        // Record the holes (#1089). A snapshot is evidence of what was seen; an
        // entity nobody could read must not be recorded as "was not there",
        // because the next diff would then read it back as absent.
        unobserved = observed.unobserved;
        for (const [name, entry] of Object.entries(unobserved)) {
          warnings.push(`${plugin.name}: not observed — ${formatUnobserved(name, entry)}`);
        }
      }

      if (plugin.listArtifacts) {
        const raw = await plugin.listArtifacts({ environment, entities, stack });
        const { valid, dropped, warnings: validationWarnings } = validateResources(raw);
        warnings.push(...validationWarnings);
        if (dropped.length > 0) {
          warnings.push(`${plugin.name}: dropped ${dropped.length} invalid artifact(s)`);
        }
        artifacts = valid;
      }

      if (Object.keys(resources).length === 0 && Object.keys(artifacts).length === 0) {
        const unreadable = Object.keys(unobserved).length;
        errors.push(
          unreadable > 0
            ? `${plugin.name}: nothing observed — ${unreadable} declared entity(ies) could not be read (see warnings); not snapshotting an unread environment as empty`
            : `${plugin.name}: no valid resources or artifacts returned`,
        );
        continue;
      }

      const snapshot: LifecycleSnapshot = {
        lexicon: plugin.name,
        environment,
        ...(stack ? { stack } : {}),
        commit: headCommit,
        timestamp,
        resources,
        ...(Object.keys(unobserved).length > 0 && { unobserved }),
        ...(Object.keys(artifacts).length > 0 && { artifacts }),
        digest,
      };

      snapshots.push(snapshot);
    } catch (err) {
      // A thrown read is not an empty environment — record nothing and say so
      // (#1089). Writing a snapshot here would persist "none of this exists".
      errors.push(
        `${plugin.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      const message = err instanceof Error ? err.message : String(err);
      for (const [name, entry] of Object.entries(
        unobservedAll(entityNames, "read-failed", message, entities),
      )) {
        warnings.push(`${plugin.name}: not observed — ${formatUnobserved(name, entry)}`);
      }
    }
  }

  // Write all successful snapshots to git
  let commitSha = "";
  for (const snapshot of snapshots) {
    const json = JSON.stringify(snapshot, sortedJsonReplacer, 2);
    commitSha = await writeSnapshot(
      snapshot.environment,
      snapshotStorageKey(snapshot.lexicon, snapshot.stack),
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
