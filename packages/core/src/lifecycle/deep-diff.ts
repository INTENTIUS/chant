/**
 * Property-level live drift (#1014) — declared vs live vs accepted baseline.
 *
 * The thin diff (./live-diff.ts) compares whole entities on status, physical id
 * and a few outputs. This compares their property trees, path by path, which is
 * where a console edit actually shows up. Pure function; the reading happens in
 * ./deep-observe.ts and the CLI.
 *
 * Three axes, and all three matter:
 *
 *   - **declared** — the property tree chant synthesized, normalized with the
 *     lexicon's own hooks so it is in the same shape as the live tree.
 *   - **live** — what the provider returned, normalized with the same hooks.
 *   - **baseline** — the value somebody accepted (./observation-baseline.ts). A
 *     deviation whose live value matches the accepted value is not drift; one
 *     that has moved away from the accepted value is drift again, and the
 *     report shows all three so the reader can see what changed and from what.
 *
 * A path is skipped entirely when the declared value is
 * {@link UNRESOLVED} — an unevaluated intrinsic (`Fn::Sub`, `Ref`) has no
 * source-side value to compare, and reporting one as drift would light up every
 * interpolated property forever.
 */

import {
  UNRESOLVED,
  deepValueEqual,
  flattenDeepProperties,
  type DeepNormalizationHooks,
  type NormalizedDeepObservation,
} from "../deep-observation";
import type { UnobservedResource } from "./live-diff";
import { acceptedDeviation, type BaselineLexicon } from "./observation-baseline";

/**
 * How a property differs.
 *
 * - `changed` — declared and live both have the path, with different values.
 * - `undeclared` — live has it, source never did. cdk-real-drift's whole reason
 *   to exist: the console-added property CloudFormation itself will not report.
 * - `absent` — source declares it and the live tree does not carry it. Weaker
 *   than the other two: a provider that omits a property it considers unset is
 *   common, which is what the lexicon's pruning hook is for.
 */
export type PropertyDriftKind = "changed" | "undeclared" | "absent";

/** One property-level difference. */
export interface PropertyDrift {
  /** Path within the normalized property tree (`Tags[0].Value`). */
  path: string;
  kind: PropertyDriftKind;
  /** Value in source. Absent for `undeclared`. */
  declared?: unknown;
  /** Value in the cloud. Absent for `absent`. */
  live?: unknown;
  /**
   * The accepted value from the baseline, when this path has one. Present on a
   * reported drift too — that is the "accepted X, now Y" case, and hiding the
   * accepted value there would lose the most useful column in the report.
   */
  baseline?: unknown;
}

/** Property-level drift for one declared entity. */
export interface DeepEntityDrift {
  name: string;
  type: string;
  changes: PropertyDrift[];
}

export interface DeepDiffResult {
  /** Entities with at least one reportable property difference. Sorted by name. */
  drifted: DeepEntityDrift[];
  /**
   * Differences suppressed by the baseline — reported separately rather than
   * dropped, so `--json` consumers and `--update-baseline` can see what is
   * being held back and the count never silently changes meaning.
   */
  accepted: DeepEntityDrift[];
  /** Entities whose property trees matched. Sorted. */
  unchanged: string[];
  /** Declared entities whose *properties* could not be read (#1089). Sorted. */
  unobserved: UnobservedResource[];
  /** Entities the deep reader returned that were never declared. Sorted. */
  undeclaredEntities: string[];
}

/** A declared entity's property tree, already normalized with the lexicon's hooks. */
export interface DeclaredDeepEntity {
  type: string;
  properties: Record<string, unknown>;
}

export interface DiffDeepInput {
  /** Normalized declared property trees, keyed by chant entity name. */
  declared: Record<string, DeclaredDeepEntity>;
  /** Normalized live observation, as returned by `observeResourcesDeep()`. */
  live: NormalizedDeepObservation;
  /** Accepted deviations for this lexicon. Omit for "nothing accepted". */
  baseline?: BaselineLexicon;
  /**
   * The lexicon's hooks, so set-like arrays are addressed by key rather than by
   * position (see `flattenDeepProperties`). Omit and paths are positional,
   * which still diffs correctly but shifts every path after an inserted
   * element.
   */
  hooks?: DeepNormalizationHooks;
}

/**
 * Compare declared and live property trees path by path, subtracting accepted
 * deviations. Deterministic: every list is sorted.
 */
export function diffDeep(input: DiffDeepInput): DeepDiffResult {
  const baseline = input.baseline ?? {};
  const drifted: DeepEntityDrift[] = [];
  const accepted: DeepEntityDrift[] = [];
  const unchanged: string[] = [];
  const unobserved: UnobservedResource[] = [];
  const undeclaredEntities: string[] = [];

  const liveNames = new Set(Object.keys(input.live.resources));

  for (const [name, entry] of Object.entries(input.live.unobserved)) {
    // Present beats not-observed, exactly as the thin contract resolves it.
    if (liveNames.has(name)) continue;
    unobserved.push({
      name,
      ...(entry.type ? { type: entry.type } : {}),
      reason: entry.reason,
      ...(entry.detail ? { detail: entry.detail } : {}),
    });
  }

  for (const name of liveNames) {
    if (!(name in input.declared)) undeclaredEntities.push(name);
  }

  for (const name of Object.keys(input.declared).sort()) {
    const liveEntity = input.live.resources[name];
    // Not observed deeply → already recorded above; no properties to compare.
    // Observed absent by the deep reader is the thin diff's `missing` case and
    // is not restated here: a resource that does not exist has no property
    // drift, and reporting every one of its declared properties as `absent`
    // would bury the one line that matters.
    if (!liveEntity) continue;

    const declaredEntity = input.declared[name];
    const type = liveEntity.type || declaredEntity.type;
    const declaredFlat = flattenDeepProperties(declaredEntity.properties, {
      entityType: type,
      side: "declared",
      hooks: input.hooks,
    });
    const liveFlat = flattenDeepProperties(liveEntity.properties, {
      entityType: type,
      side: "live",
      hooks: input.hooks,
    });

    const paths = [...new Set([...declaredFlat.keys(), ...liveFlat.keys()])].sort();
    const reported: PropertyDrift[] = [];
    const suppressed: PropertyDrift[] = [];

    for (const path of paths) {
      const hasDeclared = declaredFlat.has(path);
      const hasLive = liveFlat.has(path);
      const declaredValue = declaredFlat.get(path);
      const liveValue = liveFlat.get(path);

      // An unevaluated intrinsic has no source-side value to compare against.
      if (hasDeclared && declaredValue === UNRESOLVED) continue;
      if (hasDeclared && hasLive && deepValueEqual(declaredValue, liveValue)) continue;

      const kind: PropertyDriftKind = !hasDeclared ? "undeclared" : !hasLive ? "absent" : "changed";
      const drift: PropertyDrift = {
        path,
        kind,
        ...(hasDeclared ? { declared: declaredValue } : {}),
        ...(hasLive ? { live: liveValue } : {}),
      };

      const acceptedEntry = acceptedDeviation(baseline, name, path);
      if (acceptedEntry) {
        drift.baseline = acceptedEntry.value;
        // Value-bound acceptance: the accepted value is not drift, a different
        // one is drift again.
        if (hasLive && deepValueEqual(liveValue, acceptedEntry.value)) {
          suppressed.push(drift);
          continue;
        }
      }
      reported.push(drift);
    }

    if (suppressed.length > 0) accepted.push({ name, type, changes: suppressed });
    if (reported.length > 0) drifted.push({ name, type, changes: reported });
    else if (suppressed.length === 0) unchanged.push(name);
  }

  return {
    drifted: drifted.sort((a, b) => a.name.localeCompare(b.name)),
    accepted: accepted.sort((a, b) => a.name.localeCompare(b.name)),
    unchanged: unchanged.sort(),
    unobserved: unobserved.sort((a, b) => a.name.localeCompare(b.name)),
    undeclaredEntities: undeclaredEntities.sort(),
  };
}

/** Total reported property differences across every entity. */
export function countPropertyDrift(result: DeepDiffResult): number {
  return result.drifted.reduce((n, e) => n + e.changes.length, 0);
}
