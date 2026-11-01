/**
 * The four DORA metrics of one environment's deploy records (#4039): how
 * often it deploys, the lead time from commit to running release, the change
 * failure rate and the time to restore.
 *
 * Everything here is pure. The caller reads the ledgers, the release files
 * and the ci tags, and hands this module one environment's records with
 * lookups for the rest; `workspace/delivery-metrics.ts` does that for
 * `chant workspace metrics`.
 *
 * A deploy is one record in `<env>/releases.jsonl`: one component deployed
 * once. A redeploy, which puts the running release back, is counted apart and
 * is not a deploy for the metrics. A deploy fails when, within the failure window after it, the commit
 * it deployed is revoked (a counted `ci/revoked/<sha>` tag, #4033) or the
 * environment is rolled back from it. Which records are rollbacks, and which
 * put the current release back, is decided in {@link rollbackOf} and
 * {@link isRedeploy} and nowhere else, so a new kind of rollback record
 * (#4035) changes those two functions only.
 */

import type { ReleaseRecord, ReleaseRef } from "./release-ledger";

/** The failure window when the declaration's `metrics.failureWindowDays` is not set. */
export const DEFAULT_FAILURE_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * The earlier deploy a rollback record restores, or null when the record is
 * not a rollback. Today a rollback is a record `chant components rollback`
 * wrote, which names what it restores in `restores` (#2531). Every rule below
 * that asks whether a record rolled an environment back asks this function.
 */
export function rollbackOf(record: Pick<ReleaseRecord, "restores">): ReleaseRef | null {
  return record.restores ?? null;
}

/**
 * Whether the record put the current release back (`chant components
 * redeploy`, #2604). A redeploy deploys the same release again, so it neither
 * restores a failed deploy nor stands between a deploy and its rollback.
 */
export function isRedeploy(record: Pick<ReleaseRecord, "redeploys">): boolean {
  return record.redeploys !== undefined;
}

/** A counted revoked tag on a commit, with the time it was made, or null for a lightweight tag. */
export interface CommitRevocation {
  tag: string;
  tagged: string | null;
}

/** What the caller knows beyond the records, as lookups. */
export interface MetricsLookups {
  /** The release a deploy record names: its `releaseDigest`, else the one its release-gate admission names. Undefined when it names none. */
  releaseOf: (record: ReleaseRecord) => string | undefined;
  /** The commit a release was cut from, or null when its file can't be read here. */
  commitOfRelease: (releaseDigest: string) => string | null;
  /** The release's label, or null. */
  labelOf: (releaseDigest: string) => string | null;
  /** The counted revoked tag on a commit, or null when the commit is not revoked. */
  revocationOf: (commit: string) => CommitRevocation | null;
  /** The commit's committer time in milliseconds, or null when the commit is not in this repository. */
  commitTime: (commit: string) => number | null;
}

/** The span of time the metrics count deploys in. */
export interface MetricsWindow {
  /** ISO-8601, inclusive. */
  since: string;
  /** ISO-8601, inclusive. */
  until: string;
}

/** A record named the way `restores` names one. */
export interface DeployRef {
  runId: string;
  timestamp: string;
}

/** One failed deploy, and how it was restored. */
export interface DeployFailure {
  component: string;
  timestamp: string;
  runId: string;
  /** The release the deploy came from, or null for a deploy made from no release. */
  releaseDigest: string | null;
  label: string | null;
  /** The commit it deployed: the release's commit, or the record's `gitSha` for a deploy made from no release. */
  commit: string;
  /** Why it counts as failed: `revoked`, `rolled-back`, or both. */
  causes: Array<"revoked" | "rolled-back">;
  /** The revoked tag on the commit, when that is a cause. */
  revoked: CommitRevocation | null;
  /** The rollback record that rolled the environment back from it, when that is a cause. */
  rolledBackBy: DeployRef | null;
  /** The next deploy of the component in the environment whose commit is not revoked, or null while there is none. */
  restoredBy: DeployRef | null;
  /** Seconds from the failed deploy to `restoredBy`, or null while it is not restored. */
  restoreSeconds: number | null;
}

/** The four metrics of one environment. */
export interface EnvironmentMetrics {
  env: string;
  deployments: {
    /** Deploy records in the window, one per component deployed, leaving out redeploys. Rollbacks count. */
    count: number;
    /** Redeploys in the window: records that put the running release back, counted apart from `count`. */
    redeploys: number;
    /** Distinct `runId` values among them, so a run that deploys several components counts once. */
    runs: number;
    /** Of `count`, the deploys made from a release. */
    fromRelease: number;
    /** `count` over the window in weeks, to two decimals. */
    perWeek: number;
  };
  leadTime: {
    /** Changes whose first deploy here falls in the window and whose commit time is known. */
    changes: number;
    /** Of `changes`, releases (the first deploy naming the release). */
    fromRelease: number;
    /** Of `changes`, commits deployed from no release (the first deploy with that `gitSha`). */
    fromCommit: number;
    /** Changes left out because their commit is not in this repository. */
    unknown: number;
    /** The median, in seconds, or null when `changes` is 0. */
    medianSeconds: number | null;
  };
  changeFailure: {
    deployments: number;
    failed: number;
    /** Failed deploys whose commit was revoked within the window after them. */
    revoked: number;
    /** Failed deploys the environment was rolled back from within the window after them. */
    rolledBack: number;
    /** `failed` over `deployments`, to four decimals, or null with no deployments. */
    rate: number | null;
  };
  restore: {
    restored: number;
    open: number;
    medianSeconds: number | null;
  };
  /** The failed deploys in the window, oldest first. */
  failures: DeployFailure[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

const at = (iso: string): number => Date.parse(iso);
const ref = (r: ReleaseRecord): DeployRef => ({ runId: r.runId, timestamp: r.timestamp });

/**
 * The metrics of one environment's records. `records` is the whole ledger of
 * the environment, every component, in ledger order: deploys before the
 * window still decide lead times, and deploys after a failure decide its
 * restore. Only deploys whose `timestamp` falls in `window` are counted.
 */
export function environmentMetrics(
  env: string,
  records: readonly ReleaseRecord[],
  lookups: MetricsLookups,
  window: MetricsWindow,
  failureWindowDays: number = DEFAULT_FAILURE_WINDOW_DAYS,
): EnvironmentMetrics {
  // Ledger order breaks timestamp ties, as `latestPerComponent` does. A
  // release that skipped a component (#4695) deployed nothing: its record is
  // in no metric.
  const sorted = records.filter((r) => r.unchangedSince === undefined).map((r, i) => ({ r, i })).sort((a, b) => at(a.r.timestamp) - at(b.r.timestamp) || a.i - b.i).map((x) => x.r);
  const since = at(window.since);
  const until = at(window.until);
  const failureMs = failureWindowDays * DAY_MS;
  const inWindow = (r: ReleaseRecord) => at(r.timestamp) >= since && at(r.timestamp) <= until;

  const facts = sorted.map((r) => {
    const releaseDigest = lookups.releaseOf(r) ?? null;
    const commit = (releaseDigest !== null ? lookups.commitOfRelease(releaseDigest) : null) ?? r.gitSha;
    return { r, releaseDigest, commit, revocation: lookups.revocationOf(commit) };
  });

  // A redeploy puts the running release back: it is counted apart, and
  // neither fails nor restores on its own.
  const deployments = facts.filter((f) => inWindow(f.r) && !isRedeploy(f.r));
  const failures: DeployFailure[] = [];
  for (const [i, f] of facts.entries()) {
    if (!inWindow(f.r) || isRedeploy(f.r)) continue;
    const t = at(f.r.timestamp);
    const later = facts.slice(i + 1).filter((g) => g.r.component === f.r.component);

    // Revoked within the window after the deploy. A tag with no time, or one
    // made before the deploy, revokes what was deployed all the same.
    const revoked = f.revocation !== null && (f.revocation.tagged === null || at(f.revocation.tagged) - t <= failureMs) ? f.revocation : null;

    // Rolled back from it: the next deploy of the component that is not a
    // redeploy is a rollback, within the window.
    const next = later.find((g) => !isRedeploy(g.r));
    const rolledBack = next !== undefined && rollbackOf(next.r) !== null && at(next.r.timestamp) - t <= failureMs ? next.r : null;

    if (!revoked && !rolledBack) continue;
    const restore = later.find((g) => !isRedeploy(g.r) && g.revocation === null);
    failures.push({
      component: f.r.component,
      timestamp: f.r.timestamp,
      runId: f.r.runId,
      releaseDigest: f.releaseDigest,
      label: f.releaseDigest !== null ? lookups.labelOf(f.releaseDigest) : null,
      commit: f.commit,
      causes: [...(revoked ? (["revoked"] as const) : []), ...(rolledBack ? (["rolled-back"] as const) : [])],
      revoked,
      rolledBackBy: rolledBack ? ref(rolledBack) : null,
      restoredBy: restore ? ref(restore.r) : null,
      restoreSeconds: restore ? Math.round((at(restore.r.timestamp) - t) / 1000) : null,
    });
  }

  // Lead time: one change per release, or per commit deployed from no
  // release, timed at its first deploy in this environment.
  const firstDeploy = new Map<string, (typeof facts)[number]>();
  for (const f of facts) {
    const key = f.releaseDigest !== null ? `release:${f.releaseDigest}` : `commit:${f.r.gitSha}`;
    if (!firstDeploy.has(key)) firstDeploy.set(key, f);
  }
  const leads: number[] = [];
  let fromRelease = 0;
  let unknown = 0;
  for (const f of firstDeploy.values()) {
    if (!inWindow(f.r)) continue;
    const committed = lookups.commitTime(f.commit);
    if (committed === null) {
      unknown++;
      continue;
    }
    leads.push(Math.max(0, (at(f.r.timestamp) - committed) / 1000));
    if (f.releaseDigest !== null) fromRelease++;
  }

  const weeks = Math.max(until - since, DAY_MS) / (7 * DAY_MS);
  const restored = failures.filter((x) => x.restoreSeconds !== null);
  return {
    env,
    deployments: {
      count: deployments.length,
      redeploys: facts.filter((f) => inWindow(f.r) && isRedeploy(f.r)).length,
      runs: new Set(deployments.map((f) => f.r.runId)).size,
      fromRelease: deployments.filter((f) => f.releaseDigest !== null).length,
      perWeek: Math.round((deployments.length / weeks) * 100) / 100,
    },
    leadTime: { changes: leads.length, fromRelease, fromCommit: leads.length - fromRelease, unknown, medianSeconds: median(leads) },
    changeFailure: {
      deployments: deployments.length,
      failed: failures.length,
      revoked: failures.filter((x) => x.revoked !== null).length,
      rolledBack: failures.filter((x) => x.rolledBackBy !== null).length,
      rate: deployments.length === 0 ? null : Math.round((failures.length / deployments.length) * 10_000) / 10_000,
    },
    restore: { restored: restored.length, open: failures.length - restored.length, medianSeconds: median(restored.map((x) => x.restoreSeconds!)) },
    failures,
  };
}
