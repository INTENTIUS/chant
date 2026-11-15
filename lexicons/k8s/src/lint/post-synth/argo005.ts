/**
 * ARGO005: Application source.path should point at an existing directory (warn)
 *
 * When an Argo `Application` syncs from a git source it names a `source.path`
 * inside the repository `source.repoURL` names. This check warns when the path
 * does not resolve to a directory in the tree being read.
 *
 * Which tree depends on the command:
 *
 * - `chant build` and `chant lint` read the project, so a relative path
 *   resolves against the project root (the directory of the project config).
 *   The common monorepo layout, where Argo watches the same repo Chant builds,
 *   is the one this assumes.
 * - `chant audit <dir>` reads a tree that need not be the working directory.
 *   The path resolves against the root of the checkout the audited directory
 *   is in, never the working directory, and only when that checkout's `origin`
 *   remote is the repository `repoURL` names. When the remote names another
 *   repository the path lives in a tree that is not on disk and the check is
 *   silent. A tree with no `origin` (an extracted archive) resolves against
 *   the audited directory. A remote tree fetch has nothing on disk and gets no
 *   findings. The resolution is `resolveRepoPath` in core.
 *
 * It is a warning, not an error: Applications that sync from a *different*
 * remote repo legitimately reference paths that don't exist locally. Helm chart
 * sources (`source.chart`) and pathless sources are skipped.
 */
import { existsSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { resolveRepoPath } from "@intentius/chant/repo-path";
import { allManifests, manifestsOfKind } from "./argo-helpers";

function dirExists(base: string, path: string): boolean {
  try {
    const full = isAbsolute(path) ? path : resolve(base, path);
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
        | { path?: unknown; chart?: unknown; repoURL?: unknown }
        | undefined;
      if (!source) continue;
      // Helm chart sources have no filesystem path.
      if (typeof source.chart === "string" && source.chart !== "") continue;

      const path = source.path;
      if (typeof path !== "string" || path === "") continue;

      let where = "under the build root";
      if (ctx.audit) {
        // No tree on disk (a remote fetch): nothing to resolve against.
        if (ctx.audit.root === undefined) continue;
        const repoURL = typeof source.repoURL === "string" ? source.repoURL : undefined;
        const found = resolveRepoPath(ctx.audit.root, repoURL, path);
        if (found.status !== "missing") continue;
        where = found.path === path ? "in the audited repository" : `in the audited repository (looked for "${found.path}" from its root)`;
      } else if (dirExists(ctx.projectDir ?? process.cwd(), path)) {
        continue;
      }

      diagnostics.push({
        checkId: "ARGO005",
        severity: "warning",
        message: `Application "${name}" source.path "${path}" does not resolve to a directory ${where}. Confirm the path (or ignore if it lives in a different repo).`,
        entity: name,
        lexicon: "k8s",
      });
    }

    return diagnostics;
  },
};
