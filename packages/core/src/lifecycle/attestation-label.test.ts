import { describe, expect, test } from "vitest";
import { attestationLabel } from "./attestation-label";

describe("attestationLabel", () => {
  test("follows the predicate type", () => {
    expect(attestationLabel("https://slsa.dev/provenance/v1")).toBe("SLSA provenance, Sigstore");
    expect(attestationLabel("https://spdx.dev/Document")).toBe("SBOM attestation, Sigstore");
    expect(attestationLabel("https://cyclonedx.org/bom")).toBe("SBOM attestation, Sigstore");
    expect(attestationLabel("https://cosign.sigstore.dev/attestation/vuln/v1")).toBe("scan attestation, Sigstore");
  });

  test("is neutral otherwise", () => {
    expect(attestationLabel(undefined)).toBe("attestation");
    expect(attestationLabel("https://example.com/other")).toBe("attestation");
  });
});
