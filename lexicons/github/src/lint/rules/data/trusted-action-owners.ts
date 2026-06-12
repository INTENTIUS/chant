/**
 * Allowlist of trusted action owners (GitHub orgs) whose `uses:` references are
 * exempt from the SHA-pinning check (GHA029).
 *
 * Ships EMPTY by default: chant recommends pinning every external reference to a
 * full commit SHA, including first-party ones. Populate this set to silence the
 * pinning check for orgs you have decided to trust by tag (e.g. your own org).
 *
 * This is a vendored, code-level allowlist — `PostSynthContext` carries no
 * per-check runtime config channel today. Refresh it by editing this file.
 */
export const TRUSTED_ACTION_OWNERS: ReadonlySet<string> = new Set<string>([]);
