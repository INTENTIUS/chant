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
  /** The `ChangeSet` action chant's existing plan logic assigned, when the component maps to a tracked entity/resource name. */
  action?: ChangeAction;
  /** Ownership verdict, when known. */
  ownership?: "owned" | "foreign" | "unknown";
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
 * Merge live evidence for several entity/resource names owned by one
 * component into a single verdict. `live` and `ownership` favor the
 * most-actionable signal (present/owned) over "nothing here"; `action`
 * favors `update` so that drift on *any* owned entity surfaces as drift for
 * the component as a whole, matching `reconcileStatus`'s single check for
 * `action === "update"`.
 */
function mergeEvidence(entries: LiveComponentEvidence[]): LiveComponentEvidence | undefined {
  if (entries.length === 0) return undefined;
  if (entries.length === 1) return entries[0];

  const live = entries.some((e) => e.live);
  const ownership = entries.some((e) => e.ownership === "owned")
    ? "owned"
    : entries.some((e) => e.ownership === "foreign")
      ? "foreign"
      : "unknown";
  const action = entries.some((e) => e.action === "update")
    ? "update"
    : entries.find((e) => e.action !== undefined)?.action;

  return { live, ownership, action };
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
      live: entry.evidence.live,
      action: entry.action,
      ownership: entry.ownership,
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
    } else if (!recorded && evidence?.live) {
      reconciliation = "unrecorded";
      detail = `live${evidence.ownership === "owned" ? " and chant-owned" : ""}, but no release record exists — deployed outside the recorded path`;
    } else if (!recorded && !evidence?.live) {
      reconciliation = "unrecorded";
      detail = "no release record and nothing observed live";
    } else if (recorded && !evidence?.live) {
      reconciliation = "stale";
      detail = `recorded ${recorded.timestamp} (digest ${recorded.digest}), but nothing observed live now`;
    } else if (recorded && evidence?.action === "update") {
      reconciliation = "drifted";
      detail = `recorded ${recorded.timestamp} (digest ${recorded.digest}), but live configuration has drifted since`;
    } else {
      reconciliation = "reconciled";
      detail = `recorded ${recorded!.timestamp} (digest ${recorded!.digest}), live and consistent`;
    }

    rows.push({ component, env, recorded, build, componentBom, reconciliation, detail });
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
  /** True only when both envs have a recorded digest and they match. */
  same: boolean;
}

/** Compare the latest recorded digest for `component` between two environments' release records. */
export function compareAcrossEnvironments(
  component: string,
  envA: { name: string; records: ReleaseRecord[] },
  envB: { name: string; records: ReleaseRecord[] },
): CrossEnvComparison {
  const latestA = latestPerComponent(envA.records).get(component);
  const latestB = latestPerComponent(envB.records).get(component);
  return {
    component,
    envA: envA.name,
    envB: envB.name,
    digestA: latestA?.digest,
    digestB: latestB?.digest,
    same: !!latestA && !!latestB && latestA.digest === latestB.digest,
  };
}
