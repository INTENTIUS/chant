/**
 * WK8505: committed-encrypted secret with no Flux decryption wiring
 *
 * Flux is the thing that actually decrypts a committed-encrypted secret's
 * sidecar, via `spec.decryption` on the reconciling `Kustomization`
 * (`FluxAppFor`'s `decryption` option). Nothing forces the two calls to be
 * wired together: `declareSecret({ provenance: "committed-encrypted" })` and
 * `FluxAppFor(...)` are independent, so it is easy to add the ciphertext
 * without adding the wiring — the build succeeds, WK8504 passes because the
 * file resolves cleanly, and Flux still applies the sidecar as raw
 * `ENC[...]` bytes because nothing told it to decrypt first.
 *
 * Warning, not error. The reference project shape (`examples/flux-apps`)
 * runs the workload build and the Flux build as separate `chant build`
 * invocations, so "no Kustomization in THIS build sets spec.decryption" can
 * mean "wired up in the other build" as easily as "forgotten" — the design
 * doc's §4 explains why no path-to-build-target join exists to tell those
 * apart. Promote to error if that join ever becomes available.
 *
 * Fires only on claims that actually resolved (`problems.length === 0`, via
 * `resolveEncryptedSecretClaims`), not on every raw declaration. An
 * unresolved declaration is already WK8504's job at error severity; firing
 * this warning on top of it would report a Flux wiring gap for a Secret the
 * build has not confirmed exists.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { allManifests, manifestsOfKind } from "./argo-helpers";
import type { K8sManifest } from "./k8s-helpers";
import { resolveEncryptedSecretClaims } from "./sops-helpers";

/** Flux Kustomizations only — the kustomize.config.k8s.io kind shares the name. */
function fluxKustomizations(manifests: K8sManifest[]): K8sManifest[] {
  return manifestsOfKind(manifests, "Kustomization").filter((m) => {
    const apiVersion = m.apiVersion;
    return typeof apiVersion !== "string" || apiVersion.startsWith("kustomize.toolkit.fluxcd.io/");
  });
}

export const wk8505: PostSynthCheck = {
  id: "WK8505",
  description:
    "committed-encrypted secret with no Flux decryption wiring — add decryption: 'sops' to the FluxAppFor reconciling the path that carries it",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const kustomizations = fluxKustomizations(allManifests(ctx));
    if (kustomizations.length === 0) return [];
    if (kustomizations.some((k) => k.spec?.decryption !== undefined)) return [];

    const resolved = resolveEncryptedSecretClaims(ctx).filter((claim) => claim.problems.length === 0);

    return resolved.map((claim) => ({
      checkId: "WK8505",
      severity: "warning",
      message:
        `declareSecret("${claim.declaration.name}") is committed-encrypted, but no Flux Kustomization ` +
        `in this build sets spec.decryption — Flux will apply "${claim.filename}" without decrypting it. ` +
        `Add decryption: "sops" to the FluxAppFor reconciling the path that carries it, or ignore if that ` +
        `Kustomization is declared in a different build.`,
      entity: claim.declaration.name,
      lexicon: "k8s",
    }));
  },
};
