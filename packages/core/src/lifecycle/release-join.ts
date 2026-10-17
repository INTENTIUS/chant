/**
 * Join a commit, a release, its gates and its deploy records through the
 * release digest (#4043, ws-104).
 *
 * The records already name one another. A release file holds its `commit`; a
 * release gate's pending fact and resolution hold the `releaseDigest`; a deploy
 * record holds the `releaseDigest` when the deploy was made from a release.
 * From any one of the four, the others are one lookup away:
 *
 *   commit  to releases      `_releases/*.json` `commit`
 *   release to gates         `releaseDigest` on the records of `_gates/release.jsonl`
 *   release to deploys       `releaseDigest` on the records of every `<env>/releases.jsonl`
 *
 * This is the one place that does it, for the readers that need the chain
 * (the why chain of #4023, behold). Release plus a deploy record's `env`
 * names the release target.
 *
 * Read-only. Reads the local `chant/lifecycle` branch; fetch it first for the
 * remote's records. A release digest or commit that nothing recorded joins to
 * an empty list rather than an error.
 */

import { RELEASE_GATE_OP } from "../op/gate-name";
import { readGateLedger, type GateResolutionRecord, type PendingGateRecord } from "./gate-ledger";
import { listReleaseEnvironments, readReleaseLedger, type ReleaseRecord } from "./release-ledger";
import { labelsByDigest, readAllReleases, readCuts, type Release, type ReleaseCut } from "./release-store";
import type { LedgerLocation } from "./git";

/** Where a join starts. Each names the others one lookup away. */
export type ReleaseJoinStart =
  /** A full commit sha, or a prefix of at least 7 characters. Joins to every release cut from it. */
  | { commit: string }
  /** A release's label or its `releaseDigest`. */
  | { release: string }
  /**
   * A deploy record. It joins through its `releaseDigest`; a record with none
   * but an admission by the release gate joins through the resolution that
   * admission names.
   */
  | { deploy: Pick<ReleaseRecord, "releaseDigest" | "admission"> }
  /** A release gate's pending fact or resolution. */
  | { gate: Pick<PendingGateRecord | GateResolutionRecord, "releaseDigest"> };

/** One release with everything the digest joins to it. */
export interface JoinedRelease {
  releaseDigest: string;
  /** The label of the release, or null when it was cut with none. */
  label: string | null;
  /** The green commit the release was cut from. */
  commit: string;
  release: Release;
  /** Every cut of the release, oldest first. */
  cuts: ReleaseCut[];
  /** The release gate's facts for this release (`_gates/release.jsonl`), oldest first. */
  gates: { pending: PendingGateRecord[]; resolutions: GateResolutionRecord[] };
  /** Every deploy record that names the release, across environments, oldest first. Each record's `env` with the release names the target. */
  deploys: ReleaseRecord[];
}

/** What {@link joinRelease} returns. */
export interface ReleaseJoin {
  /** The releases the starting point joins to: one for a release, a gate or a deploy, any number for a commit. */
  releases: JoinedRelease[];
  /** Why `releases` is empty, when the starting point could not be followed. Absent otherwise. */
  reason?: string;
}

/** The version of the shape above, for a reader that stores it. Chant 0.124.29 and newer. */
export const RELEASE_JOIN_VERSION = 1;

const MIN_COMMIT_PREFIX = 7;

/**
 * Follow one record to the rest of its chain. Never throws for an unknown
 * starting point; a ledger that can't be read does throw, as those readers do.
 */
export async function joinRelease(from: ReleaseJoinStart, loc: LedgerLocation = {}): Promise<ReleaseJoin> {
  const { releases } = await readAllReleases(loc);
  const { cuts } = await readCuts(loc);
  const labels = labelsByDigest(cuts);

  let digests: string[];
  let reason: string | undefined;
  if ("commit" in from) {
    const sha = from.commit.toLowerCase();
    if (sha.length < MIN_COMMIT_PREFIX) {
      return { releases: [], reason: `a commit needs at least ${MIN_COMMIT_PREFIX} characters to join on` };
    }
    digests = releases.filter((r) => r.commit.toLowerCase().startsWith(sha)).map((r) => r.releaseDigest);
    if (digests.length === 0) reason = `no release was cut from commit ${from.commit}`;
  } else if ("release" in from) {
    const ref = from.release;
    const byDigest = releases.find((r) => r.releaseDigest === ref);
    const byLabel = [...labels].find(([, label]) => label === ref)?.[0];
    const found = byDigest?.releaseDigest ?? byLabel;
    digests = found ? [found] : [];
    if (digests.length === 0) reason = `no release is labelled or digested "${ref}"`;
  } else if ("deploy" in from) {
    const digest = from.deploy.releaseDigest ?? (await releaseOfAdmission(from.deploy.admission, loc));
    digests = digest ? [digest] : [];
    if (digests.length === 0) reason = "the deploy record names no release: it was not made from one";
  } else {
    const digest = from.gate.releaseDigest;
    digests = digest ? [digest] : [];
    if (digests.length === 0) reason = "the gate binds no release: it is not a release gate";
  }

  const known = new Map(releases.map((r) => [r.releaseDigest, r]));
  const wanted = [...new Set(digests)].filter((d) => known.has(d));
  if (digests.length > 0 && wanted.length === 0) reason = `release ${digests[0]} is named but its file is not on this checkout's chant/lifecycle`;
  if (wanted.length === 0) return { releases: [], ...(reason ? { reason } : {}) };

  const gateLedger = await readGateLedger(RELEASE_GATE_OP, loc);
  const records: ReleaseRecord[] = [];
  for (const env of await listReleaseEnvironments(loc)) {
    for (const record of (await readReleaseLedger(env, loc)).records) {
      if (record.releaseDigest !== undefined && wanted.includes(record.releaseDigest)) records.push(record);
    }
  }
  const byTime = (a: { timestamp: string }, b: { timestamp: string }): number => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);

  return {
    releases: wanted.map((digest) => {
      const release = known.get(digest)!;
      return {
        releaseDigest: digest,
        label: labels.get(digest) ?? null,
        commit: release.commit,
        release,
        cuts: cuts.filter((c) => c.releaseDigest === digest),
        gates: {
          pending: gateLedger.pending.filter((p) => p.releaseDigest === digest),
          resolutions: gateLedger.resolutions.filter((r) => r.releaseDigest === digest),
        },
        deploys: records.filter((r) => r.releaseDigest === digest).sort(byTime),
      };
    }),
  };
}

/**
 * The release a deploy record's admission names, when the record itself has no
 * `releaseDigest`: the resolution it points at, in the release gate's ledger,
 * carries one (#4045).
 */
async function releaseOfAdmission(admission: ReleaseRecord["admission"], loc: LedgerLocation): Promise<string | undefined> {
  if (!admission || admission.op !== RELEASE_GATE_OP) return undefined;
  const { resolutions } = await readGateLedger(RELEASE_GATE_OP, loc);
  return resolutions.find((r) => r.gate === admission.gate && r.timestamp === admission.resolvedAt && r.releaseDigest !== undefined)?.releaseDigest;
}
