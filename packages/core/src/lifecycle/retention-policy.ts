/**
 * How long chant keeps each kind of stored record (#4036): the retention
 * policy `chant lifecycle gc` prunes by. It reads no git, so the workspace
 * declaration's parser imports it for the defaults and the shape.
 *
 * Three kinds are pruned:
 *
 *   changeSets   `_change-sets/<digest>.json` on `chant/lifecycle` (#4022)
 *   releases     `_releases/<digest>.json` on `chant/lifecycle` (#4026), with
 *                the template bytes under `_releases/templates/` that only
 *                pruned releases name
 *   runEvents    `<git-common-dir>/chant/run-events/<run>.jsonl`, local only (#4042)
 *
 * The ledgers (`cuts.jsonl`, `<env>/releases.jsonl`, `_gates/<op>.jsonl` and
 * the run ledgers) are append-only and never pruned. See ./retention.ts.
 */

/** The retention of one kind: the age in days past which a record can go, and, where it applies, how many of the newest are kept whatever their age. */
export interface KindRetention {
  days: number;
  keep: number;
}

/** The retention of every kind, with the defaults filled in. */
export interface RetentionPolicy {
  /** A stored change set is kept for `days` after it was stored or last named by a gate fact, whichever is later. `keep` does not apply and is 0. */
  changeSets: KindRetention;
  /** A release is promotable for `days` after its newest cut, and the newest `keep` releases of each member stay promotable at any age. */
  releases: KindRetention;
  /** A run's event file is kept for `days` after its last write, and the newest `keep` files are kept at any age. */
  runEvents: KindRetention;
}

/** The record kinds a policy names, in the order a report lists them. */
export const RETENTION_KINDS = ["changeSets", "releases", "runEvents"] as const;
export type RetentionKind = (typeof RETENTION_KINDS)[number];

/**
 * The defaults. At chant's own rate (about 25 pull-request gates, 28 main
 * commits and 5 release cuts a day in September and October 2026) two weeks
 * keeps every change set an open pull request or a promotion can still need,
 * and the newest ten releases of a member cover a member that cuts rarely.
 */
export const DEFAULT_RETENTION: RetentionPolicy = {
  changeSets: { days: 14, keep: 0 },
  releases: { days: 14, keep: 10 },
  runEvents: { days: 14, keep: 100 },
};

/** The declaration's `retention` block as written: any kind or field may be left out. */
export type RetentionOverride = Partial<Record<RetentionKind, Partial<KindRetention>>>;

/** The policy an override gives: each field it sets replaces the default. */
export function resolveRetention(override?: RetentionOverride | null): RetentionPolicy {
  const out = structuredClone(DEFAULT_RETENTION);
  for (const kind of RETENTION_KINDS) {
    const o = override?.[kind];
    if (!o) continue;
    if (typeof o.days === "number") out[kind].days = o.days;
    if (typeof o.keep === "number" && kind !== "changeSets") out[kind].keep = o.keep;
  }
  return out;
}
