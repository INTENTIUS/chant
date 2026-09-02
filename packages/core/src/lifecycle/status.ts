/**
 * Status surface — reconciles the release ledger against live truth (#568,
 * epic #551 "Build & deploy observability").
 *
 * Two ledgers, joined by one key. What's been built lives in the
 * content-addressed `BuildArchive` (../components/verbs/build-archive.ts,
 * ./build-ledger.ts). What we *recorded* deploying lives in the release
 * ledger (./release-ledger.ts). What's *actually running* is live truth:
 * ownership markers (../ownership.ts) plus `lifecycle diff --live`
 * (./live-diff.ts). This module is the join: for each component/env, line up
 * the latest recorded release against whatever live evidence is available,
 * and flag the four things that matter —
 *
 *  - **unrecorded** — something is live/owned but no release record exists
 *    for it. Someone (or some pipeline) deployed outside the recorded path.
 *  - **stale** — a release record exists but nothing live corresponds to it
 *    anymore (the component disappeared from observation).
 *  - **drifted** — the environment's live/owned resources don't confirm the
 *    recorded digest one way or the other from this join alone (recorded,
 *    but live identity can't be read back to a digest) — surfaced as a
 *    lower-confidence signal rather than silently treated as "reconciled".
 *  - **reconciled** — a release record exists and live evidence (via
 *    ownership) confirms the component is present and owned by chant.
 *  - **unknown** — live evidence was requested and could not be read (#1089),
 *    or was not requested at all. A component chant could not observe is never
 *    reported `stale`: "the read failed" and "it is gone" are different facts.
 *
 * This is deliberately a light-touch reconciliation: chant's lexicons report
 * resource-level status (`ResourceMetadata`), not "the digest currently
 * running" (most lexicons have no notion of image digest at all — a
 * CloudFormation stack doesn't expose "the ECS task's image digest" through
 * `describeResources`). So the live axis here is presence/ownership, not a
 * digest re-derivation; digest-level truth is what the *release ledger*
 * itself provides, and cross-environment digest comparison
 * (`buildIsInBothEnvs`) is the query the epic actually asks for ("which
 * build is in prod, and is it the one tested in staging").
 */

import type { ChangeSet, ChangeAction } from "./change-set";
import { latestPerComponent, type ReleaseRecord } from "./release-ledger";
import type { BuildLedgerEntry, ComponentBomSummary } from "./build-ledger";
import { unobservedReasonText, type UnobservedReason } from "../observation";

/** One row of `chant components status [env]` — the per-component join of recorded vs live. */
export interface ComponentStatusRow {
  component: string;
  env: string;
  /** The latest recorded release for this component/env, if any. */
  recorded?: ReleaseRecord;
  /** Build-ledger detail for the recorded digest, when discoverable (referrers, manifest digest, this artifact's own reproducibility — #614). */
  build?: BuildLedgerEntry;
  /**
   * Component-level BOM aggregation summary (#614,
   * ../components/verbs/component-bom.ts), when the recorded digest's build
   * archive manifest is available (`opts.componentBomByDigest`). Reports
   * every leaf BOM (software SBOM + IaC config-BOM) the component's archive
   * carries and whether they compose 1:1 or as a real multi-artifact
   * assembly — independent of `build`/`buildsByDigest` (which stays scoped
   * to image entries), since a config-only/infra component with no image
   * still has a component BOM to report.
   */
  componentBom?: ComponentBomSummary;
  /** Live reconciliation verdict for this row. */
  reconciliation: "reconciled" | "unrecorded" | "stale" | "drifted" | "unknown";
  /** Human-readable detail backing the verdict. */
  detail: string;
  /**
   * Machine-readable "observed live", when live evidence was gathered (`--live`).
   * A consumer joining this row onto a graph node should read this rather than
   * string-matching `detail`. Absent when `--live` was not requested — and, since
   * #1089, also absent when live state could not be read at all: `false` means
   * "looked, not there", never "did not look". Read {@link unobserved} for that
   * case; a consumer that treats absent as "unknown" already handles it.
   */
  live?: boolean;
  /**
   * Set when `--live` was requested and the observation could not read this
   * component (#1089). `live` is absent alongside it and `reconciliation` is
   * `unknown` — the row reports a hole rather than a verdict.
   */
  unobserved?: { reason: UnobservedReason; detail?: string };
  /**
   * The owning deploy unit's raw status, when a lexicon reported it (AWS: the
   * component's own CFN stack via `describeStackStatus`). Lets a renderer paint a
   * richer palette than the reconciliation verdict — `healthy` green,
   * present-but-not-healthy amber (mid-deploy) / red (rollback/failed).
   */
  stack?: LiveStackInfo;
  /**
   * How this component's own resources answered (behold#98). Present whenever
   * `--live` gathered evidence across a live-name mapping.
   *
   * `stack` above only exists where the substrate has a deploy object to read,
   * which is AWS and nowhere else — floci-az and floci-gcp have none, so a
   * consumer painting component status off `stack` has nothing to paint from
   * there. These counts are the substrate-neutral source for the same job:
   * they aggregate observations, which every lexicon produces, rather than a
   * provider-specific grouping object. `stack` stays as the richer enrichment
   * where it exists.
   */
  resources?: ComponentResourceRollup;
  /**
   * Set when some but not all of this component's deploy units were observed
   * present (#1528). `live` is `false` — deployed means all of it — but a
   * consumer painting the row can distinguish "half up" from "gone", and the
   * missing unit names are the actionable part.
   */
  partial?: { present: number; total: number; missing: string[] };
}

/** A component's owning deploy unit and its provider-native status. */
export interface LiveStackInfo {
  /** The deploy-unit name (e.g. the CloudFormation stack name). */
  name: string;
  /** Provider-native status string, e.g. "CREATE_COMPLETE". */
  status?: string;
  /** True when `status` is a terminal success state. */
  healthy?: boolean;
}

export interface ComponentStatusResult {
  env: string;
  rows: ComponentStatusRow[];
  /** Count of malformed ledger lines skipped (surfaced so a corrupted ledger is never silently invisible). */
  malformedLedgerLines: number;
}

/**
 * Live evidence for one component, distilled from a `ChangeSet` entry
 * (./change-set.ts) — the same read-only classification `lifecycle plan`
 * already computes from ownership + `diffLive`. `chant components status`
 * doesn't recompute live/ownership logic; it reuses `buildChangeSet`'s
 * output, so "unrecorded deploy" and "drift" both key off the one
 * ownership-aware classification chant already trusts.
 */
export interface LiveComponentEvidence {
  /** True if this component name was observed live at all (declared+live, or orphan+live). */
  live: boolean;
  /**
   * Set when the observation could not read this component (#1089). `live` is
   * `false` alongside it, but only because the boolean has nowhere else to go —
   * every consumer must branch on this field before believing `live: false`.
   */
  unobserved?: { reason: UnobservedReason; detail?: string };
  /** The `ChangeSet` action chant's existing plan logic assigned, when the component maps to a tracked entity/resource name. */
  action?: ChangeAction;
  /** Ownership verdict, when known. */
  ownership?: "owned" | "foreign" | "unknown";
  /** The owning deploy unit's raw status, when observed (AWS: the component's own
   * CFN stack). Surfaced onto `ComponentStatusRow.stack` for a richer palette. */
  stack?: LiveStackInfo;
  /**
   * Set when some but not all of the component's deploy units were observed
   * present (#1528). `live` is `false` — a component is deployed when all of
   * it is — but "nothing observed live" would be a lie, and it was one: a
   * multi-unit component with a single absent unit reported exactly that
   * while its Helm releases sat deployed and healthy in the same row's
   * `stack` field. Consumers get the split and the names of what is missing.
   */
  partial?: { present: number; total: number; missing: string[] };
  /**
   * How the component's own resources answered, before any merge collapsed
   * them (behold#98). Always present when evidence exists — a component that
   * maps to a single entity by identity gets a rollup of one, so a consumer
   * never has to branch on whether a live-name mapping happened to be
   * configured.
   */
  rollup?: ComponentResourceRollup;
}

/**
 * Overlay per-component stack-presence evidence onto change-set evidence.
 *
 * The change-set axis (`liveEvidenceFromChangeSet`) is entity-keyed and, for
 * AWS, single-stack-per-env — it can't see a multi-stack component project where
 * each component owns its own stack (#57). `supplement` carries the direct
 * per-component stack observation (from a lexicon's `describeStackStatus`), which
 * is authoritative for **presence** (`live`) and **ownership**; the change-set's
 * `action` is kept, since drift is still assessed from the diff. A component in
 * only one map passes through unchanged.
 *
 * The change-set's `rollup` is kept too (behold#100). This merge rebuilds the
 * evidence object field by field, so anything not named here is dropped — and
 * `describeStackStatus` reports a stack, never per-resource counts, so the
 * supplement has no rollup to contribute. Before this, every component on a
 * lexicon that implements `describeStackStatus` lost the counts #1300 had just
 * computed. That is AWS and only AWS, which made the rollup absent on exactly
 * the substrate it was meant to be verified against: behold#98 shipped its
 * consumer against floci-az/floci-gcp rows, where no stack observer runs and
 * the field survived.
 */
export function mergeLiveEvidence(
  base: Map<string, LiveComponentEvidence> | undefined,
  supplement: Map<string, LiveComponentEvidence>,
): Map<string, LiveComponentEvidence> {
  const merged = new Map(base ?? []);
  for (const [component, sup] of supplement) {
    const b = merged.get(component);
    merged.set(component, {
      live: sup.live,
      // A direct stack observation that succeeded answers the question the
      // change-set axis could not — so it clears an inherited "not observed".
      // A supplement that itself could not read keeps the hole.
      ...(sup.unobserved ? { unobserved: sup.unobserved } : {}),
      ownership: sup.ownership ?? b?.ownership,
      action: b?.action,
      stack: sup.stack ?? b?.stack,
      // The unit split rides the same direct observation `live` came from —
      // dropping it here would resurrect the lie the field exists to fix.
      ...(sup.partial ? { partial: sup.partial } : {}),
      // Base first: the counts come from the change set, and a stack
      // observation has none to offer.
      ...(b?.rollup ?? sup.rollup ? { rollup: b?.rollup ?? sup.rollup } : {}),
    });
  }
  return merged;
}

/**
 * Component -> live entity/resource name(s) it owns (#598). Mirrors
 * `Component.liveNames` (../components/component.ts) without importing it —
 * this module stays decoupled from the typed authoring form, since a
 * hand-written JSON component or a future non-chant frontend can supply the
 * same mapping without going through `Component` at all. A component absent
 * from this map, or mapped to `undefined`/an empty array, falls back to its
 * own name as the sole live name — the original name == entity join.
 */
export type LiveNameMapping = Map<string, string[] | undefined>;

/** Resolve the live entity/resource name(s) a component owns: its explicit mapping, or `[component]` when none is given. */
export function resolveLiveNames(component: string, mapping?: LiveNameMapping): string[] {
  const mapped = mapping?.get(component);
  return mapped && mapped.length > 0 ? mapped : [component];
}

/**
 * How a component's own resources answered, one count per tri-state verdict.
 *
 * The merged verdict above is deliberately lossy — it answers "is this
 * component deployed" and nothing else. A consumer painting component status
 * without a deploy object to read (behold#98: floci-az and floci-gcp have no
 * CloudFormation stack, so `stack` below is absent and there is nothing to
 * colour from) needs the shape underneath: how many of the component's
 * resources were seen, how many were confirmed gone, how many nobody could
 * look at. Substrate-neutral by construction — it counts observations, not
 * provider objects.
 */
export interface ComponentResourceRollup {
  /** Resources this component owns, per the live-name mapping. */
  total: number;
  /** Observed present. */
  present: number;
  /** Looked for, reported missing. Never includes a resource nobody could read. */
  absent: number;
  /** NOT-OBSERVED (#1089) — a hole, never counted as absence. */
  unobserved: number;
}

/** Count a component's entity verdicts without collapsing them (behold#98). */
function rollUp(entries: LiveComponentEvidence[]): ComponentResourceRollup {
  let present = 0;
  let absent = 0;
  let unobserved = 0;
  for (const e of entries) {
    if (e.unobserved) unobserved += 1;
    else if (e.live) present += 1;
    else absent += 1;
  }
  return { total: entries.length, present, absent, unobserved };
}

/**
 * Merge live evidence for several entity/resource names owned by one
 * component into a single verdict. `live` and `ownership` favor the
 * most-actionable signal (present/owned) over "nothing here"; `action`
 * favors `update` so that drift on *any* owned entity surfaces as drift for
 * the component as a whole, matching `reconcileStatus`'s single check for
 * `action === "update"`.
 *
 * The per-entity counts survive as {@link LiveComponentEvidence.rollup}, so a
 * consumer that needs the shape rather than the verdict is not forced to redo
 * this join on the far side of a CLI boundary.
 */
function mergeEvidence(entries: LiveComponentEvidence[]): LiveComponentEvidence | undefined {
  if (entries.length === 0) return undefined;
  if (entries.length === 1) return { ...entries[0], rollup: rollUp(entries) };

  const live = entries.some((e) => e.live);
  const ownership = entries.some((e) => e.ownership === "owned")
    ? "owned"
    : entries.some((e) => e.ownership === "foreign")
      ? "foreign"
      : "unknown";
  const action = entries.some((e) => e.action === "update")
    ? "update"
    : entries.find((e) => e.action !== undefined)?.action;
  // A component whose entities were partly readable is still partly unknown, so
  // any unobserved entity keeps the hole — unless something under it was
  // actually seen live, which already answers "is this deployed".
  const unobserved = live ? undefined : entries.find((e) => e.unobserved)?.unobserved;

  return { live, ownership, action, ...(unobserved ? { unobserved } : {}), rollup: rollUp(entries) };
}

/**
 * Build a `component -> live evidence` map from a `ChangeSet`. Components and
 * chant entities are different namespaces (a component's `name` need not
 * equal any single lexicon entity name), so callers that want live
 * reconciliation for a component whose live name(s) differ from its own name
 * pass `nameMapping` (typically projected from `Component.liveNames`, see
 * ../components/component.ts) — e.g. `new Map([["search-svc",
 * ["search-service-v2"]]])`. Without a mapping (or for a component with no
 * entry in it), the component's own name is used as its sole live name — the
 * identity-keyed join that was this function's only behavior before #598,
 * preserved here as the fallback so existing callers see no change.
 */
export function liveEvidenceFromChangeSet(
  cs: ChangeSet,
  nameMapping?: LiveNameMapping,
): Map<string, LiveComponentEvidence> {
  const evidenceByName = new Map<string, LiveComponentEvidence>();
  for (const entry of cs.entries) {
    evidenceByName.set(entry.name, {
      rollup: rollUp([
        {
          live: entry.evidence.live,
          ...(entry.action === "unobserved" && entry.unobservedReason
            ? { unobserved: { reason: entry.unobservedReason } }
            : {}),
        },
      ]),
      live: entry.evidence.live,
      action: entry.action,
      ownership: entry.ownership,
      // Carry the plan's "could not look" verdict through so the status join
      // reports a hole instead of reading `live: false` as "gone" (#1089).
      ...(entry.action === "unobserved" && entry.unobservedReason
        ? {
            unobserved: {
              reason: entry.unobservedReason,
              ...(entry.unobservedDetail ? { detail: entry.unobservedDetail } : {}),
            },
          }
        : {}),
    });
  }

  if (!nameMapping) return evidenceByName;

  // Re-key by component: for each component that has an explicit mapping,
  // aggregate evidence across every live name it owns. Components with no
  // mapping entry keep their identity-keyed evidence as-is (already present
  // in evidenceByName under their own name).
  const result = new Map<string, LiveComponentEvidence>(evidenceByName);
  for (const [component, liveNames] of nameMapping) {
    if (!liveNames || liveNames.length === 0) continue;
    const merged = mergeEvidence(
      liveNames
        .map((n) => evidenceByName.get(n))
        .filter((e): e is LiveComponentEvidence => e !== undefined),
    );
    if (merged) {
      result.set(component, merged);
    } else {
      result.delete(component);
    }
  }
  return result;
}

/**
 * Reconcile the release ledger against live evidence for one environment.
 * Pure — no I/O. Callers assemble `records` (./release-ledger.ts's
 * `readReleaseLedger`), `liveEvidence` (from a `ChangeSet` via
 * `liveEvidenceFromChangeSet`, or `undefined` when `--live` wasn't
 * requested), `builds` (a `component -> BuildLedgerEntry` lookup keyed by
 * digest, from ./build-ledger.ts), and `componentBomByDigest` (#614, a
 * `digest -> ComponentBomSummary` lookup, also from ./build-ledger.ts) ahead
 * of time.
 */
export function reconcileStatus(
  env: string,
  records: ReleaseRecord[],
  opts?: {
    liveEvidence?: Map<string, LiveComponentEvidence>;
    /** Build-ledger detail keyed by digest, when available. */
    buildsByDigest?: Map<string, BuildLedgerEntry>;
    /** Component-level BOM aggregation summary keyed by digest, when available (#614). Independent of `buildsByDigest` — a config-only/infra component with no image entry still has a component BOM to report. */
    componentBomByDigest?: Map<string, ComponentBomSummary>;
    /** Component names known to exist (from `discoverComponents`) but with no release record at all — still reported as `unrecorded` when live evidence says they're running. */
    allComponents?: string[];
  },
): ComponentStatusRow[] {
  const latest = latestPerComponent(records);
  const liveEvidence = opts?.liveEvidence;
  const componentNames = new Set<string>([...latest.keys(), ...(opts?.allComponents ?? [])]);

  const rows: ComponentStatusRow[] = [];
  for (const component of [...componentNames].sort()) {
    const recorded = latest.get(component);
    const evidence = liveEvidence?.get(component);
    const build = recorded ? opts?.buildsByDigest?.get(recorded.digest) : undefined;
    const componentBom = recorded ? opts?.componentBomByDigest?.get(recorded.digest) : undefined;

    let reconciliation: ComponentStatusRow["reconciliation"];
    let detail: string;

    if (!liveEvidence) {
      // No live evidence requested at all (digest-only / offline mode) — the
      // ledger is the only signal available, so recorded-vs-unrecorded still
      // makes sense but drift can't be assessed.
      reconciliation = recorded ? "unknown" : "unrecorded";
      detail = recorded
        ? "recorded; live status not queried (pass --live to reconcile)"
        : "no release record found";
    } else if (evidence?.unobserved) {
      // Live evidence was requested and could not be read (#1089). Neither
      // `stale` (which claims the component is gone) nor `reconciled` is
      // supportable — the honest verdict is that nothing is known.
      reconciliation = "unknown";
      const why = `${unobservedReasonText(evidence.unobserved.reason)}${evidence.unobserved.detail ? `: ${evidence.unobserved.detail}` : ""}`;
      detail = recorded
        ? `recorded ${recorded.timestamp} (digest ${recorded.digest}), but live state could not be observed — ${why}`
        : `no release record, and live state could not be observed — ${why}`;
    } else if (!recorded && evidence?.live) {
      reconciliation = "unrecorded";
      detail = `live${evidence.ownership === "owned" ? " and chant-owned" : ""}, but no release record exists — deployed outside the recorded path`;
    } else if (!recorded && !evidence?.live) {
      reconciliation = "unrecorded";
      // "Nothing observed live" was a lie for a partially-present component
      // (#1528) — say what was seen and name what was not.
      detail = evidence?.partial
        ? `no release record; ${evidence.partial.present} of ${evidence.partial.total} deploy units observed live (missing: ${evidence.partial.missing.join(", ")})`
        : "no release record and nothing observed live";
    } else if (recorded && !evidence?.live) {
      reconciliation = "stale";
      detail = evidence?.partial
        ? `recorded ${recorded.timestamp} (digest ${recorded.digest}), but only ${evidence.partial.present} of ${evidence.partial.total} deploy units observed live now (missing: ${evidence.partial.missing.join(", ")})`
        : `recorded ${recorded.timestamp} (digest ${recorded.digest}), but nothing observed live now`;
    } else if (recorded && evidence?.action === "update") {
      reconciliation = "drifted";
      detail = `recorded ${recorded.timestamp} (digest ${recorded.digest}), but live configuration has drifted since`;
    } else {
      reconciliation = "reconciled";
      detail = `recorded ${recorded!.timestamp} (digest ${recorded!.digest}), live and consistent`;
    }

    rows.push({
      component,
      env,
      recorded,
      build,
      componentBom,
      reconciliation,
      detail,
      // `live` is only emitted when it is a real answer: requested AND read.
      // An unread component leaves it absent (= unknown to every consumer)
      // rather than reporting `false`, which would read as "not deployed".
      ...(liveEvidence && !evidence?.unobserved ? { live: !!evidence?.live } : {}),
      ...(evidence?.unobserved ? { unobserved: evidence.unobserved } : {}),
      ...(evidence?.stack ? { stack: evidence.stack } : {}),
      ...(evidence?.rollup ? { resources: evidence.rollup } : {}),
      ...(evidence?.partial ? { partial: evidence.partial } : {}),
    });
  }

  return rows;
}

/**
 * Answer "which build is in `envA`, and is it the one tested in `envB`" —
 * the single-query comparison the epic names explicitly — for one component
 * across two environments' release ledgers.
 */
export interface CrossEnvComparison {
  component: string;
  envA: string;
  envB: string;
  digestA?: string;
  digestB?: string;
  /**
   * True only when both envs have a recorded digest and their *comparable*
   * identities match. For a record carrying `inputDigest` (a pinned helm
   * deploy, chant#1242/#1243), that field is the comparable identity —
   * `ReleaseRecord.inputDigest`'s own contract: profiles are per cluster, two
   * environments legitimately render to different bytes, so cross-environment
   * "is prod running what staging tested" joins on the input side while
   * `digest` proves the exact bytes each cluster got. Records without it
   * compare on `digest` exactly as before.
   */
  same: boolean;
  /** The identities `same` was decided on (`inputDigest ?? digest` per side), when both sides had one and they differ from the digests shown. */
  comparedOn?: { a: string; b: string };
}

/** Compare the latest recorded digest for `component` between two environments' release records. */
export function compareAcrossEnvironments(
  component: string,
  envA: { name: string; records: ReleaseRecord[] },
  envB: { name: string; records: ReleaseRecord[] },
): CrossEnvComparison {
  const latestA = latestPerComponent(envA.records).get(component);
  const latestB = latestPerComponent(envB.records).get(component);
  const idA = latestA ? latestA.inputDigest ?? latestA.digest : undefined;
  const idB = latestB ? latestB.inputDigest ?? latestB.digest : undefined;
  const comparedOnInputs = (latestA?.inputDigest ?? latestB?.inputDigest) !== undefined;
  return {
    component,
    envA: envA.name,
    envB: envB.name,
    digestA: latestA?.digest,
    digestB: latestB?.digest,
    same: !!idA && !!idB && idA === idB,
    ...(comparedOnInputs && idA && idB ? { comparedOn: { a: idA, b: idB } } : {}),
  };
}
