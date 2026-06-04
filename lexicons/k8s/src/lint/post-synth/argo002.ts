/**
 * ARGO002: Application.spec.project must reference a declared AppProject
 *
 * An Argo `Application` names an `AppProject` in `spec.project`; the project is
 * the RBAC and source/destination guardrail. If the named project isn't
 * declared in the build, Argo will reject the Application at sync time. The
 * built-in `default` project always exists on an Argo install, so a reference
 * to `default` is never flagged.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { allManifests, manifestsOfKind } from "./argo-helpers";

export const argo002: PostSynthCheck = {
  id: "ARGO002",
  description: "Application.spec.project must reference a declared AppProject (or the built-in default)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const manifests = allManifests(ctx);

    const declaredProjects = new Set(
      manifestsOfKind(manifests, "AppProject")
        .map((p) => p.metadata?.name)
        .filter((n): n is string => typeof n === "string"),
    );
    // Argo ships a built-in default project.
    declaredProjects.add("default");

    for (const app of manifestsOfKind(manifests, "Application")) {
      const project = app.spec?.project;
      const name = app.metadata?.name ?? "Application";
      // No project set → defaults to `default` at sync time; not this check's job.
      if (typeof project !== "string" || project === "") continue;
      if (declaredProjects.has(project)) continue;

      diagnostics.push({
        checkId: "ARGO002",
        severity: "error",
        message: `Application "${name}" references AppProject "${project}", which is not declared. Add an AppProject named "${project}" or reference an existing project.`,
        entity: name,
        lexicon: "k8s",
      });
    }

    return diagnostics;
  },
};
