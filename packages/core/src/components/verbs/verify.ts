/**
 * `verify` capability — the deploy-time signature/provenance gate (#622,
 * epic #551 follow-up to ./sign.ts's keyless signing + SLSA attestation).
 * Mirrors `../../lint/policy.ts`'s `policyGate` shape: a step that runs
 * `cosign verify` (+ `cosign verify-attestation` for provenance) against a
 * configured identity policy and **throws** on any failure, so composing it
 * before an apply phase fails the deploy the same way a thrown capability
 * error already halts `driver.ts`'s step execution — no new failure
 * mechanism, no gate-signal/human-approval semantics (that is `Gate`,
 * ../component.ts, a different, durable-runtime-only concept). `verify` is a
 * synchronous, local-executor-safe capability, exactly like `health-gate`
 * (./wait-verify.ts).
 *
 * **Beginner-safe default policy.** The minimum an identity policy must
 * declare is `expectedIssuer` + `expectedIdentity` (the OIDC issuer/identity
 * that must have signed) — "signature present + from the expected identity."
 * There is no "verify but accept any identity" mode: an identity-less verify
 * would defeat the point of keyless signing (anyone's Rekor-logged signature
 * would pass), so `IdentityPolicy` requires both fields, not an optional
 * pair a beginner could forget to set.
 *
 * Routes `cosign verify`/`cosign verify-attestation` through the injectable
 * `ProcessRunner` (./process-runner.ts), mirroring every other #610/#622
 * real backend: `requireTool` throws `ToolNotAvailableError` if `cosign` is
 * absent (a missing verifier is a hard stop, never a silent pass — the
 * opposite failure mode from ./publish.ts's best-effort referrer attach,
 * because skipping verification on a missing tool would silently let an
 * unsigned/wrongly-signed artifact through the gate).
 */

import type { Capability } from "../capability";
import { defaultProcessRunner, q, requireTool, type ProcessRunner } from "./process-runner";

// ── identity policy ──────────────────────────────────────────────────────────

/**
 * The configured identity an artifact's signature/provenance must match —
 * "beginner-safe default" per #622: signature present + from the expected
 * identity, nothing more exotic required out of the box. Both fields are
 * required (see this module's doc comment for why an identity-less verify
 * is not offered).
 */
export interface IdentityPolicy {
  /** Expected OIDC issuer, e.g. `"https://token.actions.githubusercontent.com"` for GitHub Actions keyless signing. Passed to `cosign verify --certificate-oidc-issuer`. */
  expectedIssuer: string;
  /**
   * Expected signer identity. For keyless CI signing this is typically the
   * workflow identity URI cosign embeds in the Fulcio cert (e.g.
   * `"https://github.com/my-org/my-repo/.github/workflows/release.yml@refs/heads/main"`).
   * Passed to `cosign verify --certificate-identity`. Supports the same
   * `--certificate-identity-regexp` escape hatch via `identityIsRegexp`
   * below, for teams whose identity varies by branch/tag and want one policy
   * to match a pattern rather than enumerating every literal ref.
   */
  expectedIdentity: string;
  /** Treat `expectedIdentity` as a regexp (`cosign verify --certificate-identity-regexp`) instead of a literal match. Default: false. */
  identityIsRegexp?: boolean;
  /** Optional key-based override — verify against a public key instead of the keyless identity policy, mirroring ./sign.ts's opt-in key-based override. Not the default. */
  key?: string;
}

// ── verify (signature gate) ──────────────────────────────────────────────────

export interface VerifyInput {
  /** Digest-qualified image reference to verify, e.g. `"@Publish.uri"`/`"@Sign.imageRef"`. */
  imageRef: string;
  /** The identity policy the signature must satisfy. */
  policy: IdentityPolicy;
  /** Also verify the SLSA provenance attestation (`cosign verify-attestation --type slsaprovenance1`) alongside the signature. Default: true — both #622 outputs are expected present once `sign`+`attest-provenance` have run. */
  requireProvenance?: boolean;
}

export interface VerifyOutput {
  /** True once every requested check (signature, and provenance if requested) passed. Always `true` when returned — a failure throws instead, so a caller never has to remember to check this field; it exists for symmetry with other capability outputs and for logging. */
  verified: true;
  /** Which checks actually ran and passed. */
  checked: Array<"signature" | "provenance">;
}

/**
 * Thrown when `cosign verify`/`cosign verify-attestation` rejects — wrong
 * identity, missing signature, tampered artifact, or any other verification
 * failure `cosign` itself reports. Distinct from `ToolNotAvailableError` so a
 * caller (and a test) can tell "cosign said no" apart from "cosign isn't
 * installed." Carries `reason` (cosign's own stderr/message) for whoever is
 * debugging a failed gate.
 */
export class VerificationFailedError extends Error {
  constructor(
    public readonly imageRef: string,
    public readonly check: "signature" | "provenance",
    public readonly reason: string,
  ) {
    super(`verify "${imageRef}": ${check} verification failed — ${reason}`);
    this.name = "VerificationFailedError";
  }
}

/** Append the shared identity-policy flags to a `cosign verify`/`verify-attestation` argv, mutating `args` in place — kept in one place so `verify`'s two checks can never drift apart on how the policy is expressed. */
function appendPolicyFlags(args: string[], policy: IdentityPolicy): void {
  if (policy.key) {
    args.push("--key", q(policy.key));
    return;
  }
  args.push("--certificate-oidc-issuer", q(policy.expectedIssuer));
  args.push(policy.identityIsRegexp ? "--certificate-identity-regexp" : "--certificate-identity", q(policy.expectedIdentity));
}

/** Build the `cosign verify` argv (as a shell command string) for `input` — factored out so tests can assert on the exact invocation. */
export function buildVerifySignatureArgs(input: VerifyInput): string {
  const args = ["cosign", "verify"];
  appendPolicyFlags(args, input.policy);
  args.push(q(input.imageRef));
  return args.join(" ");
}

/** Build the `cosign verify-attestation` argv (as a shell command string) for `input`. */
export function buildVerifyAttestationArgs(input: VerifyInput): string {
  const args = ["cosign", "verify-attestation", "--type", "slsaprovenance1"];
  appendPolicyFlags(args, input.policy);
  args.push(q(input.imageRef));
  return args.join(" ");
}

/**
 * Gate a deploy on `cosign verify` (signature) + `cosign verify-attestation`
 * (SLSA provenance, unless `requireProvenance: false`) against `input.policy`
 * — the digest-anchored counterpart to `../../lint/policy.ts`'s
 * organizational-policy `policyGate`. Throws `VerificationFailedError` on any
 * failed check, which halts the composition the same way any other thrown
 * capability error does (see ../driver.ts) — no separate "gate" plumbing
 * needed; a `verify` step composed before an `Apply` phase blocks that phase
 * from ever running on verification failure.
 *
 * No rollback: verification is read-only observation of already-published
 * evidence, nothing to compensate — same reasoning as `health-gate`/`wait-*`
 * (./wait-verify.ts).
 */
export function createVerifyCapability(
  processRunner: ProcessRunner = defaultProcessRunner(),
): Capability<VerifyInput, VerifyOutput> {
  return {
    kind: "verify",
    async run(_ctx, input) {
      await requireTool(processRunner, "cosign", `verify ${input.imageRef} against the configured identity policy`);

      const checked: Array<"signature" | "provenance"> = [];

      try {
        await processRunner.run(buildVerifySignatureArgs(input));
      } catch (err) {
        throw new VerificationFailedError(
          input.imageRef,
          "signature",
          err instanceof Error ? err.message : String(err),
        );
      }
      checked.push("signature");

      if (input.requireProvenance !== false) {
        try {
          await processRunner.run(buildVerifyAttestationArgs(input));
        } catch (err) {
          throw new VerificationFailedError(
            input.imageRef,
            "provenance",
            err instanceof Error ? err.message : String(err),
          );
        }
        checked.push("provenance");
      }

      return { verified: true, checked };
    },
  };
}

/** Default `verify` capability, backed by the real `ProcessRunner`. */
export const verify: Capability<VerifyInput, VerifyOutput> = createVerifyCapability();
