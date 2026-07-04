/**
 * Tests the `verify` gate (#622, ./verify.ts) against a `MockProcessRunner`
 * (./__tests__/mock-process-runner.ts) — no live `cosign`, no real
 * Rekor/Fulcio network call. Asserts: passes on a valid mock (signature +
 * provenance both verify), fails on missing/invalid signature, fails on
 * wrong identity, and handles a missing `cosign` binary gracefully (throws
 * rather than silently passing the gate).
 */

import { describe, expect, it } from "vitest";
import {
  buildVerifyAttestationArgs,
  buildVerifySignatureArgs,
  createVerifyCapability,
  VerificationFailedError,
} from "./verify";
import { ToolNotAvailableError } from "./process-runner";
import { createMockProcessRunner } from "./__tests__/mock-process-runner";

const ctx = { env: "prod", component: "search-service" };
const DIGEST_REF = "123.dkr.ecr.us-east-1.amazonaws.com/search@sha256:" + "a".repeat(64);

const POLICY = {
  expectedIssuer: "https://token.actions.githubusercontent.com",
  expectedIdentity: "https://github.com/my-org/my-repo/.github/workflows/release.yml@refs/heads/main",
};

describe("verify — command construction", () => {
  it("builds cosign verify with the expected issuer/identity flags", () => {
    const cmd = buildVerifySignatureArgs({ imageRef: DIGEST_REF, policy: POLICY });
    expect(cmd).toBe(
      `cosign verify --certificate-oidc-issuer '${POLICY.expectedIssuer}' --certificate-identity '${POLICY.expectedIdentity}' '${DIGEST_REF}'`,
    );
  });

  it("builds cosign verify-attestation with the slsaprovenance1 type", () => {
    const cmd = buildVerifyAttestationArgs({ imageRef: DIGEST_REF, policy: POLICY });
    expect(cmd).toBe(
      `cosign verify-attestation --type slsaprovenance1 --certificate-oidc-issuer '${POLICY.expectedIssuer}' --certificate-identity '${POLICY.expectedIdentity}' '${DIGEST_REF}'`,
    );
  });

  it("uses --certificate-identity-regexp when identityIsRegexp is set", () => {
    const cmd = buildVerifySignatureArgs({
      imageRef: DIGEST_REF,
      policy: { ...POLICY, expectedIdentity: ".*release.yml@refs/heads/.*", identityIsRegexp: true },
    });
    expect(cmd).toContain("--certificate-identity-regexp");
    expect(cmd).not.toContain("--certificate-identity '");
  });

  it("uses --key instead of the identity policy flags when policy.key is set", () => {
    const cmd = buildVerifySignatureArgs({ imageRef: DIGEST_REF, policy: { ...POLICY, key: "cosign.pub" } });
    expect(cmd).toBe(`cosign verify --key 'cosign.pub' '${DIGEST_REF}'`);
  });
});

describe("verify — passes on a valid mock", () => {
  it("verifies both signature and provenance by default", async () => {
    const mock = createMockProcessRunner();
    const capability = createVerifyCapability(mock.runner);

    const output = await capability.run(ctx, { imageRef: DIGEST_REF, policy: POLICY });

    expect(output).toEqual({ verified: true, checked: ["signature", "provenance"] });
    expect(mock.calls.some((c) => c.command.startsWith("cosign verify --certificate"))).toBe(true);
    expect(mock.calls.some((c) => c.command.startsWith("cosign verify-attestation"))).toBe(true);
  });

  it("skips the provenance check when requireProvenance is false", async () => {
    const mock = createMockProcessRunner();
    const capability = createVerifyCapability(mock.runner);

    const output = await capability.run(ctx, { imageRef: DIGEST_REF, policy: POLICY, requireProvenance: false });

    expect(output).toEqual({ verified: true, checked: ["signature"] });
    expect(mock.calls.some((c) => c.command.startsWith("cosign verify-attestation"))).toBe(false);
  });
});

describe("verify — FAILS the deploy on a missing/invalid signature", () => {
  it("throws VerificationFailedError when cosign verify rejects (e.g. no signature found)", async () => {
    const mock = createMockProcessRunner({
      failures: { "cosign verify --certificate": "Error: no matching signatures" },
    });
    const capability = createVerifyCapability(mock.runner);

    await expect(capability.run(ctx, { imageRef: DIGEST_REF, policy: POLICY })).rejects.toThrow(
      VerificationFailedError,
    );
    await expect(capability.run(ctx, { imageRef: DIGEST_REF, policy: POLICY })).rejects.toThrow(
      /signature verification failed/,
    );
  });

  it("never runs the provenance check once the signature check has already failed", async () => {
    const mock = createMockProcessRunner({
      failures: { "cosign verify --certificate": "Error: no matching signatures" },
    });
    const capability = createVerifyCapability(mock.runner);

    await expect(capability.run(ctx, { imageRef: DIGEST_REF, policy: POLICY })).rejects.toThrow();
    expect(mock.calls.some((c) => c.command.startsWith("cosign verify-attestation"))).toBe(false);
  });
});

describe("verify — FAILS the deploy on missing/invalid provenance", () => {
  it("throws VerificationFailedError when cosign verify-attestation rejects", async () => {
    const mock = createMockProcessRunner({
      failures: { "cosign verify-attestation": "Error: no matching attestations" },
    });
    const capability = createVerifyCapability(mock.runner);

    await expect(capability.run(ctx, { imageRef: DIGEST_REF, policy: POLICY })).rejects.toThrow(
      VerificationFailedError,
    );
    await expect(capability.run(ctx, { imageRef: DIGEST_REF, policy: POLICY })).rejects.toThrow(
      /provenance verification failed/,
    );
  });
});

describe("verify — FAILS the deploy on wrong identity", () => {
  it("surfaces cosign's own identity-mismatch failure as VerificationFailedError", async () => {
    const mock = createMockProcessRunner({
      failures: {
        "cosign verify --certificate": "Error: none of the expected identities matched what was in the certificate",
      },
    });
    const capability = createVerifyCapability(mock.runner);

    await expect(
      capability.run(ctx, {
        imageRef: DIGEST_REF,
        policy: { ...POLICY, expectedIdentity: "https://github.com/someone-else/other-repo/.github/workflows/x.yml@refs/heads/main" },
      }),
    ).rejects.toThrow(/none of the expected identities matched/);
  });
});

describe("verify — cosign absence handled gracefully", () => {
  it("throws ToolNotAvailableError rather than silently passing the gate when cosign is not installed", async () => {
    const mock = createMockProcessRunner({ tools: { cosign: false } });
    const capability = createVerifyCapability(mock.runner);

    await expect(capability.run(ctx, { imageRef: DIGEST_REF, policy: POLICY })).rejects.toThrow(
      ToolNotAvailableError,
    );
    // No verify/verify-attestation call was even attempted.
    expect(mock.calls.some((c) => c.command.startsWith("cosign verify"))).toBe(false);
  });
});

describe("verify — no rollback (read-only observation)", () => {
  it("declares no rollback", () => {
    const capability = createVerifyCapability(createMockProcessRunner().runner);
    expect(capability.rollback).toBeUndefined();
  });
});
