/**
 * Tests `sign`/`attest-provenance` (#622, ./sign.ts) against a
 * `MockProcessRunner` (./__tests__/mock-process-runner.ts) — no live
 * `cosign`, no real Rekor/Fulcio network call, ever. Asserts the constructed
 * keyless `cosign sign`/`cosign attest` invocations, the digest-only guard,
 * the opt-in key-based override, and graceful `cosign`-absent handling.
 */

import { describe, expect, it } from "vitest";
import {
  buildAttestArgs,
  buildProvenanceStatement,
  buildSignArgs,
  createAttestProvenanceCapability,
  createSignCapability,
  SignTargetNotDigestError,
} from "./sign";
import { ToolNotAvailableError } from "./process-runner";
import { createMockProcessRunner } from "./__tests__/mock-process-runner";

const ctx = { env: "prod", component: "search-service" };
const DIGEST_REF =
  "123.dkr.ecr.us-east-1.amazonaws.com/search@sha256:" + "a".repeat(64);
const TAG_REF = "123.dkr.ecr.us-east-1.amazonaws.com/search:latest";

describe("sign — keyless by default (#622)", () => {
  it("builds a keyless cosign sign invocation with no --key flag", () => {
    const cmd = buildSignArgs({ imageRef: DIGEST_REF });
    expect(cmd).toBe(`cosign sign --yes '${DIGEST_REF}'`);
    expect(cmd).not.toContain("--key");
  });

  it("runs cosign sign against the digest and reports method: keyless", async () => {
    const mock = createMockProcessRunner();
    const capability = createSignCapability(mock.runner);

    const output = await capability.run(ctx, { imageRef: DIGEST_REF });

    expect(output).toEqual({ imageRef: DIGEST_REF, signed: true, method: "keyless" });
    const signCall = mock.calls.find((c) => c.command.startsWith("cosign sign"))!;
    expect(signCall.command).toContain(DIGEST_REF);
    expect(signCall.command).not.toContain("--key");
  });

  it("passes through explicit OIDC issuer/client-id/token overrides", () => {
    const cmd = buildSignArgs({
      imageRef: DIGEST_REF,
      keyless: { identityToken: "tok", oidcIssuer: "https://issuer.example", oidcClientId: "sigstore" },
    });
    expect(cmd).toContain("--identity-token 'tok'");
    expect(cmd).toContain("--oidc-issuer 'https://issuer.example'");
    expect(cmd).toContain("--oidc-client-id 'sigstore'");
  });

  it("attaches annotations via -a k=v flags", () => {
    const cmd = buildSignArgs({ imageRef: DIGEST_REF, annotations: { build: "123", branch: "main" } });
    expect(cmd).toContain("-a 'build=123'");
    expect(cmd).toContain("-a 'branch=main'");
  });

  it("refuses to sign a mutable tag reference — never a tag, only a digest", async () => {
    const mock = createMockProcessRunner();
    const capability = createSignCapability(mock.runner);

    await expect(capability.run(ctx, { imageRef: TAG_REF })).rejects.toThrow(SignTargetNotDigestError);
    // Refuses before ever shelling out — no cosign call attempted at all.
    expect(mock.calls).toHaveLength(0);
  });

  it("switches to key-based signing only when input.key is explicitly supplied (opt-in, not default)", async () => {
    const mock = createMockProcessRunner();
    const capability = createSignCapability(mock.runner);

    const output = await capability.run(ctx, {
      imageRef: DIGEST_REF,
      key: { key: "awskms://alias/my-signing-key" },
    });

    expect(output.method).toBe("key");
    const signCall = mock.calls.find((c) => c.command.startsWith("cosign sign"))!;
    expect(signCall.command).toContain("--key 'awskms://alias/my-signing-key'");
    expect(signCall.command).not.toContain("--oidc-issuer");
  });

  it("throws ToolNotAvailableError when cosign is absent, rather than silently skipping the signature", async () => {
    const mock = createMockProcessRunner({ tools: { cosign: false } });
    const capability = createSignCapability(mock.runner);

    await expect(capability.run(ctx, { imageRef: DIGEST_REF })).rejects.toThrow(ToolNotAvailableError);
  });

  it("declares no rollback — an already-signed, content-addressed image's signature is immutable evidence", () => {
    const capability = createSignCapability(createMockProcessRunner().runner);
    expect(capability.rollback).toBeUndefined();
  });
});

describe("buildProvenanceStatement — SLSA in-toto statement from #614 provenance material", () => {
  it("builds a subject/predicate from the digest ref and ProvenanceLink", () => {
    const statement = buildProvenanceStatement({
      imageRef: DIGEST_REF,
      provenance: { sourceRef: "abc123def", artifactDigest: DIGEST_REF.split("@")[1]! },
      builderId: "https://github.com/actions/runner",
    });

    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.predicateType).toBe("https://slsa.dev/provenance/v1");
    expect(statement.subject).toEqual([
      { name: DIGEST_REF, digest: { sha256: "a".repeat(64) } },
    ]);
    expect(statement.predicate.buildDefinition.externalParameters).toEqual({ sourceRef: "abc123def" });
    expect(statement.predicate.runDetails.builder.id).toBe("https://github.com/actions/runner");
    expect(statement.predicate.runDetails.metadata?.finishedOn).toBeDefined();
  });

  it("throws when imageRef has no digest", () => {
    expect(() =>
      buildProvenanceStatement({
        imageRef: TAG_REF,
        provenance: { sourceRef: "abc", artifactDigest: "sha256:x" },
        builderId: "builder",
      }),
    ).toThrow(SignTargetNotDigestError);
  });

  it("reserved parameter keys win over caller-supplied collisions (#1943)", () => {
    const statement = buildProvenanceStatement({
      imageRef: DIGEST_REF,
      provenance: { sourceRef: "abc123def", artifactDigest: DIGEST_REF.split("@")[1]! },
      builderId: "builder",
      externalParameters: { sourceRef: "spoofed", agent: "reviewer" },
      internalParameters: { artifactDigest: "spoofed", spriteId: "s-1" },
    });

    expect(statement.predicate.buildDefinition.externalParameters).toEqual({
      sourceRef: "abc123def",
      agent: "reviewer",
    });
    expect(statement.predicate.buildDefinition.internalParameters).toEqual({
      artifactDigest: DIGEST_REF.split("@")[1]!,
      spriteId: "s-1",
    });
  });
});

describe("attest-provenance — keyless cosign attest (#622)", () => {
  it("builds a keyless cosign attest invocation with the slsaprovenance1 type and no --key", () => {
    const cmd = buildAttestArgs({
      imageRef: DIGEST_REF,
      provenance: { sourceRef: "abc123", artifactDigest: "sha256:x" },
      builderId: "builder",
    }, "/tmp/scratch.json");

    expect(cmd).toContain("cosign attest --yes --type slsaprovenance1 --predicate '/tmp/scratch.json'");
    expect(cmd).toContain(DIGEST_REF);
    expect(cmd).not.toContain("--key");
  });

  it("signs+attaches the SLSA provenance statement via cosign attest, keyless by default", async () => {
    const mock = createMockProcessRunner();
    const capability = createAttestProvenanceCapability(mock.runner);

    const output = await capability.run(ctx, {
      imageRef: DIGEST_REF,
      provenance: { sourceRef: "abc123def", artifactDigest: DIGEST_REF.split("@")[1]! },
      builderId: "https://github.com/actions/runner",
    });

    expect(output.attested).toBe(true);
    expect(output.method).toBe("keyless");
    expect(output.statement.predicateType).toBe("https://slsa.dev/provenance/v1");

    const attestCall = mock.calls.find((c) => c.command.startsWith("cosign attest"))!;
    expect(attestCall.command).toContain("--type slsaprovenance1");
    expect(attestCall.command).toContain(DIGEST_REF);
    expect(attestCall.command).not.toContain("--key");

    // The predicate file is written to a scratch path before cosign reads it.
    expect(mock.calls.some((c) => c.command.includes("chant-provenance-attest"))).toBe(true);
  });

  it("uses key-based attestation only when explicitly configured", async () => {
    const mock = createMockProcessRunner();
    const capability = createAttestProvenanceCapability(mock.runner);

    const output = await capability.run(ctx, {
      imageRef: DIGEST_REF,
      provenance: { sourceRef: "abc123def", artifactDigest: DIGEST_REF.split("@")[1]! },
      builderId: "builder",
      key: { key: "cosign.key" },
    });

    expect(output.method).toBe("key");
    const attestCall = mock.calls.find((c) => c.command.startsWith("cosign attest"))!;
    expect(attestCall.command).toContain("--key 'cosign.key'");
  });

  it("refuses a tag-only imageRef before ever shelling out", async () => {
    const mock = createMockProcessRunner();
    const capability = createAttestProvenanceCapability(mock.runner);

    await expect(
      capability.run(ctx, {
        imageRef: TAG_REF,
        provenance: { sourceRef: "abc", artifactDigest: "sha256:x" },
        builderId: "builder",
      }),
    ).rejects.toThrow(SignTargetNotDigestError);
    expect(mock.calls).toHaveLength(0);
  });

  it("throws ToolNotAvailableError when cosign is absent", async () => {
    const mock = createMockProcessRunner({ tools: { cosign: false } });
    const capability = createAttestProvenanceCapability(mock.runner);

    await expect(
      capability.run(ctx, {
        imageRef: DIGEST_REF,
        provenance: { sourceRef: "abc", artifactDigest: DIGEST_REF.split("@")[1]! },
        builderId: "builder",
      }),
    ).rejects.toThrow(ToolNotAvailableError);
  });

  it("declares no rollback — an attached attestation is immutable evidence", () => {
    const capability = createAttestProvenanceCapability(createMockProcessRunner().runner);
    expect(capability.rollback).toBeUndefined();
  });
});
