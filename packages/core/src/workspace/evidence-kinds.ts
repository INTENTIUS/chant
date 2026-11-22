/**
 * The kinds of record `chant release evidence` (#5465) writes, and what each
 * shows. A row of `SECURITY_CONTROLS` (./security-controls.ts) names the
 * kinds that bear on its control in `records`, so the export's index joins
 * files to control ids through that one table.
 *
 * A file can hold several kinds: `_releases/publishes.jsonl` holds publish
 * lines, scan lines, the crypto module and the runner key. The index lists
 * each kind a file holds with the line numbers that carry it.
 */

/** Every kind of record the export writes, in the order the index lists them. */
export const EVIDENCE_KINDS = [
  "release",
  "cut",
  "publish",
  "scan",
  "rescan",
  "crypto",
  "runner-key",
  "signature-record",
  "sbom-record",
  "deploy",
  "merge",
  "change-set",
  "gate",
  "sealed-approval",
  "override",
  "run",
  "trust",
  "signers",
  "declaration",
  "verify",
  "sigstore-verify",
  "referrer-sbom",
  "referrer-scan",
  "referrer-attestation",
  "referrer-signature",
  "forge-asset",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** What a record of each kind shows, in a sentence the index repeats beside the file. */
export const EVIDENCE_KIND_SHOWS: Readonly<Record<EvidenceKind, string>> = {
  release: "The release file: the commit it was cut from and the content digest of every artifact and template it holds, which hashes to the release digest.",
  cut: "A cut line: who cut the release and when, the green gate or override it passed, the CI run, and the cut's ssh signature when it was signed.",
  publish: "A publish line: each target staged or revealed, with its destinations and digests and the run it ran in.",
  scan: "A scan line made by the publish (scanned or scan-failed): the scanner, its database's version and build time, and every finding with what the policy made of it.",
  rescan: "A rescanned line (chant release scan): a scan of the published release made later, with the scanner, its database, the findings, and what was not scanned.",
  crypto: "The crypto module the publish ran on: Node and OpenSSL versions, whether FIPS mode was on, and the cosign build named. What it reports, not a validation.",
  "runner-key": "The ssh fingerprint of the runner key of the chant ci serve host that ran the publish.",
  "signature-record": "The Sigstore signatures and attestations the publish made: what each signs, by digest, and the identity or key to check it against.",
  "sbom-record": "The SBOMs the publish attached, by name and digest.",
  deploy: "A deploy line of an environment's releases.jsonl: the component, the digest deployed, the commit, the run and who started it, and the release it came from.",
  merge: "A merge record: the merged commit, where the change came from, the change-set digest planned on it, and whether an approval stood for that digest.",
  "change-set": "A change set: the plan reviewed before apply, stored under its digest.",
  gate: "A gate ledger: pending facts, approvals, rejections and applies of one op's gates, with who resolved each and when.",
  "sealed-approval": "An approval line carrying a seal (chant approve --sign or a passkey), which verifies against the signers at base.",
  override: "A policy override line: a denial, an override a person recorded, or an override spent by a run.",
  run: "An Op run line: the phases and steps that ran, their outcomes, the commit and the CI run.",
  trust: ".chant/trust.json at a commit: roles, runner keys, passkeys and ref rules as they stood then.",
  signers: "The signers file at a commit: the ssh keys whose signatures on cuts and approvals count.",
  declaration: "chant.workspace.json at a commit: the security groups and profiles, retention and identity gates as they stood then.",
  verify: "chant release verify --json at export time: whether the release file hashes to its digest and a cut's signature verifies against the signers at its commit.",
  "sigstore-verify": "chant release verify --sigstore at export time: each Sigstore signature and attestation the publish recorded, checked with cosign.",
  "referrer-sbom": "An image's SBOM referrer, fetched from its registry by the digest the publish recorded.",
  "referrer-scan": "An image's scan.json referrer: the findings of the scan before the stage, attached to the image.",
  "referrer-attestation": "An image's attestation referrer, such as the SLSA statement naming the builder and base images, or the signed SBOM or vulnerability attestation.",
  "referrer-signature": "An image's signature referrer.",
  "forge-asset": "A forge release asset the publish record names (a Sigstore bundle, an SBOM or the provenance statement), copied from the directory --assets names after its digest matched.",
};

/** Where a record of each kind sits in an export, for the docs' table. */
export const EVIDENCE_KIND_WHERE: Readonly<Record<EvidenceKind, string>> = {
  release: "`lifecycle/_releases/<digest>.json`",
  cut: "lines of `lifecycle/_releases/cuts.jsonl`",
  publish: "staged and revealed lines of `lifecycle/_releases/publishes.jsonl`",
  scan: "`scanned` and `scan-failed` lines of `lifecycle/_releases/publishes.jsonl`",
  rescan: "`rescanned` lines of `lifecycle/_releases/publishes.jsonl`",
  crypto: "the `crypto` of a publish line",
  "runner-key": "the `runnerKey` of a publish line",
  "signature-record": "the signature and attestation items of a publish line",
  "sbom-record": "the SBOM items of a publish line",
  deploy: "lines of `lifecycle/<env>/releases.jsonl`",
  merge: "`lifecycle/_merges/<commit>.json`",
  "change-set": "`lifecycle/_change-sets/<digest>.json`",
  gate: "lines of `lifecycle/_gates/<op>.jsonl`",
  "sealed-approval": "sealed approval lines of `lifecycle/_gates/<op>.jsonl`",
  override: "lines of `lifecycle/_gates/policy-override.jsonl` and `policy-override/applied.jsonl`",
  run: "lines of `lifecycle/<env>/runs__<op>.jsonl`",
  trust: "`commits/<sha>/.chant/trust.json`",
  signers: "the signers file `.chant/trust.json` names, under `commits/<sha>/`",
  declaration: "`commits/<sha>/chant.workspace.json`",
  verify: "`verify/<digest>.json`",
  "sigstore-verify": "`verify/<digest>.sigstore.json`",
  "referrer-sbom": "`referrers/`, an SBOM referrer",
  "referrer-scan": "`referrers/`, the `scan.json` referrer",
  "referrer-attestation": "`referrers/`, an attestation or provenance referrer",
  "referrer-signature": "`referrers/`, a signature referrer",
  "forge-asset": "`assets/<digest>/<name>`",
};
