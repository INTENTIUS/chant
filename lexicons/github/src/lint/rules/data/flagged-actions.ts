/**
 * Vendored snapshot of action `owner/repo` slugs that are archived/abandoned or
 * carry a disclosed security issue. Used by GHA032.
 *
 * Advisory only, and necessarily incomplete. Refresh source: GitHub Security
 * Advisories (GHSA), CVE feeds, and upstream "archived" repo status. Accept
 * staleness — regenerate periodically by editing this map. A missing entry only
 * means a known-bad upstream goes unflagged; it never blocks a build.
 *
 * Keep entries factual and dated so the advice stays actionable.
 */
export interface FlaggedAction {
  /** Why the upstream is flagged. */
  reason: string;
  /** What to do instead. */
  remediation: string;
}

export const FLAGGED_ACTIONS: Readonly<Record<string, FlaggedAction>> = {
  "tj-actions/changed-files": {
    reason: "supply-chain compromise disclosed March 2025 (CVE-2025-30066) — tags were repointed to leak CI secrets",
    remediation: "pin to a vetted commit SHA from before the compromise, or migrate to an audited alternative",
  },
  "actions/setup-ruby": {
    reason: "archived and unmaintained",
    remediation: "use ruby/setup-ruby",
  },
  "actions/create-release": {
    reason: "archived and unmaintained",
    remediation: "use softprops/action-gh-release or the gh CLI",
  },
  "actions/upload-release-asset": {
    reason: "archived and unmaintained",
    remediation: "use softprops/action-gh-release or the gh CLI",
  },
};
