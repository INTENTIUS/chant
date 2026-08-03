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
    // chant #1442 — what interpreted the declarations, alongside what was
    // declared. Always present on a freshly computed digest, so "absent"
    // unambiguously means "recorded before #1442".
    lexiconVersions: { ...buildResult.lexiconVersions },
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
    // No previous digest — everything is added, and there is no version to
    // have moved away from.
    added.push(...Object.keys(current.resources));
    return { added, removed, changed, unchanged, lexiconVersionChanges: [] };
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

  return { added, removed, changed, unchanged, lexiconVersionChanges: diffLexiconVersions(current, previous) };
}

/**
 * Lexicons whose version moved between two digests (chant #1442).
 *
 * A digest recorded before this existed has no `lexiconVersions` at all. That
 * is reported as no change rather than as every lexicon appearing — comparing
 * against an older snapshot must not manufacture a difference that the older
 * build simply never recorded.
 */
function diffLexiconVersions(
  current: BuildDigest,
  previous: BuildDigest,
): Array<{ lexicon: string; previous?: string; current?: string }> {
  if (!current.lexiconVersions || !previous.lexiconVersions) return [];

  const changes: Array<{ lexicon: string; previous?: string; current?: string }> = [];
  for (const lexicon of new Set([
    ...Object.keys(current.lexiconVersions),
    ...Object.keys(previous.lexiconVersions),
  ])) {
    const now = current.lexiconVersions[lexicon];
    const before = previous.lexiconVersions[lexicon];
    if (now !== before) changes.push({ lexicon, previous: before, current: now });
  }
  return changes.sort((a, b) => a.lexicon.localeCompare(b.lexicon));
}
