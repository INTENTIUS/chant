/**
 * The security profiles (#5464): `fedramp-moderate` and `cccs-medium`,
 * named in the declaration's top-level `security` beside the groups.
 *
 * A profile turns on every security group, changes two behaviours by a
 * number of its own, and adds a `chant workspace check` of its own:
 *
 * - `chant lifecycle gc` keeps change sets and releases for at least the
 *   profile's days ({@link retentionUnderProfiles}). A longer `retention` in
 *   the declaration is kept; a shorter one is reported and not used.
 * - a publish refuses a scan whose vulnerability database is older than the
 *   profile's hours, or whose age the scanner can't say
 *   (`publish-scan-db-stale`, {@link scanDatabaseBound}). A shorter
 *   `release.scan.dbMaxAgeHours` is kept; a longer one is reported and not
 *   used.
 * - `WSP166` (`fedramp-moderate`) and `WSP167` (`cccs-medium`) report what
 *   the profile looks for and the workspace lacks ({@link PROFILE_CHECKS},
 *   ./checks/security-profiles.ts).
 *
 * A profile produces evidence toward the controls each check names
 * (./security-controls.ts). It does not make a system compliant or
 * authorised: the system owner implements the controls and an assessor
 * decides whether they are met.
 */

import { NEXT_RELEASE } from "../release-floors";
import type { RetentionPolicy } from "../lifecycle/retention-policy";
import type { ScanDatabase } from "../lifecycle/publish-scan";
import type { ReasonCode } from "./reason-codes";
import type { SecurityGroup } from "./security";
import { CONTROLS_OUTSIDE_BOTH_BASELINES, SECURITY_CONTROLS, selectedIds, type BaselineMark } from "./security-controls";

/**
 * The first chant that reads a security profile in the declaration's
 * `security` (#5464): `fedramp-moderate` and `cccs-medium`, which turn on
 * every group, the retention floor `chant lifecycle gc` keeps, the scanner
 * database age a publish refuses past (`release.scan.dbMaxAgeHours`,
 * `publish-scan-db-stale`), and the checks `WSP166` and `WSP167`. An older
 * chant refuses a declaration that names one, so such a declaration sets
 * `minReader` to it.
 */
export const SECURITY_PROFILES_FLOOR = NEXT_RELEASE;

export const SECURITY_PROFILES = ["fedramp-moderate", "cccs-medium"] as const;
export type SecurityProfile = (typeof SECURITY_PROFILES)[number];

export function isSecurityProfile(name: string): name is SecurityProfile {
  return (SECURITY_PROFILES as readonly string[]).includes(name);
}

/** What one profile is: the baseline it reads, the groups it turns on, its numbers and its check. */
export interface ProfileSpec {
  profile: SecurityProfile;
  /** The baseline, as its source names it. */
  baseline: string;
  /** The catalogue its control ids come from. */
  catalogue: string;
  /** The groups it turns on. */
  groups: readonly SecurityGroup[];
  /** The fewest days `chant lifecycle gc` keeps change sets and releases. */
  retentionDays: number;
  /** Where {@link retentionDays} comes from. */
  retentionFrom: string;
  /** The oldest scanner database, in hours at scan time, a publish takes. */
  scanDbMaxAgeHours: number;
  /** Where {@link scanDbMaxAgeHours} comes from. */
  scanDbFrom: string;
  /** Its `chant workspace check` id. */
  check: string;
}

const ALL_GROUPS: readonly SecurityGroup[] = ["verified-releases", "supply-chain", "who-ran-it", "review-rules", "isolated-runners"];

export const PROFILE_SPECS: Readonly<Record<SecurityProfile, ProfileSpec>> = {
  "fedramp-moderate": {
    profile: "fedramp-moderate",
    baseline: "the FedRAMP Rev. 5 Moderate baseline",
    catalogue: "NIST SP 800-53 Rev. 5",
    groups: ALL_GROUPS,
    retentionDays: 90,
    retentionFrom: "FedRAMP's AU-11 parameter: on-line for at least 90 days",
    scanDbMaxAgeHours: 24,
    scanDbFrom: "FedRAMP's RA-5(2) parameter: within 24 hours prior to running scans",
    check: "WSP166",
  },
  "cccs-medium": {
    profile: "cccs-medium",
    baseline: "the CCCS Medium cloud profile",
    catalogue: "ITSG-33, which follows NIST SP 800-53 Rev. 4",
    groups: ALL_GROUPS,
    retentionDays: 90,
    retentionFrom: "the FedRAMP figure, which chant uses for CCCS Medium too",
    scanDbMaxAgeHours: 24,
    scanDbFrom: "the FedRAMP figure, which chant uses for CCCS Medium too",
    check: "WSP167",
  },
};

/** One check a profile adds: its reason code, what it reports, and every control id it bears on in either baseline. */
export interface ProfileCheck {
  code: (typeof PROFILE_FINDING_CODES)[number];
  /** What it reports, as the profile page says it. */
  reports: string;
  /** The ids it bears on; {@link selectedIds} keeps a profile's own. */
  controls: readonly string[];
}

/** The read contract's codes for the profile findings. */
export const PROFILE_FINDING_CODES = [
  "profile-retention-short",
  "profile-gate-not-human",
  "profile-scan-off",
  "profile-scan-db-unbounded",
  "profile-signing-off",
  "profile-signing-module",
  "profile-runner-key-eddsa",
] as const satisfies readonly ReasonCode[];

export const PROFILE_CHECKS: readonly ProfileCheck[] = [
  { code: "profile-retention-short", reports: "`retention.changeSets.days` or `retention.releases.days` is unset or below the profile's days", controls: ["AU-11"] },
  {
    code: "profile-gate-not-human",
    reports: "`identity.gates.release`, or a gate an apply job names, is missing, names no class, names a class an agent, runner or service principal holds, or sets `agentPassesAlone: true`",
    controls: ["AC-5", "CM-3(4)"],
  },
  { code: "profile-scan-off", reports: "a member's `chant.config.ts` sets `release.scan: false`", controls: ["RA-5"] },
  { code: "profile-scan-db-unbounded", reports: "`release.scan.db` is set with no `dbMaxAgeHours`, or `dbMaxAgeHours` is above the profile's hours", controls: ["RA-5(2)"] },
  { code: "profile-signing-off", reports: "a member's `chant.config.ts` sets `release.signing: false`", controls: ["SI-7", "SA-10(1)", "SR-11"] },
  {
    code: "profile-signing-module",
    reports: "a member signs images or forge assets keylessly or with `key`, and its `chant.config.ts` names no `CHANT_COSIGN`, so the upstream cosign build makes the signature",
    controls: ["SC-13"],
  },
  { code: "profile-runner-key-eddsa", reports: "`.chant/trust.json` lists an `ssh-ed25519` key under `runners` or `local.keys`", controls: ["SC-13"] },
];

/** The profiles a declaration's top-level `security` names, in file order. */
export function profilesOf(declaration: { security?: readonly string[] } | null | undefined): SecurityProfile[] {
  return (declaration?.security ?? []).filter(isSecurityProfile);
}

/** The groups `entry` turns on: itself for a group, the profile's groups for a profile. */
export function groupsOfEntry(entry: string): readonly SecurityGroup[] {
  return isSecurityProfile(entry) ? PROFILE_SPECS[entry].groups : [entry as SecurityGroup];
}

/** The control ids among `ids` that `profile`'s baseline selects, as a finding names them. */
export function profileControls(profile: SecurityProfile, ids: readonly string[]): string[] {
  return selectedIds(profile, ids);
}

/** A kind `retentionUnderProfiles` raised: its declared days and the days kept. */
export interface RetentionRaise {
  kind: "changeSets" | "releases";
  declared: number;
  kept: number;
  profile: SecurityProfile;
}

/**
 * The retention `chant lifecycle gc` prunes by under `profiles`: each of
 * change sets and releases kept for at least the longest days a profile
 * asks. A longer `days` stays. Run events are left as they are: they live in
 * one clone.
 */
export function retentionUnderProfiles(policy: RetentionPolicy, profiles: readonly SecurityProfile[]): { policy: RetentionPolicy; raised: RetentionRaise[] } {
  const out = structuredClone(policy);
  const raised: RetentionRaise[] = [];
  const strictest = [...profiles].sort((a, b) => PROFILE_SPECS[b].retentionDays - PROFILE_SPECS[a].retentionDays)[0];
  if (!strictest) return { policy: out, raised };
  const floor = PROFILE_SPECS[strictest].retentionDays;
  for (const kind of ["changeSets", "releases"] as const) {
    if (out[kind].days >= floor) continue;
    raised.push({ kind, declared: out[kind].days, kept: floor, profile: strictest });
    out[kind].days = floor;
  }
  return { policy: out, raised };
}

/** The bound on a scanner database's age at publish, and what set it. */
export interface ScanDatabaseBound {
  maxHours: number;
  /** `release.scan.dbMaxAgeHours`, or the profile that set a shorter one. */
  from: string;
}

/**
 * The bound a publish holds a scanner database to: the shortest of
 * `release.scan.dbMaxAgeHours` and each profile's hours. Null with neither,
 * and then nothing is refused for age.
 */
export function scanDatabaseBound(configured: number | undefined, profiles: readonly SecurityProfile[]): ScanDatabaseBound | null {
  let bound: ScanDatabaseBound | null = configured !== undefined ? { maxHours: configured, from: "release.scan.dbMaxAgeHours" } : null;
  for (const p of profiles) {
    const hours = PROFILE_SPECS[p].scanDbMaxAgeHours;
    if (bound === null || hours < bound.maxHours) bound = { maxHours: hours, from: `the ${p} security profile` };
  }
  return bound;
}

/**
 * Why a scan's database is too old for `bound`, in a sentence, or null when
 * it is within it. A database whose build time the scanner can't say is
 * refused too: its age can't be shown.
 */
export function scanDatabaseStale(database: ScanDatabase | null, bound: ScanDatabaseBound, now: Date): string | null {
  const built = database?.built ? Date.parse(database.built) : Number.NaN;
  if (Number.isNaN(built)) {
    return `the scanner did not say when its database was built, so its age can't be held to ${bound.maxHours} hours, as ${bound.from} asks`;
  }
  const hours = (now.getTime() - built) / 3_600_000;
  if (hours <= bound.maxHours) return null;
  return `the scanner's database was built at ${database!.built}, ${Math.floor(hours)} hours before the scan, and ${bound.from} takes one no older than ${bound.maxHours} hours`;
}

/** The fix `publish-scan-db-stale` prints. */
export const SCAN_DB_STALE_FIX =
  "Update the scanner's database in the job before the publish (grype db update, or trivy with its database download on), or refresh the directory release.scan.db names, then publish again. The scan record keeps the database's version and build time.";

/** The fix `release-scan-db-stale` prints, for `chant release scan` (#5466) under the same bound. */
export const RESCAN_DB_STALE_FIX =
  "Update the scanner's database before the rescan (grype db update, or trivy with its database download on), or refresh the directory release.scan.db names, then scan again. The rescan's line keeps the database's version and build time, and why it was stale.";

const MARK: Record<BaselineMark, string> = { selected: "yes", "not-selected": "-", "not-in-catalogue": "n/a" };

/** The profile page's table of the profiles, as markdown. */
export function profileTable(): string {
  const rows = SECURITY_PROFILES.map((p) => {
    const s = PROFILE_SPECS[p];
    return `| \`${p}\` | ${s.baseline} (${s.catalogue}) | ${s.groups.map((g) => `\`${g}\``).join(", ")} | ${s.retentionDays} days | ${s.scanDbMaxAgeHours} hours | \`${s.check}\` |`;
  });
  return ["| Profile | Baseline | Groups it turns on | Retention at least | Scanner database at most | Check |", "|---|---|---|---|---|---|", ...rows].join("\n");
}

/** The profile page's table of {@link PROFILE_CHECKS}, as markdown, with the ids each baseline selects. */
export function profileCheckTable(): string {
  const rows = PROFILE_CHECKS.map((c) => `| \`${c.code}\` | ${c.reports} | ${profileControls("fedramp-moderate", c.controls).join(", ") || "none"} | ${profileControls("cccs-medium", c.controls).join(", ") || "none"} |`);
  return ["| Code | Reports | FedRAMP Moderate | CCCS Medium |", "|---|---|---|---|", ...rows].join("\n");
}

/** The profile page's table of {@link SECURITY_CONTROLS}, as markdown. */
export function controlTable(): string {
  const rows = SECURITY_CONTROLS.map((c) => {
    const title = c.cccsTitle ? `${c.title} (CCCS: ${c.cccsTitle})` : c.title;
    const checks = [...c.codes, ...c.doctor].map((x) => `\`${x}\``).join(", ") || "none";
    return `| ${c.id} | ${title} | ${MARK[c.baselines["fedramp-moderate"]]} | ${MARK[c.baselines["cccs-medium"]]} | ${c.evidence.join(", ")} | ${checks} |`;
  });
  return ["| Control | Title | FedRAMP Moderate | CCCS Medium | Evidence | Checks |", "|---|---|---|---|---|---|", ...rows].join("\n");
}

/** The profile page's table of {@link CONTROLS_OUTSIDE_BOTH_BASELINES}, as markdown. */
export function outsideTable(): string {
  return ["| Control | Title | Why it is in neither |", "|---|---|---|", ...CONTROLS_OUTSIDE_BOTH_BASELINES.map((c) => `| ${c.id} | ${c.title} | ${c.note} |`)].join("\n");
}
