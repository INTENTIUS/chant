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
 *
 * ## The claim decides what counts as drift (#2160)
 *
 * The declared tree is not only one side of a comparison, it is a statement of
 * which fields chant ever set — the claimed-field set (../claimed-fields.ts).
 * A live value on a path outside it is somebody else's field: an autoscaler's
 * replica count, a controller's annotation, a value a person typed into a
 * console. It is reported in {@link DeepDiffResult.heldElsewhere}, with the
 * manager's name where the substrate records one, and it is not drift. Only a
 * claimed path that moved is, and drift is the only thing that may become an
 * update.
 */

import {
  UNRESOLVED,
  deepValueEqual,
  flattenDeepProperties,
  type DeepNormalizationHooks,
  type NormalizedDeepObservation,
} from "../deep-observation";
import { claimedFieldsFromPaths, heldBy, isClaimed, type FieldClaimSource } from "../claimed-fields";
import { isNormalizedHeldElsewhere } from "../held-elsewhere";
import { originOfPath, type PathOrigin } from "../provenance";
import type { UnobservedResource } from "./live-diff";
import { acceptedDeviation, type BaselineLexicon } from "./observation-baseline";

/**
 * How a property differs.
 *
 * - `changed` — declared and live both have the path, with different values.
 *   The only kind that may become an update.
 * - `absent` — source declares it and the live tree does not carry it. Weaker
 *   than `changed`: a provider that omits a property it considers unset is
 *   common, which is what the lexicon's pruning hook is for.
 *
 * A live value on a path source never declared used to be a third kind,
 * `undeclared`. It is no longer drift at all (#2160): chant never set that
 * field, so somebody else holds it, and it is reported in
 * {@link DeepDiffResult.heldElsewhere} instead. It is still reported — pruning
 * what chant cannot attribute is how #1191 lost a console-added label — it just
 * stopped being a difference chant proposes to close.
 */
export type PropertyDriftKind = "changed" | "absent";

/** One property-level difference. */
export interface PropertyDrift {
  /** Path within the normalized property tree (`Tags[0].Value`). */
  path: string;
  kind: PropertyDriftKind;
  /**
   * Value in source. Always present since #2160 — a drift row is only ever
   * raised for a path the declaration claims — and kept optional for the wire
   * shape consumers already branch on.
   */
  declared?: unknown;
  /** Value in the cloud. Absent for `absent`. */
  live?: unknown;
  /**
   * The accepted value from the baseline, when this path has one. Present on a
   * reported drift too — that is the "accepted X, now Y" case, and hiding the
   * accepted value there would lose the most useful column in the report.
   */
  baseline?: unknown;
  /**
   * The field manager that owns this path live, where the substrate records one
   * (#1189) — Kubernetes' `managedFields`, and nowhere else today.
   *
   * `kind` says whether a claimed path changed or went missing; this says who
   * holds it live.
   * "Owned by `kubectl-client-side-apply`" and "owned by `hpa-controller`" are
   * the same `kind` and mean opposite things: one is somebody bypassing the
   * pipeline, the other is a controller doing its job. Absent on a substrate
   * with no per-field ownership, which is every substrate but k8s.
   */
  owner?: string;
  /**
   * What produced this path on the DECLARED side (#1443) — the counterpart of
   * {@link owner}, and the reason the two are reported together: "owned live by
   * `hpa-controller`, governed in source by the `tier` parameter" says where
   * each half of a disagreement has to be fixed, which neither half says alone.
   *
   * Resolved by longest prefix from the entity's recorded path origins, so a
   * field inside a keyed list element inherits the origin recorded for the
   * list. Absent when the build recorded none — the run path, and a sandboxed
   * child, have no expression to attribute (see `EntityProvenance.paths`).
   */
  origin?: PathOrigin;
}

/** Property-level drift for one declared entity. */
export interface DeepEntityDrift {
  name: string;
  type: string;
  changes: PropertyDrift[];
}

/**
 * One live property value on a path this declaration never claimed (#2160) —
 * a field that exists and that chant did not set.
 *
 * Reported, never proposed. The interesting column is {@link source}: on
 * Kubernetes the API server names the manager and this row says
 * `hpa-controller`; everywhere else the declaration is the only witness and the
 * row says "not mine" without saying whose.
 */
export interface HeldField {
  /** Path within the normalized property tree (`spec.replicas`). */
  path: string;
  /** The value the cloud is carrying. */
  live: unknown;
  /**
   * The field manager holding it, where the substrate records one. Absent on
   * every substrate but Kubernetes, and absent on Kubernetes for a path no
   * `managedFields` entry covers.
   */
  heldBy?: string;
  /** Which source answered: the substrate's manager, or the claimed-field set. */
  source: FieldClaimSource;
  /**
   * The accepted value from the baseline, when this path has one. A held field
   * needs no acceptance to stay quiet, so this is carried for continuity with
   * baselines recorded before #2160 rather than because it changes anything.
   */
  baseline?: unknown;
}

/** Live property values one declared entity is not claiming. */
export interface DeepEntityHeldFields {
  name: string;
  type: string;
  fields: HeldField[];
 * One property declared `heldElsewhere()` (#2162) — a fact about who owns the
 * field at runtime, reported beside drift rather than folded into it. Never a
 * {@link PropertyDrift}: a held property is never `changed`, `undeclared`, or
 * `absent`, and is never proposed for update.
 */
export interface PropertyHeld {
  /** Path within the normalized property tree, same addressing as {@link PropertyDrift.path}. */
  path: string;
  /** Who holds it — the marker's `by`. */
  by: string;
  /** Why chant does not reconcile it — the marker's `reason`. */
  reason: string;
  /** The live value, when the deep read found one at this path. */
  live?: unknown;
  /**
   * True when this path carried no live value at all — the deep read found
   * nothing here, not even a provider default. A declared hand-over with no
   * evidence anything was ever written is itself worth a look: either the
   * holder never ran, or this is not the field it actually writes.
   */
  suspicious: boolean;
  /** The field manager that owns this path live, where the substrate records one (#1189). See {@link PropertyDrift.owner}. */
  owner?: string;
}

/** Held properties (#2162) for one declared entity. */
export interface DeepEntityHeld {
  name: string;
  type: string;
  held: PropertyHeld[];
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
  /**
   * Live values on paths nobody declared (#2160), per entity. Sorted by name.
   *
   * Not drift, and deliberately a sibling of `drifted` rather than a kind
   * inside it: `countPropertyDrift` does not see this list, `--update-baseline`
   * does not record it, and nothing downstream may turn one of these into an
   * update. It exists so the report can still say the field is there and who
   * has it.
   */
  heldElsewhere: DeepEntityHeldFields[];
   * Properties declared `heldElsewhere()` (#2162) — reported here instead of
   * in `drifted`/`accepted`, whatever the live value is. Not a suppression:
   * every held property is listed, with its holder and reason, so a reader of
   * the plan sees which fields are not being managed and by whom. Sorted by
   * name.
   */
  held: DeepEntityHeld[];
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
  /**
   * The entity's recorded path origins (#1443), as `EntityProvenance.paths`.
   * Omit for a build that recorded none.
   */
  pathOrigins?: Record<string, PathOrigin>;
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
  const heldElsewhere: DeepEntityHeldFields[] = [];
  const held: DeepEntityHeld[] = [];
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

    // The claim (#2160): every path this declaration's props flatten to, in the
    // grammar this loop addresses paths by. Derived here rather than read off
    // `liveEntity.claimedFields` so `diffDeep` stays a pure function of its two
    // trees; `lifecycle/deep-observe.ts` computes the identical set from the
    // identical normalized tree and carries it on the observation for consumers.
    const claimed = claimedFieldsFromPaths(declaredFlat.keys());

    const paths = [...new Set([...declaredFlat.keys(), ...liveFlat.keys()])].sort();
    const reported: PropertyDrift[] = [];
    const suppressed: PropertyDrift[] = [];
    const heldFields: HeldField[] = [];
    const heldHere: PropertyHeld[] = [];

    for (const path of paths) {
      const hasDeclared = isClaimed(claimed, path);
      const hasLive = liveFlat.has(path);
      const declaredValue = declaredFlat.get(path);
      const liveValue = liveFlat.get(path);

      // A `heldElsewhere()` marker (#2162): never drift, whatever the live
      // value is (or isn't) — reported in its own section instead, with its
      // holder and reason, and never proposed for update. Checked ahead of
      // the UNRESOLVED/equality shortcuts below: a held path is not "no
      // source-side value" (UNRESOLVED) and its declared side will never
      // structurally equal a live value, so without this check every held
      // property would fall through and report as ordinary `changed` drift.
      if (hasDeclared && isNormalizedHeldElsewhere(declaredValue)) {
        heldHere.push({
          path,
          by: declaredValue.by,
          reason: declaredValue.reason,
          ...(hasLive ? { live: liveValue } : {}),
          // No live value at all is the one thing chant can check in a
          // single observation: a claimed hand-over that produced no
          // evidence — not even a provider default — is worth a look.
          suspicious: !hasLive,
          ...(hasLive && liveEntity.fieldOwners?.[path] ? { owner: liveEntity.fieldOwners[path] } : {}),
        });
        continue;
      }

      // An unevaluated intrinsic has no source-side value to compare against.
      if (hasDeclared && declaredValue === UNRESOLVED) continue;
      if (hasDeclared && hasLive && deepValueEqual(declaredValue, liveValue)) continue;

      const acceptedEntry = acceptedDeviation(baseline, name, path);

      // A live value on a path nobody claimed is somebody else's field, not a
      // difference chant proposes to close (#2160). Reported, never drift,
      // never a candidate for an update — and the manager name, where the
      // substrate records one, is the whole answer an operator wants.
      if (!hasDeclared) {
        const { holder, source } = heldBy(liveEntity.fieldOwners, path);
        heldFields.push({
          path,
          live: liveValue,
          ...(holder ? { heldBy: holder } : {}),
          source,
          ...(acceptedEntry ? { baseline: acceptedEntry.value } : {}),
        });
        continue;
      }

      const kind: PropertyDriftKind = !hasLive ? "absent" : "changed";
      // Who owns the path live, where the substrate records it (#1189). Only
      // meaningful for a path that exists live — an `absent` drift has no live
      // field for anyone to own.
      const owner = hasLive ? liveEntity.fieldOwners?.[path] : undefined;
      // The declared-side counterpart (#1443).
      const origin = originOfPath(declaredEntity.pathOrigins, path);
      const drift: PropertyDrift = {
        path,
        kind,
        declared: declaredValue,
        ...(hasLive ? { live: liveValue } : {}),
        ...(owner ? { owner } : {}),
        ...(origin ? { origin } : {}),
      };

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
    if (heldFields.length > 0) heldElsewhere.push({ name, type, fields: heldFields });
    if (reported.length > 0) drifted.push({ name, type, changes: reported });
    // Held fields do not disqualify an entity from `unchanged`: every property
    // chant declared matches, and the epic's whole point is that a controller's
    // field stops being a finding chant restates on every tick.
    else if (suppressed.length === 0) unchanged.push(name);
    if (heldHere.length > 0) held.push({ name, type, held: heldHere });
  }

  return {
    drifted: drifted.sort((a, b) => a.name.localeCompare(b.name)),
    accepted: accepted.sort((a, b) => a.name.localeCompare(b.name)),
    heldElsewhere: heldElsewhere.sort((a, b) => a.name.localeCompare(b.name)),
    held: held.sort((a, b) => a.name.localeCompare(b.name)),
    unchanged: unchanged.sort(),
    unobserved: unobserved.sort((a, b) => a.name.localeCompare(b.name)),
    undeclaredEntities: undeclaredEntities.sort(),
  };
}

/** Total reported property differences across every entity. */
export function countPropertyDrift(result: DeepDiffResult): number {
  return result.drifted.reduce((n, e) => n + e.changes.length, 0);
}

/** Total live values held by someone other than chant, across every entity (#2160). Never added to the drift count. */
export function countHeldFields(result: DeepDiffResult): number {
  return result.heldElsewhere.reduce((n, e) => n + e.fields.length, 0);
/** Total held properties (#2162) across every entity. */
export function countHeld(result: DeepDiffResult): number {
  return result.held.reduce((n, e) => n + e.held.length, 0);
}

/** One held property flagged suspicious (#2162), with its entity attached. */
export interface SuspiciousHeld extends PropertyHeld {
  name: string;
  type: string;
}

/**
 * Every held property whose declaration looks like a hand-over that never
 * happened — no live value ever showed up for it. Worth a look: either the
 * named holder never ran, or this is not the field it actually writes.
 * Sorted by entity name, then path.
 */
export function suspiciousHeld(result: DeepDiffResult): SuspiciousHeld[] {
  const out: SuspiciousHeld[] = [];
  for (const entity of result.held) {
    for (const h of entity.held) {
      if (h.suspicious) out.push({ name: entity.name, type: entity.type, ...h });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}
