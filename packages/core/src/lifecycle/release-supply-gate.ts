/**
 * What `chant components promote --release` checks under the `supply-chain`
 * group before it deploys a release (#5467), beside the revocation and
 * `verified-releases` checks `resolveUnderRelease` already makes:
 *
 * - Sigstore signatures: when the publish signs (`release.signing`, or the
 *   group) and `release.publish` declares an `oci` or `forge` target, the
 *   record must hold a signature, and every bundle of an `oci` target must
 *   verify, as `chant release verify --sigstore` checks it. A forge release's
 *   bundles sit beside files promote does not read, so they stay with
 *   `release verify --sigstore --assets`. The refusals are the codes that
 *   command exits with: `release-sigstore-unsigned` and
 *   `release-sigstore-unverified`.
 * - the scan record: when the publish scans (`release.scan`, or the group)
 *   and an `oci`, `forge` or `npm` target is declared, the publish record
 *   must hold a `scanned` line for the release. A `scan-failed` line alone,
 *   or none, refuses with `release-scan-missing`.
 *
 * There is no flag to skip it: a team that wants it off leaves `supply-chain`
 * off. A train's promote runs `components promote` in each member, so it
 * reaches every member's release through the same check.
 */

import type { SecurityGroup } from "../workspace/security";
import type { SigstoreVerifier } from "./publish-signing";
import type { PublishRecord } from "./publish-record";

/** Why promote refuses a release under `supply-chain`, in the words of the check that failed. */
export interface SupplyGateRefusal {
  code: "release-sigstore-unsigned" | "release-sigstore-unverified" | "release-scan-missing";
  message: string;
  /** The check to run by hand. */
  hint: string;
}

const SIGNED_KINDS = new Set(["oci", "forge"]);
const SCANNED_KINDS = new Set(["oci", "forge", "npm"]);

/**
 * The scan record of a release: whether its publish record holds a passing
 * scan. A `scanned` line is one the publish wrote after the policy let every
 * finding through; `scan-failed` is the line of a publish the policy stopped.
 */
export function scanRecorded(records: readonly Pick<PublishRecord, "kind" | "step">[]): "passed" | "failed-only" | "none" {
  const lines = records.filter((r) => r.kind === "scan");
  if (lines.some((r) => r.step === "scanned")) return "passed";
  return lines.some((r) => r.step === "scan-failed") ? "failed-only" : "none";
}

/**
 * Check the release `releaseDigest` of the member at `cwd` for a deploy.
 * Null when it may be deployed, else the first refusal. `verifier` replaces
 * cosign, as a test's fake does.
 */
export async function supplyChainGate(req: {
  cwd: string;
  releaseDigest: string;
  label: string | null;
  groups: ReadonlySet<SecurityGroup>;
  verifier?: SigstoreVerifier;
  env?: NodeJS.ProcessEnv;
}): Promise<SupplyGateRefusal | null> {
  if (!req.groups.has("supply-chain")) return null;
  const { loadChantConfig } = await import("../config");
  const { resolveSigning } = await import("./publish-signing");
  const { resolveScan } = await import("./publish-scan");
  const { recordedSignatures, verifySigstore } = await import("./release-verify");
  const { readPublishRecords } = await import("./publish-record");
  const release = (await loadChantConfig(req.cwd).catch(() => null))?.config.release;
  const kinds = new Set((release?.publish ?? []).map((t) => t.type as string));
  const name = req.label ?? req.releaseDigest;

  const signing = resolveSigning(release?.signing, req.groups);
  if (signing.on && [...kinds].some((k) => SIGNED_KINDS.has(k))) {
    const recorded = await recordedSignatures(req.cwd, req.releaseDigest);
    if (recorded.length === 0) {
      return {
        code: "release-sigstore-unsigned",
        message: `release ${name}'s publish recorded no Sigstore signature, and the workspace opts into supply-chain with release.signing on, so promote deploys only a signed release`,
        hint: `Check it with: chant release verify ${name} --sigstore. Publish it from CI with release.signing on.`,
      };
    }
    if (recorded.some((r) => r.kind === "oci")) {
      const sigstore = await verifySigstore({ cwd: req.cwd, releaseDigest: req.releaseDigest, kinds: ["oci"], ...(req.verifier ? { verifier: req.verifier } : {}), ...(req.env ? { env: req.env } : {}) });
      if (sigstore.status !== "verified") {
        return {
          code: "release-sigstore-unverified",
          message: `release ${name}'s image signatures do not verify (${sigstore.reason}), and the workspace opts into supply-chain, so promote deploys only a release whose bundles verify`,
          hint: `Check it with: chant release verify ${name} --sigstore. Install cosign 3 or set CHANT_COSIGN; a bundle that failed was not signed by the identity release.signing names.`,
        };
      }
    }
  }

  if (resolveScan(release?.scan, req.groups).on && [...kinds].some((k) => SCANNED_KINDS.has(k))) {
    const verdict = scanRecorded(await readPublishRecords(req.releaseDigest, { cwd: req.cwd }).catch(() => []));
    if (verdict !== "passed") {
      return {
        code: "release-scan-missing",
        message: `release ${name}'s publish record ${verdict === "none" ? "has no scan line" : "has only a scan that the vulnerability policy blocked"}, and the workspace opts into supply-chain with release.scan on, so promote deploys only a release that was scanned and passed`,
        hint: "Read the scan lines of _releases/publishes.jsonl on chant/lifecycle (git show chant/lifecycle:_releases/publishes.jsonl), and publish the release again once the finding is fixed or a VEX statement covers it.",
      };
    }
  }
  return null;
}
