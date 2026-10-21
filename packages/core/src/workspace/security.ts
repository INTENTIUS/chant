/**
 * The security groups a workspace opts into (#4168 section 8): the
 * declaration's top-level `security`, such as `["verified-releases"]`. With
 * no `security` key none is on, and a security feature the workspace has not
 * turned on never refuses, warns or hides anything (the rule #4156 set for
 * runner signing).
 *
 * What each group turns on so far:
 * - `verified-releases`: `chant release publish` refuses a release with no
 *   verified signature, as the `release` gate in `identity.gates` does.
 * - `supply-chain`: a publish without OIDC provenance warns, and a target
 *   with no SBOM source is refused (`publish-sbom-missing`).
 * - `review-rules`: a generated pull-request pipeline passes
 *   `--require-review`.
 * - `who-ran-it` and `isolated-runners`: accepted, and nothing reads them yet.
 *
 * Each feature still turns on alone: `identity.gates.release`,
 * `--require-provenance`, `--require-review`. #4168 step 7 adds per-member
 * groups, `chant ci init --security <group>` and the `workspace check`
 * checklists, on this module.
 */
import type { Declaration } from "./declaration";
import { scopeSource } from "./write-scope";

export const SECURITY_GROUPS = ["verified-releases", "supply-chain", "who-ran-it", "review-rules", "isolated-runners"] as const;

export type SecurityGroup = (typeof SECURITY_GROUPS)[number];

/** The groups `declaration` turns on; empty for no declaration or no `security` key. */
export function securityGroupsOf(declaration: Pick<Declaration, "security"> | null | undefined): ReadonlySet<SecurityGroup> {
  return new Set(declaration?.security ?? []);
}

/**
 * The groups the workspace holding `cwd` turns on, read at base (the target
 * branch tip) when there is one, else from the working tree, as the release
 * gate is read. Empty outside a workspace.
 */
export function securityGroupsAt(cwd: string, at?: string): ReadonlySet<SecurityGroup> {
  return securityGroupsOf(scopeSource(cwd, at).declaration);
}
