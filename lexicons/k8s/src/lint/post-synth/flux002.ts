/**
 * FLUX002: Kustomization.spec.sourceRef must reference a declared source
 *
 * A Flux `Kustomization` names its source in `spec.sourceRef` — a
 * `GitRepository`, `OCIRepository`, or `Bucket` the source-controller fetches.
 * If the referenced source isn't declared in the build, the
 * kustomize-controller waits on an artifact that never arrives and the
 * Kustomization stalls. The bootstrap-created `flux-system` GitRepository
 * always exists on a bootstrapped cluster, so a reference to it is never
 * flagged — the Flux analogue of ARGO002's built-in `default` project.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { allManifests, manifestsOfKind } from "./argo-helpers";

/** Source kinds the kustomize-controller can reconcile from. */
const SOURCE_KINDS = ["GitRepository", "OCIRepository", "Bucket"] as const;

/** The GitRepository `flux bootstrap` creates alongside the controllers. */
const BOOTSTRAP_SOURCE_NAME = "flux-system";

export const flux002: PostSynthCheck = {
  id: "FLUX002",
  description: "Kustomization.spec.sourceRef must reference a declared source (or the bootstrap flux-system repo)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const manifests = allManifests(ctx);

    // Declared sources, keyed "Kind/name". Namespace is deliberately ignored:
    // an unset sourceRef.namespace resolves in the Kustomization's own, and
    // the common estate keeps everything in flux-system anyway.
    const declaredSources = new Set<string>();
    for (const kind of SOURCE_KINDS) {
      for (const source of manifestsOfKind(manifests, kind)) {
        const name = source.metadata?.name;
        if (typeof name === "string") declaredSources.add(`${kind}/${name}`);
      }
    }

    for (const kustomization of manifestsOfKind(manifests, "Kustomization")) {
      // Flux and kustomize.config.k8s.io share the kind name; only the Flux CR
      // carries a sourceRef-bearing spec.
      const apiVersion = kustomization.apiVersion;
      if (typeof apiVersion === "string" && !apiVersion.startsWith("kustomize.toolkit.fluxcd.io/")) continue;

      const name = kustomization.metadata?.name ?? "Kustomization";
      const sourceRef = kustomization.spec?.sourceRef as
        | { kind?: unknown; name?: unknown }
        | undefined;

      if (!sourceRef || typeof sourceRef.name !== "string" || sourceRef.name === "") {
        diagnostics.push({
          checkId: "FLUX002",
          severity: "error",
          message: `Kustomization "${name}" has no spec.sourceRef.name — the kustomize-controller cannot resolve a source.`,
          entity: name,
          lexicon: "k8s",
        });
        continue;
      }

      const kind = typeof sourceRef.kind === "string" && sourceRef.kind !== "" ? sourceRef.kind : "GitRepository";
      if (kind === "GitRepository" && sourceRef.name === BOOTSTRAP_SOURCE_NAME) continue;
      if (declaredSources.has(`${kind}/${sourceRef.name}`)) continue;

      diagnostics.push({
        checkId: "FLUX002",
        severity: "error",
        message: `Kustomization "${name}" references ${kind} "${sourceRef.name}", which is not declared. Declare the source (e.g. FluxGitSource) or point sourceRef at the bootstrap flux-system repo.`,
        entity: name,
        lexicon: "k8s",
      });
    }

    return diagnostics;
  },
};
