/**
 * The controls chant's records produce evidence toward, for the two security
 * profiles (#5464), from the control mapping on #5447.
 *
 * Each row is one control or enhancement as the mapping cites it, with
 * whether each profile's baseline selects it. `fedramp-moderate` is the
 * FedRAMP Rev. 5 Moderate baseline, whose ids are NIST SP 800-53 Rev. 5.
 * `cccs-medium` is the CCCS Medium cloud profile (ITSP.50.103 Annex B), whose
 * ids are ITSG-33 Annex 3A and follow 800-53 Rev. 4: it has no SR family and
 * no CM-14, and some titles differ.
 *
 * A row says which records an assessor could read for the control and what
 * they don't show. It never says a control is met: the system owner
 * implements a control, and an assessor decides whether it is. The profile
 * checks (./security-profiles.ts) and the release evidence export index by
 * {@link SECURITY_CONTROLS}' `id`.
 */

import type { SecurityProfile } from "./security-profiles";

/** Whether a baseline selects a control: `selected`, `not-selected`, or `not-in-catalogue` when the id does not exist in the catalogue the baseline uses. */
export type BaselineMark = "selected" | "not-selected" | "not-in-catalogue";

/** One control of the mapping. */
export interface SecurityControl {
  /** The id as the mapping cites it, such as `RA-5(2)`. */
  id: string;
  /** The SP 800-53 Rev. 5 title. */
  title: string;
  /** The ITSG-33 title, where it differs from {@link title}. */
  cccsTitle?: string;
  /** Whether each profile's baseline selects the control. */
  baselines: Readonly<Record<SecurityProfile, BaselineMark>>;
  /** FedRAMP's parameter or requirement for it, as the mapping quotes it, where the mapping quotes one. */
  fedrampParameter?: string;
  /** The records, files and commands that produce evidence for it. */
  evidence: readonly string[];
  /** What that evidence does not show, in a sentence. */
  notShown: string;
  /** The `chant workspace check` codes and publish refusal codes whose findings bear on it. */
  codes: readonly string[];
  /** The `chant doctor` and `chant release doctor` checks that bear on it. */
  doctor: readonly string[];
}

const both = { "fedramp-moderate": "selected", "cccs-medium": "selected" } as const;
const fedrampOnly = { "fedramp-moderate": "selected", "cccs-medium": "not-selected" } as const;
const cccsOnly = { "fedramp-moderate": "not-selected", "cccs-medium": "selected" } as const;
const noSrFamily = { "fedramp-moderate": "selected", "cccs-medium": "not-in-catalogue" } as const;

/** The 36 controls and enhancements of the #5447 mapping, in its order. */
export const SECURITY_CONTROLS: readonly SecurityControl[] = [
  {
    id: "AC-5",
    title: "Separation of Duties",
    baselines: both,
    evidence: ["`ci.identity.cloud`", "`_gates/<op>.jsonl`", "`identity.gates.<gate>` with a `class`", "`.chant/trust.json`"],
    notShown: "The organisation's duty matrix; chant does not stop one person holding both the merge and the apply role on the forge.",
    codes: ["profile-gate-not-human", "security-review-not-required"],
    doctor: [],
  },
  {
    id: "AC-6",
    title: "Least Privilege",
    baselines: both,
    evidence: ["the plan job holds no forge token", "`chant ci run --pass-env`", "`--secrets`", "`release.signing.kms` credentials reach the publish step only"],
    notShown: "The privileges of the cloud roles themselves, which live in the cloud's IAM.",
    codes: [],
    doctor: [],
  },
  {
    id: "AU-2",
    title: "Event Logging",
    baselines: both,
    evidence: ["`_merges/<commit>.json`", "`_change-sets/<digest>.json`", "`_gates/<op>.jsonl`", "`_releases/cuts.jsonl`", "`_releases/publishes.jsonl`", "`<env>/releases.jsonl`", "`<env>/runs__<op>.jsonl`"],
    notShown: "Logon, account and system events, which come from the forge, the cloud and the hosts.",
    codes: [],
    doctor: [],
  },
  {
    id: "AU-3",
    title: "Content of Audit Records",
    baselines: both,
    evidence: ["the actor, time, commit or digest and outcome on each `chant/lifecycle` line", "the plan digest on each approval", "targets, destinations and digests on `_releases/publishes.jsonl`"],
    notShown: "AU-3(1) content such as session duration and bytes sent.",
    codes: [],
    doctor: [],
  },
  {
    id: "AU-6",
    title: "Audit Record Review",
    baselines: both,
    evidence: ["the gate audit over `_gates/*.jsonl`", "the unrecorded writer audit", "drift attribution"],
    notShown: "That a review happened on a schedule; chant produces the report and does not schedule or record the review. The unrecorded writer audit reads AWS only.",
    codes: [],
    doctor: [],
  },
  {
    id: "AU-9",
    title: "Protection of Audit Information",
    baselines: both,
    evidence: ["append-only ledgers on `chant/lifecycle`", "ssh-signed cuts", "sealed approvals (`chant approve --sign`)", "DSSE-signed runner evidence", "the `pre-receive` hook of `chant workspace ref-gate install`"],
    notShown: "Forge settings the token can't read. Publish and deploy lines are not signed.",
    codes: [],
    doctor: ["lifecycle-protected"],
  },
  {
    id: "AU-11",
    title: "Audit Record Retention",
    baselines: both,
    fedrampParameter: "a time period in compliance with M-21-31, and on-line for at least 90 days",
    evidence: ["`retention` in `chant.workspace.json`", "`chant lifecycle gc`", "git history of `chant/lifecycle`"],
    notShown: "Run events, which are local to one clone, and off-line preservation, which is the organisation's.",
    codes: ["profile-retention-short"],
    doctor: [],
  },
  {
    id: "AU-12",
    title: "Audit Record Generation",
    baselines: both,
    evidence: ["`chant components pr-record`", "`chant approve`", "`chant release cut`", "`chant release publish`", "`chant components promote`", "`chant ci run`"],
    notShown: "Generation on components chant does not run.",
    codes: [],
    doctor: [],
  },
  {
    id: "CA-7",
    title: "Continuous Monitoring",
    baselines: both,
    evidence: ["`chant lifecycle diff --live`", "drift reads"],
    notShown: "Ongoing vulnerability monitoring of what already shipped: the release scan runs once, before the stage.",
    codes: [],
    doctor: [],
  },
  {
    id: "CM-2",
    title: "Baseline Configuration",
    baselines: both,
    evidence: ["the declared source at a commit", "`_releases/<digest>.json`"],
    notShown: "The annual review and review on a significant change.",
    codes: [],
    doctor: [],
  },
  {
    id: "CM-2(2)",
    title: "Automation Support for Accuracy and Currency",
    baselines: both,
    evidence: ["drift reads and snapshots", "`chant release images --repin`"],
    notShown: "Anything outside the declared estate.",
    codes: [],
    doctor: [],
  },
  {
    id: "CM-3",
    title: "Configuration Change Control",
    baselines: both,
    evidence: ["`_change-sets/<digest>.json`", "`_gates/<op>.jsonl`", "`_merges/<commit>.json`", "`chant workspace ref-gate install` and `status`"],
    notShown: "A central means of communicating major changes to service consumers.",
    codes: [],
    doctor: [],
  },
  {
    id: "CM-3(2)",
    title: "Testing, Validation, and Documentation of Changes",
    baselines: fedrampOnly,
    evidence: ["`release.green`", "the signed gate record of a verified cut"],
    notShown: "What the tests cover.",
    codes: [],
    doctor: [],
  },
  {
    id: "CM-3(4)",
    title: "Security and Privacy Representatives",
    baselines: both,
    evidence: ["`identity.gates.<gate>` with a `class`", "sealed approvals on `_gates/<op>.jsonl`"],
    notShown: "Who the organisation names as its representatives, and that the class is held by them.",
    codes: ["profile-gate-not-human", "security-release-gate-missing"],
    doctor: [],
  },
  {
    id: "CM-3(6)",
    title: "Cryptography Management",
    baselines: cccsOnly,
    evidence: ["`release.signing` in `chant.config.ts`"],
    notShown: "Key lifecycle in the KMS or for cosign key files.",
    codes: [],
    doctor: [],
  },
  {
    id: "CM-4",
    title: "Impact Analyses",
    baselines: both,
    evidence: ["the plan and its change set"],
    notShown: "Security impact analysis as a human activity.",
    codes: [],
    doctor: [],
  },
  {
    id: "CM-5",
    title: "Access Restrictions for Change",
    baselines: both,
    evidence: ["runner-start statements (`chant ci runner-start verify`, `--require-runner-start`)", "the ref gate's refusals"],
    notShown: "Forge and cloud permissions.",
    codes: ["security-runner-start-no-key", "security-runner-start-no-role", "security-trust-unreadable"],
    doctor: [],
  },
  {
    id: "CM-5(1)",
    title: "Automated Access Enforcement and Audit Records",
    baselines: both,
    evidence: ["the ref gate's refusals", "`_gates/policy-override.jsonl`", "`_gates/policy-override/applied.jsonl`"],
    notShown: "Enforcement outside the ref gate.",
    codes: [],
    doctor: [],
  },
  {
    id: "CM-6",
    title: "Configuration Settings",
    baselines: both,
    evidence: ["lint and post-synth checks on every build", "`chant audit`", "DKRD021"],
    notShown: "DoD STIG or CIS Level 2 settings for cloud resources.",
    codes: ["security-image-base-unpinned"],
    doctor: [],
  },
  {
    id: "CM-8",
    title: "System Component Inventory",
    baselines: both,
    fedrampParameter: "at least monthly",
    evidence: ["the SBOM of each release target", "the image SBOM made from its layers", "`chant workspace state`"],
    notShown: "A monthly review, and components no release builds.",
    codes: ["security-sbom-disabled", "security-sbom-unsourced"],
    doctor: [],
  },
  {
    id: "IA-2",
    title: "Identification and Authentication",
    baselines: both,
    evidence: ["the identity form on each record (`signer`, `forge`, `role`, `name`)", "`identity.attribution: \"identified\"`"],
    notShown: "Authentication itself, which the forge, IdP or passkey platform does; chant records attribution only.",
    codes: ["security-attribution-any"],
    doctor: [],
  },
  {
    id: "RA-5",
    title: "Vulnerability Monitoring and Scanning",
    cccsTitle: "Vulnerability Scanning",
    baselines: both,
    fedrampParameter: "monthly; high within 30 days; a KEV date supersedes",
    evidence: ["`scanned` and `scan-failed` lines on `_releases/publishes.jsonl`", "the `scan.json` referrer", "`vulnPolicy`", "`vuln-gate` steps"],
    notShown: "Scanning on a schedule after release, and remediation tracking (POA&M).",
    codes: ["profile-scan-off"],
    doctor: ["scan-tool"],
  },
  {
    id: "RA-5(2)",
    title: "Update Vulnerabilities to Be Scanned",
    baselines: both,
    fedrampParameter: "within 24 hours prior to running scans",
    evidence: ["the database version and build time on each scan record"],
    notShown: "Updates between scans; the record shows the database each scan read.",
    codes: ["profile-scan-db-unbounded", "publish-scan-db-stale"],
    doctor: [],
  },
  {
    id: "RA-5(3)",
    title: "Breadth and Depth of Coverage",
    baselines: both,
    evidence: ["layer SBOMs listing OS packages"],
    notShown: "Coverage of running hosts, databases and web applications.",
    codes: [],
    doctor: [],
  },
  {
    id: "SA-10",
    title: "Developer Configuration Management",
    baselines: both,
    evidence: ["`_releases/<digest>.json`", "`_change-sets/<digest>.json`", "`_merges/<commit>.json`", "`ci/revoked/<sha>` tags"],
    notShown: "Flaw tracking reported to FedRAMP.",
    codes: [],
    doctor: [],
  },
  {
    id: "SA-10(1)",
    title: "Software and Firmware Integrity Verification",
    baselines: cccsOnly,
    evidence: ["`chant release verify <label>`", "`chant release verify --sigstore`", "`chant components promote --release`"],
    notShown: "Verification of what chant did not release.",
    codes: ["profile-signing-off"],
    doctor: [],
  },
  {
    id: "SA-11",
    title: "Developer Testing and Evaluation",
    cccsTitle: "Developer Security Testing",
    baselines: both,
    evidence: ["the green gate", "check jobs and their reports"],
    notShown: "The assessment plan.",
    codes: [],
    doctor: [],
  },
  {
    id: "SA-11(1)",
    title: "Static Code Analysis",
    baselines: both,
    evidence: ["SARIF from the `sonar`, `mend` and `wiz` presets of `ci.hooks.check` in the check report"],
    notShown: "That a preset is configured; nothing requires one.",
    codes: [],
    doctor: [],
  },
  {
    id: "SA-15",
    title: "Development Process, Standards, and Tools",
    baselines: both,
    evidence: ["tools pinned by SHA-256 (`tool-pins.ts`)", "actions pinned by commit (`action-pins.ts`)", "images pinned by digest (`image-pins.ts`)"],
    notShown: "The documented process.",
    codes: [],
    doctor: [],
  },
  {
    id: "SC-12",
    title: "Cryptographic Key Establishment and Management",
    baselines: both,
    evidence: ["`.chant/allowed_signers`", "runner keys and passkeys in `.chant/trust.json`", "`release.signing.kms` or `key`"],
    notShown: "Key generation and storage, which are the KMS's or the key holder's.",
    codes: [],
    doctor: [],
  },
  {
    id: "SC-13",
    title: "Cryptographic Protection",
    baselines: both,
    fedrampParameter: "FIPS-validated or NSA-approved cryptography",
    evidence: ["`crypto` on `_releases/publishes.jsonl` lines", "the runner key types in `.chant/trust.json`", "the `release.signing` mode"],
    notShown: "That a module is validated; that is in the module's certificate and security policy.",
    codes: ["profile-signing-module", "profile-runner-key-eddsa"],
    doctor: ["crypto-module", "signing-cosign-build"],
  },
  {
    id: "SI-2",
    title: "Flaw Remediation",
    baselines: both,
    fedrampParameter: "updates within 30 days",
    evidence: ["`vulnPolicy` at publish", "`chant release images --repin`"],
    notShown: "That a deployed release was rebuilt within 30 days of a fix.",
    codes: [],
    doctor: [],
  },
  {
    id: "SI-7",
    title: "Software, Firmware, and Information Integrity",
    baselines: both,
    evidence: ["content digests on every release and record", "digest-pinned bases", "Sigstore signatures and SLSA statements", "`chant release verify`"],
    notShown: "Integrity of what chant did not build or release.",
    codes: ["profile-signing-off"],
    doctor: [],
  },
  {
    id: "SI-7(1)",
    title: "Integrity Checks",
    baselines: both,
    fedrampParameter: "at least monthly",
    evidence: ["`chant release verify --sigstore`"],
    notShown: "A scheduled check; nothing runs it monthly or records that it ran.",
    codes: [],
    doctor: [],
  },
  {
    id: "SR-3",
    title: "Supply Chain Controls and Processes",
    baselines: noSrFamily,
    evidence: ["bases pinned by digest", "pull login for private base registries", "Chainguard bases for CI product images", "SLSA provenance naming the builder"],
    notShown: "FedRAMP's custody requirement for devices.",
    codes: ["security-image-base-unpinned"],
    doctor: [],
  },
  {
    id: "SR-11",
    title: "Component Authenticity",
    baselines: noSrFamily,
    fedrampParameter: "vendors provide authenticity of software",
    evidence: ["bases by digest", "Sigstore signatures in keyless, `kms` or `key` mode"],
    notShown: "A base image vendor's signature; chant does not check one before it builds.",
    codes: ["profile-signing-off"],
    doctor: [],
  },
];

/**
 * Controls often named for pipelines that the #5447 mapping found in neither
 * baseline. They are listed so a system that tailors one in can find chant's
 * evidence for it; neither profile reports anything toward them.
 */
export const CONTROLS_OUTSIDE_BOTH_BASELINES: readonly { id: string; title: string; note: string }[] = [
  { id: "AU-10", title: "Non-repudiation", note: "High only in NIST; not in FedRAMP Moderate or CCCS Medium. Signed cuts and sealed approvals bear on it where a system selects it." },
  { id: "CM-14", title: "Signed Components", note: "In no NIST baseline, and not in the ITSG-33 catalogue." },
  { id: "SR-4", title: "Provenance", note: "In no NIST baseline. The SLSA statements bear on it where a system tailors it in." },
  { id: "SI-7(15)", title: "Code Authentication", note: "High only." },
  { id: "SA-12", title: "Supply Chain Protection", note: "In the ITSG-33 catalogue but not selected in the CCCS Medium cloud profile." },
];

/** The row for `id`, or undefined. */
export function securityControl(id: string): SecurityControl | undefined {
  return SECURITY_CONTROLS.find((c) => c.id === id);
}

/** The controls `profile`'s baseline selects. */
export function controlsOf(profile: SecurityProfile): SecurityControl[] {
  return SECURITY_CONTROLS.filter((c) => c.baselines[profile] === "selected");
}

/** The ids among `ids` that `profile`'s baseline selects, in table order. */
export function selectedIds(profile: SecurityProfile, ids: readonly string[]): string[] {
  return SECURITY_CONTROLS.filter((c) => ids.includes(c.id) && c.baselines[profile] === "selected").map((c) => c.id);
}
