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
import type { UnobservedEntity, UnobservedReason } from "../observation";

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

/** A declared entity the lexicon could not observe, as reported by the diff (#1089). */
export interface UnobservedResource {
  name: string;
  type?: string;
  reason: UnobservedReason;
  detail?: string;
}

export interface LiveDiffResult {
  /**
   * Declared in current build, and the provider reported it absent. Entities
   * the lexicon could not observe are NOT here — they are in `unobserved`
   * (#1089), so "missing" keeps meaning "confirmed not there".
   */
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
  /**
   * Declared, and the lexicon could not look (#1089) — no reader for the kind,
   * the read failed, no credentials, no binding. Not drift, not absence: a hole
   * in the observation. Sorted by name.
   */
  unobserved: UnobservedResource[];
}

export interface DiffLiveInput {
  /** Entity names from the current build. */
  declared: Set<string>;
  /** Resources returned by `plugin.describeResources()` right now. */
  observedNow: Record<string, ResourceMetadata>;
  /** Resources captured by the previous snapshot, if any. */
  observedThen: Record<string, ResourceMetadata> | undefined;
  /**
   * Declared entities `describeResources()` reported as NOT-OBSERVED (#1089),
   * keyed by entity name. Absent/empty means every declared entity was looked
   * at, so absence from `observedNow` is a confirmed absence.
   */
  unobserved?: Record<string, UnobservedEntity>;
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

/** The delta between two saved snapshots (#822): a two-way observed diff. */
export interface SnapshotDiffResult {
  /** In `next`, not in `prev`. */
  added: string[];
  /** In `prev`, not in `next`. */
  removed: string[];
  /** In both; metadata differs (with the attribute-level changes). */
  changed: ResourceDrift[];
  /** In both; metadata identical. */
  unchanged: string[];
}

/**
 * Diff two **observed** snapshots (#822) — `prev` vs `next`, each a resources map
 * read from the orphan branch. A two-way diff (no "declared" axis), so it answers
 * "what changed in the cloud between two points" independent of source. Pure and
 * deterministic (results sorted). Feeds the deployment-lanes frame-pair diff.
 */
export function diffSnapshots(
  prev: Record<string, ResourceMetadata>,
  next: Record<string, ResourceMetadata>,
): SnapshotDiffResult {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: ResourceDrift[] = [];
  const unchanged: string[] = [];
  for (const name of [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort()) {
    const a = prev[name];
    const b = next[name];
    if (!a && b) added.push(name);
    else if (a && !b) removed.push(name);
    else if (a && b) {
      const changes = compareMetadata(a, b);
      if (changes.length > 0) changed.push({ name, type: b.type ?? a.type, changes });
      else unchanged.push(name);
    }
  }
  return { added, removed, changed, unchanged };
}

export function diffLive(input: DiffLiveInput): LiveDiffResult {
  const { declared, observedNow, observedThen } = input;
  const observedThenMap = observedThen ?? {};
  const observedNowNames = new Set(Object.keys(observedNow));
  const observedThenNames = new Set(Object.keys(observedThenMap));
  // A resource the lexicon returned is observed, whatever it also said about
  // it — present beats not-observed.
  const unobservedMap = input.unobserved ?? {};
  const unobservedNames = new Set(
    Object.keys(unobservedMap).filter((n) => !observedNowNames.has(n)),
  );

  const missing: string[] = [];
  const orphan: string[] = [];
  const disappeared: string[] = [];
  const newlyObserved: string[] = [];
  const driftedSinceSnapshot: ResourceDrift[] = [];
  const unchanged: string[] = [];
  const unobserved: UnobservedResource[] = [];

  for (const name of unobservedNames) {
    const entry = unobservedMap[name];
    unobserved.push({
      name,
      ...(entry.type ? { type: entry.type } : {}),
      reason: entry.reason,
      ...(entry.detail ? { detail: entry.detail } : {}),
    });
  }

  // Declared, looked at, and the provider said it isn't there → missing.
  // Declared but never looked at is `unobserved`, not missing — the whole point
  // of #1089: "we didn't check" must not read as "it isn't there".
  for (const name of declared) {
    if (!observedNowNames.has(name) && !unobservedNames.has(name)) {
      missing.push(name);
    }
  }

  // In cloud right now but not declared → orphan
  for (const name of observedNowNames) {
    if (!declared.has(name)) {
      orphan.push(name);
    }
  }

  // In previous snapshot but not observed now → disappeared. An entity nobody
  // could look at has not disappeared; it is unobserved.
  for (const name of observedThenNames) {
    if (!observedNowNames.has(name) && !unobservedNames.has(name)) {
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
    unobserved: unobserved.sort((a, b) => a.name.localeCompare(b.name)),
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
