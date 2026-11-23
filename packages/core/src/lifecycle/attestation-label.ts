import { COSIGN_VULN_PREDICATE, CYCLONEDX_PREDICATE, SLSA_PROVENANCE_PREDICATE, SPDX_PREDICATE } from "./publish-signing";

/** What a published attestation is, from its predicate type, for the `published:` lines. An unknown or missing predicate gets a neutral label. */
export function attestationLabel(predicateType: string | undefined): string {
  if (predicateType === SLSA_PROVENANCE_PREDICATE) return "SLSA provenance, Sigstore";
  if (predicateType === SPDX_PREDICATE || predicateType === CYCLONEDX_PREDICATE) return "SBOM attestation, Sigstore";
  if (predicateType === COSIGN_VULN_PREDICATE) return "scan attestation, Sigstore";
  return "attestation";
}
