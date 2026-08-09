/**
 * FLUX003: Kustomization.spec.dependsOn entries should name declared Kustomizations
 *
 * `dependsOn` is Flux's reconcile-ordering edge: the Kustomization stays
 * pending until every named Kustomization is ready. The names are plain
 * strings with no referential integrity — a typo, or an entry left behind
 * after a rename, stalls the app silently. This check joins each entry
 * against the Kustomizations the build actually declares.
 *
 * It is a warning, not an error: estates legitimately split infra and apps
 * across repos, so a dependency (say `cert-manager`) may be declared by a
 * build this one never sees. A self-referencing entry is flagged too — Flux
 * can never satisfy it.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { allManifests, manifestsOfKind } from "./argo-helpers";
import type { K8sManifest } from "./k8s-helpers";

/** Flux Kustomizations only — the kustomize.config.k8s.io kind shares the name. */
function fluxKustomizations(manifests: K8sManifest[]): K8sManifest[] {
  return manifestsOfKind(manifests, "Kustomization").filter((m) => {
    const apiVersion = m.apiVersion;
    return typeof apiVersion !== "string" || apiVersion.startsWith("kustomize.toolkit.fluxcd.io/");
  });
}

export const flux003: PostSynthCheck = {
  id: "FLUX003",
  description: "Kustomization.spec.dependsOn entries should name Kustomizations declared in the build",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const kustomizations = fluxKustomizations(allManifests(ctx));

    const declared = new Set(
      kustomizations
        .map((k) => k.metadata?.name)
        .filter((n): n is string => typeof n === "string"),
    );

    for (const kustomization of kustomizations) {
      const name = kustomization.metadata?.name ?? "Kustomization";
      const dependsOn = kustomization.spec?.dependsOn;
      if (!Array.isArray(dependsOn)) continue;

      for (const entry of dependsOn) {
        const depName = (entry as { name?: unknown } | null)?.name;
        if (typeof depName !== "string" || depName === "") continue;

        if (depName === name) {
          diagnostics.push({
            checkId: "FLUX003",
            severity: "warning",
            message: `Kustomization "${name}" depends on itself — Flux can never satisfy the edge and the app will not reconcile.`,
            entity: name,
            lexicon: "k8s",
          });
          continue;
        }

        if (declared.has(depName)) continue;

        diagnostics.push({
          checkId: "FLUX003",
          severity: "warning",
          message: `Kustomization "${name}" depends on Kustomization "${depName}", which nothing in the build declares — reconciliation stalls until it exists. Fix the name, or ignore if it is declared in another repo.`,
          entity: name,
          lexicon: "k8s",
        });
      }
    }

    return diagnostics;
  },
};
