/**
 * `sign` capability — keyless cosign signing + SLSA provenance attestation
 * (#622, epic #551 follow-up to #610's referrer-attach path and #614's
 * reproducibility/provenance material). The companion gate is
 * `./verify.ts`'s `verify` capability.
 *
 * **Beginner footgun #1 neutralized: sign the digest, never a tag.** `input`
 * requires an already-resolved `sha256:` image reference (typically wired
 * from a prior publish step, `"@Publish.uri"`, which is itself
 * `repo@sha256:...` — see ./publish.ts) — never a bare tag. A tag is mutable;
 * signing one says nothing about which bytes were actually signed by the
 * time someone pulls it. `assertDigestRef` below throws before ever shelling
 * out if a caller passes a tag-only reference.
 *
 * **Beginner footgun #2 neutralized: keyless by default.** Sign via cosign's
 * keyless flow (a short-lived Fulcio cert bound to an OIDC identity, logged
 * to the public Rekor transparency log) — `cosign sign --yes <ref>` with no
 * `--key`. There is no private key file for a first-timer to generate, lose,
 * leak, or forget to rotate. Key-based signing (`input.key`) is an opt-in
 * override for teams with an existing KMS/file-based key policy, never the
 * default — see `buildSignArgs`/`buildAttestArgs` below: `--key` is added
 * only when `input.key` is explicitly supplied, and it is the *only* thing
 * that changes about the invocation (still by digest, still attached the
 * same way).
 *
 * **SLSA provenance.** `attestProvenance` builds an in-toto
 * `https://slsa.dev/provenance/v1` statement from the same
 * `ProvenanceLink`/`ArtifactReproducibility` material #614's
 * ./reproducibility.ts already records per build-archive entry (source ref,
 * artifact digest) plus a builder id and timestamp, then signs+attaches it
 * via `cosign attest` (keyless by the same default). This reuses #614's
 * provenance model rather than inventing a second one — the in-toto
 * statement's `predicate.buildDefinition.resolvedDependencies` /
 * `.internalParameters` are populated from the same source-ref/digest link a
 * build archive entry already carries.
 *
 * Both `sign` and `attestProvenance` shell out to `cosign` through the
 * injectable `ProcessRunner` (./process-runner.ts) — mirroring
 * ./tool-sbom-generator.ts and ./publish.ts's referrer-attach step exactly:
 * `requireTool` throws `ToolNotAvailableError` with an actionable message if
 * `cosign` is absent, and no test here ever spawns a real process or talks
 * to Rekor/Fulcio.
 */

import type { Capability } from "../capability";
import { defaultProcessRunner, q, requireTool, type ProcessRunner } from "./process-runner";
import type { ProvenanceLink } from "./reproducibility";

// ── shared: digest-only reference guard ─────────────────────────────────────

/**
 * Thrown when a `sign`/`attest` input's image reference has no `@sha256:...`
 * digest — refusing to sign a mutable tag (beginner footgun #1) rather than
 * silently signing whatever the tag happens to resolve to right now.
 */
export class SignTargetNotDigestError extends Error {
  constructor(
    public readonly ref: string,
    public readonly verb: "sign" | "attest",
  ) {
    super(
      `${verb} "${ref}": expected a digest reference ("repo@sha256:...", e.g. from a prior publish step's "@Publish.uri") — ` +
        `signing a mutable tag would not pin which bytes were signed. Pass the digest-qualified reference instead.`,
    );
    this.name = "SignTargetNotDigestError";
  }
}

/** True if `ref` carries an `@sha256:<hex>` digest — the only form `sign`/`attest` accept. */
function isDigestRef(ref: string): boolean {
  return /@sha256:[0-9a-f]{64}$/i.test(ref);
}

/** Throw `SignTargetNotDigestError` unless `ref` is digest-qualified. */
function assertDigestRef(ref: string, verb: "sign" | "attest"): void {
  if (!isDigestRef(ref)) throw new SignTargetNotDigestError(ref, verb);
}

// ── keyless identity config (shared by sign + attest + verify) ─────────────

/**
 * cosign keyless signing config. Keyless is the default story this whole
 * module encodes — every field here is optional because `cosign sign --yes`
 * with no flags at all already does the right thing in CI (ambient OIDC from
 * the CI provider's own token, e.g. GitHub Actions' `id-token: write`).
 * `identityToken`/`oidcIssuer`/`oidcClientId` are the explicit overrides for
 * environments without ambient OIDC detection.
 */
export interface KeylessSigningConfig {
  /** Explicit OIDC identity token, when the environment has no ambient CI OIDC cosign can auto-detect. */
  identityToken?: string;
  /** OIDC issuer URL override (`cosign sign --oidc-issuer`). */
  oidcIssuer?: string;
  /** OIDC client id override (`cosign sign --oidc-client-id`). */
  oidcClientId?: string;
  /** Fulcio URL override, for a private Sigstore instance. */
  fulcioUrl?: string;
  /** Rekor URL override, for a private transparency log. */
  rekorUrl?: string;
}

/**
 * Key-based signing override config — opt-in, never the default (see this
 * module's doc comment). Supplying `input.key` on `sign`/`attestProvenance`
 * switches the invocation to `cosign sign --key <key>` instead of the keyless
 * flow; every other part of the invocation (digest-only target, referrer
 * attach) is unchanged.
 */
export interface KeyBasedSigningConfig {
  /** Key reference cosign accepts: a local path, `kms://...`, `k8s://...`, `azurekms://...`, `awskms://...`, etc. An encrypted key file's password is not accepted here — `ProcessRunner.run` (./process-runner.ts) has no env-var passthrough today, and interpolating a secret into the shell command string would leak it into process listings/logs; supply an unencrypted key reference (e.g. a KMS URI) or export `COSIGN_PASSWORD` in the calling process's own environment instead. */
  key: string;
}

/** Append the shared keyless/key-based signing flags to a cosign argv, mutating `args` in place. Shared by `buildSignArgs` and `buildAttestArgs` so both stay in lockstep. */
function appendSigningFlags(
  args: string[],
  opts: { keyless?: KeylessSigningConfig; key?: KeyBasedSigningConfig },
): void {
  if (opts.key) {
    args.push("--key", q(opts.key.key));
    return;
  }
  // Keyless (default): no --key at all — cosign's own keyless flow (Fulcio + Rekor).
  const k = opts.keyless;
  if (k?.identityToken) args.push("--identity-token", q(k.identityToken));
  if (k?.oidcIssuer) args.push("--oidc-issuer", q(k.oidcIssuer));
  if (k?.oidcClientId) args.push("--oidc-client-id", q(k.oidcClientId));
  if (k?.fulcioUrl) args.push("--fulcio-url", q(k.fulcioUrl));
  if (k?.rekorUrl) args.push("--rekor-url", q(k.rekorUrl));
}

// ── sign ─────────────────────────────────────────────────────────────────────

export interface SignInput {
  /** Digest-qualified image reference to sign, e.g. `"123.dkr.ecr.us-east-1.amazonaws.com/search@sha256:abc..."` — typically wired from a prior publish step's `"@Publish.uri"`. Never a bare tag; see `SignTargetNotDigestError`. */
  imageRef: string;
  /** Keyless signing config (OIDC identity + Rekor/Fulcio overrides). Default: cosign's own ambient keyless detection, no explicit config needed. Ignored when `key` is supplied. */
  keyless?: KeylessSigningConfig;
  /** Opt-in key-based override — supply to sign with a private/KMS key instead of the keyless default. Not the default; see this module's doc comment. */
  key?: KeyBasedSigningConfig;
  /** Annotations to attach to the signature (`cosign sign -a k=v`), e.g. build metadata. */
  annotations?: Record<string, string>;
}

export interface SignOutput {
  /** The digest-qualified reference that was signed — echoed back for downstream wiring (e.g. into `attestProvenance`/`verify`). */
  imageRef: string;
  /** True once `cosign sign` completed without error. */
  signed: true;
  /** `"keyless"` or `"key"`, reflecting which flow actually ran. */
  method: "keyless" | "key";
}

/** Build the `cosign sign` argv (as a shell command string) for `input` — factored out so tests can assert on the exact invocation without needing a full mock run. */
export function buildSignArgs(input: SignInput): string {
  const args = ["cosign", "sign", "--yes"];
  appendSigningFlags(args, { keyless: input.keyless, key: input.key });
  for (const [k, v] of Object.entries(input.annotations ?? {})) {
    args.push("-a", q(`${k}=${v}`));
  }
  args.push(q(input.imageRef));
  return args.join(" ");
}

/**
 * Sign an artifact by digest via keyless cosign (default) or an opt-in
 * key-based override, and attach the signature as an OCI referrer on that
 * digest — `cosign sign` itself performs the attach (cosign's signatures are
 * always stored as registry referrers/the legacy tag convention; no separate
 * `oras attach` step is needed the way SBOM/BOM referrer attach in
 * ./publish.ts requires one, since cosign natively pushes to the registry).
 * Refuses to run at all against a non-digest reference (`SignTargetNotDigestError`)
 * — sign is never invoked for a tag, by construction, before any process is spawned.
 *
 * No rollback: an already-signed, content-addressed image's signature is
 * immutable evidence sitting in the registry — nothing to compensate, the
 * same opt-out `publish-image`/`generate-sbom` already take for
 * no-mutable-remote-state operations.
 */
export function createSignCapability(
  processRunner: ProcessRunner = defaultProcessRunner(),
): Capability<SignInput, SignOutput> {
  return {
    kind: "sign",
    async run(_ctx, input) {
      assertDigestRef(input.imageRef, "sign");
      await requireTool(processRunner, "cosign", `sign ${input.imageRef}`);
      await processRunner.run(buildSignArgs(input));
      return { imageRef: input.imageRef, signed: true, method: input.key ? "key" : "keyless" };
    },
  };
}

/** Default `sign` capability, backed by the real `ProcessRunner`. */
export const sign: Capability<SignInput, SignOutput> = createSignCapability();

// ── SLSA provenance attestation (attest-provenance) ─────────────────────────

/** Minimal in-toto `https://slsa.dev/provenance/v1` predicate — the fields this module can honestly populate from #614's `ProvenanceLink` material, not a full SLSA Level 3+ builder identity/hermeticity claim. */
export interface SlsaProvenancePredicate {
  buildDefinition: {
    buildType: string;
    externalParameters: Record<string, unknown>;
    internalParameters?: Record<string, unknown>;
    resolvedDependencies?: Array<{ uri: string; digest?: Record<string, string> }>;
  };
  runDetails: {
    builder: { id: string };
    metadata?: {
      invocationId?: string;
      startedOn?: string;
      finishedOn?: string;
    };
  };
}

/** The full in-toto statement wrapping the SLSA predicate — what `cosign attest` signs+attaches. */
export interface InTotoProvenanceStatement {
  _type: "https://in-toto.io/Statement/v1";
  predicateType: "https://slsa.dev/provenance/v1";
  subject: Array<{ name: string; digest: { sha256: string } }>;
  predicate: SlsaProvenancePredicate;
}

export interface BuildProvenanceStatementInput {
  /** The digest-qualified artifact reference this provenance describes (subject). */
  imageRef: string;
  /** Source -> output link, reused from #614 (./reproducibility.ts) rather than re-deriving a second source-of-truth for "what commit produced this." */
  provenance: ProvenanceLink;
  /** Builder identity URI, e.g. a CI run URL or `"https://github.com/actions/runner"`. */
  builderId: string;
  /** Build type identifier (an arbitrary URI naming the recipe kind, e.g. `"https://chant.dev/build-archive/v1"`). Defaults to a chant-generic build type. */
  buildType?: string;
  /** ISO-8601 timestamp of the build's completion. Defaults to `new Date().toISOString()`. */
  finishedOn?: string;
  /** CI invocation/run id, when available (e.g. a GitHub Actions run id). */
  invocationId?: string;
}

const DEFAULT_BUILD_TYPE = "https://chant.dev/build-archive/v1";

/** Extract the bare `sha256:...` digest out of a digest-qualified reference (`repo@sha256:...`). */
function digestOf(ref: string): string {
  const match = /sha256:([0-9a-f]{64})$/i.exec(ref);
  if (!match) throw new SignTargetNotDigestError(ref, "attest");
  return match[1]!;
}

/**
 * Build an in-toto SLSA provenance statement for `input.imageRef`, reusing
 * #614's `ProvenanceLink` (source ref -> artifact digest) as the statement's
 * `resolvedDependencies`/`internalParameters` material — the honest subset
 * chant can actually attest to (which source commit, which builder, when),
 * matching ./reproducibility.ts's "honesty over convenience" stance rather
 * than fabricating a stronger provenance claim than the build system backs.
 */
export function buildProvenanceStatement(input: BuildProvenanceStatementInput): InTotoProvenanceStatement {
  const digest = digestOf(input.imageRef);
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: input.imageRef, digest: { sha256: digest } }],
    predicate: {
      buildDefinition: {
        buildType: input.buildType ?? DEFAULT_BUILD_TYPE,
        externalParameters: { sourceRef: input.provenance.sourceRef },
        internalParameters: { artifactDigest: input.provenance.artifactDigest },
        resolvedDependencies: [{ uri: input.provenance.sourceRef, digest: { sha256: digest } }],
      },
      runDetails: {
        builder: { id: input.builderId },
        metadata: {
          ...(input.invocationId ? { invocationId: input.invocationId } : {}),
          finishedOn: input.finishedOn ?? new Date().toISOString(),
        },
      },
    },
  };
}

export interface AttestProvenanceInput extends BuildProvenanceStatementInput {
  /** Keyless signing config, same shape/default as `SignInput.keyless`. */
  keyless?: KeylessSigningConfig;
  /** Opt-in key-based override, same shape/default as `SignInput.key`. */
  key?: KeyBasedSigningConfig;
}

export interface AttestProvenanceOutput {
  /** The digest-qualified reference the provenance was attested for. */
  imageRef: string;
  /** The in-toto statement that was signed+attached (returned for inspection/logging/tests). */
  statement: InTotoProvenanceStatement;
  /** True once `cosign attest` completed without error. */
  attested: true;
  /** `"keyless"` or `"key"`, reflecting which flow actually ran. */
  method: "keyless" | "key";
}

/**
 * Build the `cosign attest` argv (as a shell command string) for a
 * predicate-type/payload pair. Factored out (like `buildSignArgs`) so tests
 * can assert on the exact invocation. `--predicate` reads from a scratch
 * file path (`cosign attest` does not accept the payload on stdin any more
 * reliably than `oras attach` does — see ./publish.ts's `attachOneReferrer`
 * for the same scratch-file convention) — the caller passes the path already
 * written.
 */
export function buildAttestArgs(
  input: AttestProvenanceInput,
  predicatePath: string,
): string {
  const args = ["cosign", "attest", "--yes", "--type", "slsaprovenance1", "--predicate", q(predicatePath)];
  appendSigningFlags(args, { keyless: input.keyless, key: input.key });
  args.push(q(input.imageRef));
  return args.join(" ");
}

/**
 * Build an in-toto SLSA provenance statement for a digest-qualified artifact
 * (reusing #614's `ProvenanceLink` material) and sign+attach it via keyless
 * `cosign attest` (default) or an opt-in key-based override — attached as a
 * referrer alongside the signature (`sign`) and SBOM (`generate-sbom`) on
 * the same digest. Refuses a non-digest `imageRef` the same way `sign` does.
 *
 * No rollback: same reasoning as `sign` — an attached, content-addressed
 * attestation is immutable evidence, nothing to compensate.
 */
export function createAttestProvenanceCapability(
  processRunner: ProcessRunner = defaultProcessRunner(),
): Capability<AttestProvenanceInput, AttestProvenanceOutput> {
  return {
    kind: "attest-provenance",
    async run(_ctx, input) {
      assertDigestRef(input.imageRef, "attest");
      await requireTool(processRunner, "cosign", `attest SLSA provenance for ${input.imageRef}`);

      const statement = buildProvenanceStatement(input);
      const scratchFile = `/tmp/chant-provenance-attest/${digestOf(input.imageRef)}-${Date.now()}.json`;
      await processRunner.run(`mkdir -p ${q("/tmp/chant-provenance-attest")}`);
      await processRunner.run(`printf '%s' ${q(JSON.stringify(statement))} > ${q(scratchFile)}`);
      await processRunner.run(buildAttestArgs(input, scratchFile));

      return { imageRef: input.imageRef, statement, attested: true, method: input.key ? "key" : "keyless" };
    },
  };
}

/** Default `attest-provenance` capability, backed by the real `ProcessRunner`. */
export const attestProvenance: Capability<AttestProvenanceInput, AttestProvenanceOutput> =
  createAttestProvenanceCapability();
