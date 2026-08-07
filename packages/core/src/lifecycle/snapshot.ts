/**
 * Snapshot orchestration: queries plugins for deployed resource metadata,
 * assembles LifecycleSnapshots, computes build digests, and writes to git.
 */
import type { ObservationLexicon, ResourceMetadata, ArtifactMetadata } from "../lexicon";
import type { BuildResult } from "../build";
import type { SerializerResult } from "../serializer";
import type { LifecycleSnapshot, ObservationDepth } from "./types";
import { observeDeep } from "./deep-observe";
import type { DeepResourceObservation } from "../deep-observation";
import { computeBuildDigest } from "./digest";
import { collectDependencies, collectAmbient } from "./observe";
import { writeSnapshot, snapshotStorageKey, getHeadCommit, pushLifecycle } from "./git";
import { sortedJsonReplacer } from "../utils";
import { formatUnobserved, normalizeObservation, unobservedAll, type UnobservedEntity } from "../observation";
// One list of secret-bearing property names for both observation depths
// (#1014): the thin path warns on them here, the deep path masks them before a
// property tree is ever rendered or committed. Two lists would eventually
// disagree about what counts as a secret.
import { isSensitiveKey } from "../deep-observation";
import { isResourceDeclarable } from "../declarable";

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
      if (isSensitiveKey(attrName)) {
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
  opts?: {
    cwd?: string;
    stack?: string;
    region?: string;
    deep?: boolean;
    ambient?: boolean;
    /** Kinds the PROJECT manages, not just this stack — a region whose stack
     * declares no security group still has a default one (#1278). */
    ambientKinds?: string[];
  },
): Promise<TakeSnapshotResult> {
  const stack = opts?.stack;
  const depth: ObservationDepth = opts?.deep ? "deep" : "identity";
  // A stack declares the region it deploys to (#1261). Passing it through is
  // what lets a multi-region estate be observed at all: the reader targets the
  // stack's own region rather than whichever one the shell happens to be set
  // to, so out-of-region stacks stop coming back empty.
  const region = opts?.region;
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
      // Resource declarables only — outputs, parameters and serializer
      // directives have no live counterpart (see lifecycle/observe.ts).
      if (entity.lexicon === plugin.name && isResourceDeclarable(entity)) {
        entityNames.push(name);
        entities.set(name, {
          entityType: entity.entityType,
          props: (entity.props != null ? entity.props : {}) as Record<string, unknown>,
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
            region,
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
        // No region: artifacts are registry/chart objects (docker, helm), not
        // regional cloud resources, and `listArtifacts` takes no region.
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

      // The deep read is a second pass, after identity is known to be readable
      // (#1267). Keeping it separate means a lexicon with no deep reader still
      // snapshots exactly as before, and a deep read that comes back empty
      // downgrades the record rather than discarding an identity snapshot that
      // was already good.
      let properties: Record<string, DeepResourceObservation> | undefined;
      let recordedDepth: ObservationDepth = "identity";
      if (depth === "deep") {
        if (!plugin.observeResourcesDeep) {
          warnings.push(
            `${plugin.name}: no deep reader — recording an identity snapshot; property questions cannot be answered from it`,
          );
        } else {
          const observed = await observeDeep(plugin, {
            environment,
            buildOutput,
            entities,
            ...(stack ? { stack } : {}),
            ...(region ? { region } : {}),
          });
          for (const [name, entry] of Object.entries(observed.unobserved)) {
            warnings.push(`${plugin.name}: not observed deeply — ${formatUnobserved(name, entry)}`);
          }
          if (Object.keys(observed.resources).length > 0) {
            properties = observed.resources;
            recordedDepth = "deep";
          } else {
            warnings.push(
              `${plugin.name}: deep read returned no properties — recording an identity snapshot`,
            );
          }
        }
      }
      // What this estate depends on but does not manage (#1273), recorded so a
      // replayed snapshot can answer the same questions a live read can (#1266).
      // Without them a snapshot holds the managed resources and no route to the
      // account's default VPC, so `internetFacing` is unanswerable from it —
      // which would make `search --at` quietly weaker than `search --live`.
      const dependencies = await collectDependencies(plugin, {
        environment,
        entities,
        observed: resources,
        stacks: stack ? [{ name: stack, ...(region ? { region } : {}) }] : [],
      });
      for (const message of dependencies.warnings) warnings.push(message);
      // Ambient resources (#1278) are recorded too when asked for, so a replayed
      // snapshot can answer "which of these are unused" without a live read.
      // Without this `search --at --ambient` filters a set that was never
      // recorded and silently returns nothing.
      const ambient = opts?.ambient
        ? await collectAmbient(plugin, {
            environment,
            kinds: opts?.ambientKinds ?? [...new Set([...entities.values()].map((e) => e.entityType))],
            observed: resources,
            stacks: stack ? [{ name: stack, ...(region ? { region } : {}) }] : [],
            warnings,
          })
        : {};
      const withDependencies = { ...resources, ...dependencies.resources, ...ambient };

      const snapshot: LifecycleSnapshot = {
        lexicon: plugin.name,
        environment,
        ...(stack ? { stack } : {}),
        commit: headCommit,
        timestamp,
        resources: withDependencies,
        ...(dependencies.edges.length > 0 ? { edges: dependencies.edges } : {}),
        ...(Object.keys(unobserved).length > 0 && { unobserved }),
        ...(Object.keys(artifacts).length > 0 && { artifacts }),
        // Only written when deep. An absent field means identity, which is what
        // every snapshot taken before #1267 was.
        ...(recordedDepth === "deep" && { depth: recordedDepth, properties }),
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
