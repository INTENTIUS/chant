/**
 * Build digest: fingerprints of resource declarations + dependency graph.
 *
 * The digest captures *what was declared* at a point in time, enabling
 * diff operations without re-parsing templates.
 */
import type { BuildResult } from "../build";
import type { Declarable } from "../declarable";
import type { BuildDigest, ResourceDigest, DigestDiff } from "./types";
import { sortedJsonReplacer } from "../utils";
import { getRuntime } from "../runtime-adapter";

/**
 * Hash an entity's props deterministically.
 */
export function hashProps(props: unknown): string {
  const json = JSON.stringify(props, sortedJsonReplacer);
  return getRuntime().hash(json);
}

/**
 * Compute a full build digest from a BuildResult.
 */
export function computeBuildDigest(buildResult: BuildResult): BuildDigest {
  const resources: Record<string, ResourceDigest> = {};

  for (const [name, entity] of buildResult.entities) {
    const props = "props" in entity && entity.props != null ? entity.props : {};
    resources[name] = {
      type: entity.entityType,
      lexicon: entity.lexicon,
      propsHash: hashProps(props),
    };
  }

  // Convert dependency Map<string, Set<string>> to Record<string, string[]>
  const dependencies: Record<string, string[]> = {};
  for (const [name, deps] of buildResult.dependencies) {
    dependencies[name] = Array.from(deps);
  }

  return {
    resources,
    dependencies,
    outputs: buildResult.manifest.outputs,
    deployOrder: buildResult.manifest.deployOrder,
  };
}

/**
 * Compare two digests and categorize resources.
 */
export function diffDigests(
  current: BuildDigest,
  previous: BuildDigest | undefined,
): DigestDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  if (!previous) {
    // No previous digest — everything is added
    added.push(...Object.keys(current.resources));
    return { added, removed, changed, unchanged };
  }

  // Check current resources against previous
  for (const name of Object.keys(current.resources)) {
    const prev = previous.resources[name];
    if (!prev) {
      added.push(name);
    } else if (current.resources[name].propsHash !== prev.propsHash) {
      changed.push(name);
    } else {
      unchanged.push(name);
    }
  }

  // Check for removed resources
  for (const name of Object.keys(previous.resources)) {
    if (!(name in current.resources)) {
      removed.push(name);
    }
  }

  return { added, removed, changed, unchanged };
}
