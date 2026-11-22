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
 *   `chant release cut` refuses `release.green: "none"` (#5149).
 * - `supply-chain`: a publish without OIDC provenance warns, a target
 *   with no SBOM source is refused (`publish-sbom-missing`), the OCI and
 *   forge targets sign with Sigstore (`release.signing`, #5164), a publish
 *   scans what it puts out before anything is pushed (`release.scan`,
 *   #5446), a Dockerfile `release.images` names is checked for a `FROM`
 *   not pinned by digest (#5457), and `chant release cut` refuses
 *   `release.green: "none"` (#5149).
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
 * A security profile (`fedramp-moderate`, `cccs-medium`, #5464,
 * ./security-profiles.ts) in the top-level list turns on every group and
 * adds checks of its own; {@link securityGroupsOf} expands it, so a reader
 * that asks for a group needs to know nothing of profiles.
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
import { groupsOfEntry, SECURITY_PROFILES, type SecurityProfile } from "./security-profiles";

export const SECURITY_GROUPS = ["verified-releases", "supply-chain", "who-ran-it", "review-rules", "isolated-runners"] as const;

export type SecurityGroup = (typeof SECURITY_GROUPS)[number];

/** What the declaration's top-level `security` may name: a group, or a profile (#5464) that turns groups on. A member's own list names groups only. */
export type SecurityEntry = SecurityGroup | SecurityProfile;

/**
 * The groups `declaration` turns on for `member` (a member name): the
 * top-level list plus that member's own. Empty for no declaration or no
 * `security` key anywhere.
 */
export function securityGroupsOf(declaration: Pick<Declaration, "security" | "members"> | null | undefined, member: string | null = null): ReadonlySet<SecurityGroup> {
  const own = member === null ? [] : (declaration?.members?.find((m) => m.name === member)?.security ?? []);
  // #5464: a profile turns on its groups.
  return new Set([...(declaration?.security ?? []), ...own].flatMap((e) => groupsOfEntry(e)));
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
  /** The security profiles that turn it on (#5464) when it has no group: a profile turns on every group, so a feature with a group is on under each profile too. */
  profiles?: readonly SecurityProfile[];
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
  // #5149: a cut with no green gate.
  { feature: "Cut refuses `release.green: \"none\"`", byDefault: "off: cuts with a warning and records `green: none`", setting: "`identity.gates.release`", group: "verified-releases", codes: [] },
  // #5469: the audit branch can't be rewritten or deleted.
  { feature: "Remote refuses a rewrite or deletion of `chant/lifecycle`", byDefault: "off: chant's own pushes are client-checked and a plain force push is not stopped", setting: "the `pre-receive` hook of `chant workspace ref-gate install`, or branch protection on the forge, which `chant release doctor` reads", group: "verified-releases", codes: [] },
  { feature: "SBOM on every target", byDefault: "off: a target with no SBOM source publishes without one", setting: "`sbom` on the target", group: "supply-chain", codes: ["security-sbom-disabled", "security-sbom-unsourced"] },
  { feature: "OIDC provenance", byDefault: "off: a plan field", setting: "`--require-provenance`", group: "supply-chain", codes: ["security-publish-no-provenance"] },
  { feature: "Cut needs a green gate", byDefault: "off: `release.green: \"none\"` cuts with a warning", setting: "`release.green` other than `none`", group: "supply-chain", codes: [] },
  { feature: "Sigstore signatures and SLSA provenance on images and forge assets, keylessly or with a key", byDefault: "off: nothing is signed", setting: "`release.signing` (`kms` for a KMS key, `key` for a cosign key, `fulcio`, `rekor` and `trustRoot` for a private Sigstore instance)", group: "supply-chain", codes: [] },
  // #5446: images and attached SBOMs scanned before the stage, with the vulnPolicy gate.
  { feature: "Vulnerability scan at the cut, before anything is tagged, and again before anything is pushed", byDefault: "off: a cut tags and a publish pushes without scanning", setting: "`release.scan`", group: "supply-chain", codes: [] },
  // #5467: promote checks what the publish recorded.
  { feature: "Promote checks the image signatures and the scan record", byDefault: "off: promote deploys a release whatever its publish recorded", setting: "none: the group turns it on", group: "supply-chain", codes: [] },
  // #5457: release.images Dockerfiles start from bases pinned by digest.
  { feature: "Release image bases pinned by digest", byDefault: "off: a `FROM` by tag builds from whatever the tag names that day", setting: "pin each `FROM` as `name:tag@sha256:<digest>`", group: "supply-chain", codes: ["security-image-base-unpinned"] },
  { feature: "SBOM and verify steps on components", byDefault: "off", setting: "a `generate-sbom` or `verify` step", group: "supply-chain", codes: ["security-component-no-sbom", "security-component-no-verify"] },
  { feature: "Signed green tags and runs", byDefault: "off: every tag counts", setting: "`ci.green.signedSince`", group: "who-ran-it", codes: ["security-signed-since-unset"] },
  { feature: "Trusted runner keys", byDefault: "off", setting: "`.chant/trust.json` with a runner role", group: "who-ran-it", codes: ["security-runner-untrusted"] },
  { feature: "Tick signs its tags", byDefault: "off: unsigned tags", setting: "`--key` or `CHANT_RUNNER_KEY`", group: "who-ran-it", codes: ["security-tick-no-key"] },
  { feature: "Forge review required, authors never count", byDefault: "off", setting: "`--require-review`, `requireReview: true`", group: "review-rules", codes: ["security-review-not-required"] },
  { feature: "Identified attribution", byDefault: "off: `any`", setting: "`identity.attribution: \"identified\"`", group: "review-rules", codes: ["security-attribution-any"] },
  { feature: "Signed approvals", byDefault: "off", setting: "`identity.gates.<gate>`", group: "review-rules", codes: ["security-gate-unsigned"] },
  { feature: "Apply jobs require a runner-start statement", byDefault: "off", setting: "`--require-runner-start`", group: "isolated-runners", codes: ["security-runner-start-no-key", "security-runner-start-no-role", "security-trust-unreadable"] },
  // #5464: what a security profile adds beyond the groups.
  { feature: "`chant lifecycle gc` keeps change sets and releases for at least the profile's days", byDefault: "off: `retention` may be any number of days", setting: "`retention` in `chant.workspace.json`", group: null, codes: ["profile-retention-short"], profiles: SECURITY_PROFILES },
  { feature: "Release and apply gates take approvals from people", byDefault: "off: a gate may name any class or none", setting: "`identity.gates.<gate>` with `class: \"human\"`", group: null, codes: ["profile-gate-not-human"], profiles: SECURITY_PROFILES },
  { feature: "Cut and publish refuse a scanner database older than a bound", byDefault: "off: the scan reads whatever database it has", setting: "`release.scan.dbMaxAgeHours`", group: null, codes: ["profile-scan-off", "profile-scan-db-unbounded"], profiles: SECURITY_PROFILES },
  { feature: "Signatures made in a crypto module the team names", byDefault: "off: the upstream cosign build signs", setting: "`release.signing.kms`, or `CHANT_COSIGN` in the release config", group: null, codes: ["profile-signing-off", "profile-signing-module"], profiles: SECURITY_PROFILES },
  { feature: "ECDSA P-256 runner keys", byDefault: "off: Ed25519 and P-256 keys are both taken", setting: "`chant ci serve --setup-key --key-type ecdsa-p256`", group: null, codes: ["profile-runner-key-eddsa"], profiles: SECURITY_PROFILES },
  { feature: "Secrets file", byDefault: "off", setting: "`--secrets`", group: null, codes: [] },
  { feature: "Env allowlist and log redaction", byDefault: "on: `ci run`'s contract, a listed exception", setting: "`--pass-env`", group: null, codes: [] },
  // #4295: the plan job's steps never hold a forge token; the plan-note job posts. Part of the generated pipeline, so nothing turns it on.
  { feature: "Plan steps hold no forge token", byDefault: "on: the plan job's contract, a listed exception", setting: "regenerate the pipeline", group: null, codes: [] },
  // #4296: the plan job trades its OIDC token for the plan identity before the checkout, and the apply jobs take the apply identity.
  { feature: "Separate plan and apply cloud identities", byDefault: "off: no job requests an OIDC token", setting: "`ci.identity.cloud`", group: null, codes: [] },
];

/** The reference page's table of {@link SECURITY_FEATURES}, as markdown. */
export function securityFeatureTable(): string {
  const rows = SECURITY_FEATURES.map((f) => {
    const on = f.group ? `\`${f.group}\`` : f.profiles?.length ? f.profiles.map((p) => `\`${p}\``).join(", ") : "none";
    return `| ${f.feature} | ${f.byDefault} | ${f.setting} | ${on} | ${f.codes.map((c) => `\`${c}\``).join(", ") || "none"} |`;
  });
  return ["| Feature | Default | Turns it on alone | Group or profile | Checked as |", "|---|---|---|---|---|", ...rows].join("\n");
}
