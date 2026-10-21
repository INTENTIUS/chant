/**
 * The security groups a workspace opts into (#4168 section 8): the
 * declaration's top-level `security`, such as `["verified-releases"]`, plus
 * the `security` of the member a command runs in (#4168 step 7). With no
 * `security` key none is on, and a security feature the workspace has not
 * turned on never refuses, warns or hides anything (the rule #4156 set for
 * runner signing).
 *
 * What each group turns on:
 * - `verified-releases`: `chant release publish` refuses a release with no
 *   verified signature, as the `release` gate in `identity.gates` does, and
 *   `chant components promote --release` verifies the release first.
 * - `supply-chain`: a publish without OIDC provenance warns, and a target
 *   with no SBOM source is refused (`publish-sbom-missing`).
 * - `who-ran-it`: `chant ci tick` refuses to tag without a runner key.
 * - `review-rules`: `chant components pr-apply` counts an approval only from
 *   someone who approved the pull request on the forge, as
 *   `--require-review` does, and a generated pull-request pipeline passes
 *   the flag.
 * - `isolated-runners`: `chant ci run apply`, under `chant ci serve` too,
 *   refuses to start without a provisioner's runner-start statement for the
 *   job (#4147), as `--require-runner-start` does, and a generated
 *   pull-request pipeline passes the flag. A `--local` run is exempt.
 *
 * Each feature still turns on alone: `identity.gates.release`,
 * `--require-provenance`, `--require-review`, `ci.green.signedSince`.
 * `chant workspace check` reports what a declared group still lacks
 * (./checks/security.ts, WSP161 to WSP165). {@link SECURITY_FEATURES} is the
 * table the reference page prints.
 */
import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import type { Declaration } from "./declaration";
import { memberHolding } from "./record-assets";
import { scopeSource, type ScopeSource } from "./write-scope";

export const SECURITY_GROUPS = ["verified-releases", "supply-chain", "who-ran-it", "review-rules", "isolated-runners"] as const;

export type SecurityGroup = (typeof SECURITY_GROUPS)[number];

/**
 * The groups `declaration` turns on for `member` (a member name): the
 * top-level list plus that member's own. Empty for no declaration or no
 * `security` key anywhere.
 */
export function securityGroupsOf(declaration: Pick<Declaration, "security" | "members"> | null | undefined, member: string | null = null): ReadonlySet<SecurityGroup> {
  const own = member === null ? [] : (declaration?.members?.find((m) => m.name === member)?.security ?? []);
  return new Set([...(declaration?.security ?? []), ...own]);
}

/** The member of `source`'s declaration whose directory holds `cwd`, or null. */
export function memberAtCwd(source: Pick<ScopeSource, "declaration" | "rootOnDisk">, cwd: string): string | null {
  if (!source.declaration || source.rootOnDisk === null) return null;
  let rel: string;
  try {
    rel = relative(realpathSync(source.rootOnDisk), realpathSync(cwd));
  } catch {
    rel = relative(source.rootOnDisk, cwd);
  }
  if (rel.startsWith("..")) return null;
  const posix = sep === "/" ? rel : rel.split(sep).join("/");
  return memberHolding(posix === "" ? "." : posix, source.declaration.members);
}

/** The groups `source` turns on for a command run in `cwd`: the top-level list and the list of the member holding `cwd`. */
export function securityGroupsIn(source: Pick<ScopeSource, "declaration" | "rootOnDisk">, cwd: string): ReadonlySet<SecurityGroup> {
  return securityGroupsOf(source.declaration, memberAtCwd(source, cwd));
}

/**
 * The groups the workspace holding `cwd` turns on for the member holding
 * `cwd`, read at base (the target branch tip) when there is one, else from
 * the working tree, as the release gate is read. Empty outside a workspace.
 */
export function securityGroupsAt(cwd: string, at?: string): ReadonlySet<SecurityGroup> {
  return securityGroupsIn(scopeSource(cwd, at), cwd);
}

/** One row of the security feature table (#4168 section 8). */
export interface SecurityFeature {
  feature: string;
  /** What happens with no group and no setting. */
  byDefault: string;
  /** What turns it on alone. */
  setting: string;
  group: SecurityGroup | null;
  /** The `workspace check` reason codes that report it missing under its group. */
  codes: readonly string[];
}

/**
 * Every security feature, the group that raises it and the setting that
 * turns it on alone. The reference page's table is printed from this list
 * (`securityFeatureTable`), and a test compares the two.
 */
export const SECURITY_FEATURES: readonly SecurityFeature[] = [
  { feature: "Publish refuses an unsigned release", byDefault: "off: publishes and records `signature: unsigned`", setting: "`identity.gates.release`", group: "verified-releases", codes: ["security-signers-missing", "security-publish-allows-unsigned"] },
  { feature: "Signed cut in the release gate's class", byDefault: "off", setting: "`identity.gates.release` with a `class`", group: "verified-releases", codes: ["security-release-gate-missing"] },
  { feature: "Promote verifies the release", byDefault: "off: `chant release verify` on demand", setting: "`chant release verify`", group: "verified-releases", codes: [] },
  { feature: "SBOM on every target", byDefault: "off: a target with no SBOM source publishes without one", setting: "`sbom` on the target", group: "supply-chain", codes: ["security-sbom-disabled", "security-sbom-unsourced"] },
  { feature: "OIDC provenance", byDefault: "off: a plan field", setting: "`--require-provenance`", group: "supply-chain", codes: ["security-publish-no-provenance"] },
  { feature: "SBOM and verify steps on components", byDefault: "off", setting: "a `generate-sbom` or `verify` step", group: "supply-chain", codes: ["security-component-no-sbom", "security-component-no-verify"] },
  { feature: "Signed green tags and runs", byDefault: "off: every tag counts", setting: "`ci.green.signedSince`", group: "who-ran-it", codes: ["security-signed-since-unset"] },
  { feature: "Trusted runner keys", byDefault: "off", setting: "`.chant/trust.json` with a runner role", group: "who-ran-it", codes: ["security-runner-untrusted"] },
  { feature: "Tick signs its tags", byDefault: "off: unsigned tags", setting: "`--key` or `CHANT_RUNNER_KEY`", group: "who-ran-it", codes: ["security-tick-no-key"] },
  { feature: "Forge review required, authors never count", byDefault: "off", setting: "`--require-review`, `requireReview: true`", group: "review-rules", codes: ["security-review-not-required"] },
  { feature: "Identified attribution", byDefault: "off: `any`", setting: "`identity.attribution: \"identified\"`", group: "review-rules", codes: ["security-attribution-any"] },
  { feature: "Signed approvals", byDefault: "off", setting: "`identity.gates.<gate>`", group: "review-rules", codes: ["security-gate-unsigned"] },
  { feature: "Apply jobs require a runner-start statement", byDefault: "off", setting: "`--require-runner-start`", group: "isolated-runners", codes: ["security-runner-start-no-key", "security-runner-start-no-role", "security-trust-unreadable"] },
  { feature: "Secrets file", byDefault: "off", setting: "`--secrets`", group: null, codes: [] },
  { feature: "Env allowlist and log redaction", byDefault: "on: `ci run`'s contract, a listed exception", setting: "`--pass-env`", group: null, codes: [] },
];

/** The reference page's table of {@link SECURITY_FEATURES}, as markdown. */
export function securityFeatureTable(): string {
  const rows = SECURITY_FEATURES.map((f) => `| ${f.feature} | ${f.byDefault} | ${f.setting} | ${f.group ? `\`${f.group}\`` : "none"} | ${f.codes.map((c) => `\`${c}\``).join(", ") || "none"} |`);
  return ["| Feature | Default | Turns it on alone | Group | Checked as |", "|---|---|---|---|---|", ...rows].join("\n");
}
