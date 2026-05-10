/**
 * Live-state diff: compares declared vs observed-now vs observed-then.
 *
 * Produces structured drift signal — *what is in the cloud right now* against
 * both *what was declared in source* and *what was observed at the last
 * snapshot*. Pure function; all I/O happens in the caller.
 *
 * Two diff flavors:
 *   - diffLive       — entity-keyed (declared ↔ observedNow ↔ observedThen)
 *   - diffLiveArtifacts — context-keyed (observedNow ↔ observedThen only;
 *                        no `declared` axis since artifacts aren't declared
 *                        as chant entities — they're created by tooling
 *                        outside chant's entity model)
 */
import type { ResourceMetadata, ArtifactMetadata } from "../lexicon";

export interface AttributeChange {
  /** Attribute path (e.g. "status", "physicalId", "attributes.tags.env"). */
  path: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface ResourceDrift {
  name: string;
  type: string;
  changes: AttributeChange[];
}

export interface LiveDiffResult {
  /** Declared in current build, but not observed in cloud right now. */
  missing: string[];
  /** Observed in cloud right now, but not declared. */
  orphan: string[];
  /** Was in last snapshot but isn't observed now. */
  disappeared: string[];
  /** Observed now and declared, but not in the previous snapshot. */
  newlyObserved: string[];
  /** Observed both then and now; metadata changed. */
  driftedSinceSnapshot: ResourceDrift[];
  /** Observed both then and now; metadata identical. */
  unchanged: string[];
}

export interface DiffLiveInput {
  /** Entity names from the current build. */
  declared: Set<string>;
  /** Resources returned by `plugin.describeResources()` right now. */
  observedNow: Record<string, ResourceMetadata>;
  /** Resources captured by the previous snapshot, if any. */
  observedThen: Record<string, ResourceMetadata> | undefined;
}

const TRACKED_FIELDS: Array<keyof ResourceMetadata> = [
  "status",
  "physicalId",
  "lastUpdated",
];

function compareMetadata(
  oldMeta: ResourceMetadata,
  newMeta: ResourceMetadata,
): AttributeChange[] {
  const changes: AttributeChange[] = [];

  for (const field of TRACKED_FIELDS) {
    if (oldMeta[field] !== newMeta[field]) {
      changes.push({ path: field, oldValue: oldMeta[field], newValue: newMeta[field] });
    }
  }

  const oldAttrs = oldMeta.attributes ?? {};
  const newAttrs = newMeta.attributes ?? {};
  const allAttrKeys = new Set([...Object.keys(oldAttrs), ...Object.keys(newAttrs)]);
  for (const key of allAttrKeys) {
    const oldValue = oldAttrs[key];
    const newValue = newAttrs[key];
    if (!shallowEqual(oldValue, newValue)) {
      changes.push({ path: `attributes.${key}`, oldValue, newValue });
    }
  }

  return changes;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function diffLive(input: DiffLiveInput): LiveDiffResult {
  const { declared, observedNow, observedThen } = input;
  const observedThenMap = observedThen ?? {};
  const observedNowNames = new Set(Object.keys(observedNow));
  const observedThenNames = new Set(Object.keys(observedThenMap));

  const missing: string[] = [];
  const orphan: string[] = [];
  const disappeared: string[] = [];
  const newlyObserved: string[] = [];
  const driftedSinceSnapshot: ResourceDrift[] = [];
  const unchanged: string[] = [];

  // Declared but not observed in cloud right now → missing
  for (const name of declared) {
    if (!observedNowNames.has(name)) {
      missing.push(name);
    }
  }

  // In cloud right now but not declared → orphan
  for (const name of observedNowNames) {
    if (!declared.has(name)) {
      orphan.push(name);
    }
  }

  // In previous snapshot but not observed now → disappeared
  for (const name of observedThenNames) {
    if (!observedNowNames.has(name)) {
      disappeared.push(name);
    }
  }

  // Observed now: classify drift relative to previous snapshot
  for (const name of observedNowNames) {
    const now = observedNow[name];
    const then = observedThenMap[name];
    if (!then) {
      if (declared.has(name)) {
        newlyObserved.push(name);
      }
      // else: orphan, already classified above
      continue;
    }
    const changes = compareMetadata(then, now);
    if (changes.length === 0) {
      unchanged.push(name);
    } else {
      driftedSinceSnapshot.push({
        name,
        type: now.type,
        changes,
      });
    }
  }

  return {
    missing: missing.sort(),
    orphan: orphan.sort(),
    disappeared: disappeared.sort(),
    newlyObserved: newlyObserved.sort(),
    driftedSinceSnapshot: driftedSinceSnapshot.sort((a, b) => a.name.localeCompare(b.name)),
    unchanged: unchanged.sort(),
  };
}

// ── Artifact diff (no `declared` axis) ──────────────────────────────────────

export interface LiveArtifactDiffResult {
  /** Observed now, not in previous snapshot. */
  added: string[];
  /** In previous snapshot, not observed now. */
  removed: string[];
  /** In both; metadata changed. */
  changed: ResourceDrift[];
  /** In both; metadata identical. */
  unchanged: string[];
}

export interface DiffLiveArtifactsInput {
  /** Artifacts returned by `plugin.listArtifacts()` right now. */
  observedNow: Record<string, ArtifactMetadata>;
  /** Artifacts captured by the previous snapshot, if any. */
  observedThen: Record<string, ArtifactMetadata> | undefined;
}

export function diffLiveArtifacts(input: DiffLiveArtifactsInput): LiveArtifactDiffResult {
  const observedThenMap = input.observedThen ?? {};
  const nowNames = new Set(Object.keys(input.observedNow));
  const thenNames = new Set(Object.keys(observedThenMap));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: ResourceDrift[] = [];
  const unchanged: string[] = [];

  for (const name of nowNames) {
    if (!thenNames.has(name)) {
      added.push(name);
      continue;
    }
    const now = input.observedNow[name];
    const then = observedThenMap[name];
    const diffs = compareMetadata(then, now);
    if (diffs.length === 0) {
      unchanged.push(name);
    } else {
      changed.push({ name, type: now.type, changes: diffs });
    }
  }

  for (const name of thenNames) {
    if (!nowNames.has(name)) removed.push(name);
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort((a, b) => a.name.localeCompare(b.name)),
    unchanged: unchanged.sort(),
  };
}
