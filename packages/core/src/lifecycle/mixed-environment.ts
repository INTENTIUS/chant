/**
 * Whether an environment runs a mix of releases, and the lines that settle
 * it (#4035). Derived when read, from the environment's release ledger and
 * its deploy outcomes (./deploy-outcome.ts); nothing here is written.
 *
 * Two things make an environment mixed:
 *
 * - a component is unsettled: the newest promote, rollback or redeploy that
 *   named it left it `failed` or `gated`, and the release ledger has no
 *   record of it newer than that run, so what it runs is not known;
 * - the latest records of its components name more than one release, a
 *   record of no release counting as one value, and at least one names a
 *   release.
 *
 * The ledger already says per component what deployed, and with which
 * release, so the second needs no record of its own. Only the first needs
 * the outcome: a failed deploy writes no release record, by design, so the
 * ledger alone can't tell a component that failed partway from one that was
 * never touched.
 */

import type { ReleaseRecord } from "./release-ledger";
import type { DeployOutcome } from "./deploy-outcome";

/** One component of a mixed environment. */
export interface MixedComponent {
  component: string;
  /** The digest the release ledger records the component running, or null when it has no record in the environment. */
  digest: string | null;
  /** The release that record names, or null. */
  releaseDigest: string | null;
  releaseLabel: string | null;
  /** `settled` when the ledger's record is what it runs; `failed` or `gated` when the newest run that named it left it so. */
  state: "settled" | "failed" | "gated";
  /** For an unsettled component, the run that left it so and what that run was deploying. Null when settled. */
  attempt: {
    verb: DeployOutcome["verb"];
    runId: string;
    timestamp: string;
    digest: string;
    releaseDigest: string | null;
    releaseLabel: string | null;
  } | null;
}

export interface MixedEnvironment {
  /** Every component the ledger records or a run left unsettled, sorted by name. */
  components: MixedComponent[];
  /** `chant components redeploy <env> --component <c>` for each unsettled component the ledger records, which puts its recorded release back. */
  redeploy: string[];
  /** `chant components rollback <env> --release <label|digest>`, naming the release to go back to, or null when there is none to name. */
  rollback: string | null;
}

/** What a reader knows about a release a rollback could go back to. */
export interface ReleaseCheck {
  /** Its release file can still be read, so its templates can be deployed. */
  kept: boolean;
  /** Its commit is revoked (#4033), so it is refused. */
  revoked: boolean;
}

function latest(records: readonly ReleaseRecord[]): Map<string, ReleaseRecord> {
  const out = new Map<string, ReleaseRecord>();
  for (const r of records) {
    const current = out.get(r.component);
    if (!current || r.timestamp >= current.timestamp) out.set(r.component, r);
  }
  return out;
}

/**
 * The components a run left unsettled: for each, the newest outcome naming it
 * `failed` or `gated` that no release record of it is newer than.
 */
export function unsettledComponents(
  records: readonly ReleaseRecord[],
  outcomes: readonly DeployOutcome[],
): Map<string, { outcome: DeployOutcome; state: "failed" | "gated"; digest: string; releaseDigest: string | null }> {
  const newest = new Map<string, { outcome: DeployOutcome; state: "failed" | "gated"; digest: string; releaseDigest: string | null }>();
  for (const outcome of outcomes) {
    for (const c of outcome.components) {
      if (c.outcome !== "failed" && c.outcome !== "gated") continue;
      const seen = newest.get(c.component);
      if (!seen || outcome.timestamp >= seen.outcome.timestamp) {
        newest.set(c.component, { outcome, state: c.outcome, digest: c.digest, releaseDigest: c.releaseDigest });
      }
    }
  }
  const recorded = latest(records);
  for (const [component, u] of newest) {
    const r = recorded.get(component);
    if (r && r.timestamp > u.outcome.timestamp) newest.delete(component);
  }
  return newest;
}

/**
 * The newest release the environment's ledger names that a rollback can go
 * back to: not in `exclude`, still kept, and not revoked. With `before`, only
 * records older than that time count. Null when there is none.
 */
export async function rollbackTarget(input: {
  records: readonly ReleaseRecord[];
  exclude: ReadonlySet<string>;
  before?: string;
  check: (releaseDigest: string) => Promise<ReleaseCheck>;
}): Promise<string | null> {
  const ordered = input.records
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.releaseDigest !== undefined && (input.before === undefined || r.timestamp < input.before))
    .sort((a, b) => (a.r.timestamp === b.r.timestamp ? b.i - a.i : a.r.timestamp < b.r.timestamp ? 1 : -1));
  const seen = new Set<string>();
  for (const { r } of ordered) {
    const digest = r.releaseDigest!;
    if (seen.has(digest) || input.exclude.has(digest)) continue;
    seen.add(digest);
    const check = await input.check(digest);
    if (check.kept && !check.revoked) return digest;
  }
  return null;
}

/** The line that rolls `env` back to a release, by its label when it has one. */
export function releaseRollbackLine(env: string, releaseDigest: string, label: string | null | undefined): string {
  return `chant components rollback ${env} --release ${label ?? releaseDigest}`;
}

/** The line that redeploys one component's recorded release in `env`. */
export function redeployLine(env: string, component: string): string {
  return `chant components redeploy ${env} --component ${component}`;
}

/**
 * The environment's mixed state, or null when it runs one release (or no
 * release at all) and no component is unsettled.
 */
export async function mixedEnvironment(input: {
  env: string;
  records: readonly ReleaseRecord[];
  outcomes: readonly DeployOutcome[];
  /** A release's label, or undefined. */
  label: (releaseDigest: string) => Promise<string | undefined>;
  check: (releaseDigest: string) => Promise<ReleaseCheck>;
}): Promise<MixedEnvironment | null> {
  const { env, records } = input;
  const recorded = latest(records);
  const unsettled = unsettledComponents(records, input.outcomes);
  const releases = new Set([...recorded.values()].map((r) => r.releaseDigest ?? null));
  const divergent = releases.size > 1 && [...releases].some((d) => d !== null);
  if (unsettled.size === 0 && !divergent) return null;

  const labelOf = async (digest: string | null | undefined): Promise<string | null> => (digest ? ((await input.label(digest)) ?? null) : null);
  const names = [...new Set([...recorded.keys(), ...unsettled.keys()])].sort();
  const components: MixedComponent[] = [];
  for (const component of names) {
    const r = recorded.get(component);
    const u = unsettled.get(component);
    components.push({
      component,
      digest: r?.digest ?? null,
      releaseDigest: r?.releaseDigest ?? null,
      releaseLabel: await labelOf(r?.releaseDigest),
      state: u ? u.state : "settled",
      attempt: u
        ? {
            verb: u.outcome.verb,
            runId: u.outcome.runId,
            timestamp: u.outcome.timestamp,
            digest: u.digest,
            releaseDigest: u.releaseDigest,
            releaseLabel: await labelOf(u.releaseDigest),
          }
        : null,
    });
  }

  // The release the environment was moving to is not one to go back to: the
  // one a run left components unsettled on, else, of the releases its
  // components run, the one that reached the environment last.
  const exclude = new Set<string>();
  if (unsettled.size > 0) {
    for (const u of unsettled.values()) if (u.releaseDigest) exclude.add(u.releaseDigest);
  } else {
    const firstSeen = new Map<string, string>();
    for (const r of records) {
      if (r.releaseDigest === undefined) continue;
      const seen = firstSeen.get(r.releaseDigest);
      if (seen === undefined || r.timestamp < seen) firstSeen.set(r.releaseDigest, r.timestamp);
    }
    let arrived: string | undefined;
    for (const d of releases) {
      if (d === null) continue;
      if (arrived === undefined || firstSeen.get(d)! > firstSeen.get(arrived)!) arrived = d;
    }
    if (arrived !== undefined) exclude.add(arrived);
  }
  const target = await rollbackTarget({ records, exclude, check: input.check });
  return {
    components,
    redeploy: components.filter((c) => c.state !== "settled" && c.digest !== null).map((c) => redeployLine(env, c.component)),
    rollback: target ? releaseRollbackLine(env, target, await labelOf(target)) : null,
  };
}
