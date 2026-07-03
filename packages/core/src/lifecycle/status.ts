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
import type { BuildLedgerEntry } from "./build-ledger";

/** One row of `chant components status [env]` — the per-component join of recorded vs live. */
export interface ComponentStatusRow {
  component: string;
  env: string;
  /** The latest recorded release for this component/env, if any. */
  recorded?: ReleaseRecord;
  /** Build-ledger detail for the recorded digest, when discoverable (referrers, manifest digest). */
  build?: BuildLedgerEntry;
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
 * Build a `component -> live evidence` map from a `ChangeSet`. Components and
 * chant entities are different namespaces (a component's `name` need not
 * equal any single lexicon entity name), so callers that want live
 * reconciliation must supply the mapping themselves (typically: the
 * component's name *is* the entity/resource name for the pilot components,
 * see ../components/pilots) — this helper is the identity-keyed common case.
 */
export function liveEvidenceFromChangeSet(cs: ChangeSet): Map<string, LiveComponentEvidence> {
  const evidence = new Map<string, LiveComponentEvidence>();
  for (const entry of cs.entries) {
    evidence.set(entry.name, {
      live: entry.evidence.live,
      action: entry.action,
      ownership: entry.ownership,
    });
  }
  return evidence;
}

/**
 * Reconcile the release ledger against live evidence for one environment.
 * Pure — no I/O. Callers assemble `records` (./release-ledger.ts's
 * `readReleaseLedger`), `liveEvidence` (from a `ChangeSet` via
 * `liveEvidenceFromChangeSet`, or `undefined` when `--live` wasn't
 * requested), and `builds` (a `component -> BuildLedgerEntry` lookup keyed by
 * digest, from ./build-ledger.ts) ahead of time.
 */
export function reconcileStatus(
  env: string,
  records: ReleaseRecord[],
  opts?: {
    liveEvidence?: Map<string, LiveComponentEvidence>;
    /** Build-ledger detail keyed by digest, when available. */
    buildsByDigest?: Map<string, BuildLedgerEntry>;
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

    rows.push({ component, env, recorded, build, reconciliation, detail });
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
