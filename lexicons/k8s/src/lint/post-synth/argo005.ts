/**
 * ARGO005: Application source.path should point at an existing directory (warn)
 *
 * When an Argo `Application` syncs from a git source it names a `source.path`
 * inside the repo. In the common monorepo layout — Argo watches the same repo
 * Chant builds — that path is relative to the build root, so a typo'd or moved
 * path surfaces as a sync error only after deploy. This check warns when the
 * path doesn't resolve to a directory under the build root.
 *
 * It is a warning, not an error: Applications that sync from a *different*
 * remote repo legitimately reference paths that don't exist locally. Helm chart
 * sources (`source.chart`) and pathless sources are skipped.
 */
import { existsSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { allManifests, manifestsOfKind } from "./argo-helpers";

function dirExists(path: string): boolean {
  try {
    const full = isAbsolute(path) ? path : resolve(process.cwd(), path);
    return existsSync(full) && statSync(full).isDirectory();
  } catch {
    return false;
  }
}

export const argo005: PostSynthCheck = {
  id: "ARGO005",
  description: "Application source.path should resolve to an existing directory under the build root",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const app of manifestsOfKind(allManifests(ctx), "Application")) {
      const name = app.metadata?.name ?? "Application";
      const source = app.spec?.source as
        | { path?: unknown; chart?: unknown }
        | undefined;
      if (!source) continue;
      // Helm chart sources have no filesystem path.
      if (typeof source.chart === "string" && source.chart !== "") continue;

      const path = source.path;
      if (typeof path !== "string" || path === "") continue;
      if (dirExists(path)) continue;

      diagnostics.push({
        checkId: "ARGO005",
        severity: "warning",
        message: `Application "${name}" source.path "${path}" does not resolve to a directory under the build root. Confirm the path (or ignore if it lives in a different repo).`,
        entity: name,
        lexicon: "k8s",
      });
    }

    return diagnostics;
  },
};
