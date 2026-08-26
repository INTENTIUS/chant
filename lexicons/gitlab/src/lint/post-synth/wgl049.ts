/**
 * WGL049: Dependency Install Without a Cache
 *
 * Flags a job whose `script:` runs a package-manager install command (`npm
 * ci`, `pip install`, `bundle install`, etc.) with no `cache:` in scope —
 * neither on the job itself, nor at the pipeline's `default:`/top level.
 * Every run re-fetches the same dependencies from a cold cache. A job that
 * `extends:` another config is left alone — the cache may be inherited and
 * this check has no way to confirm that. Efficiency (#444), not a
 * correctness or security issue.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs, extractJobSection } from "./yaml-helpers";

const DEP_INSTALL_RE = /\b(npm (install|ci)|yarn install|pnpm install|pip install|pip3 install|bundle install|composer install|go mod download|mvn (install|dependency:resolve))\b/i;

function hasPipelineWideCache(yaml: string): boolean {
  const sections = yaml.split("\n\n");
  if (sections.some((s) => /^cache:/.test(s))) return true;
  const defaultSection = sections.find((s) => /^default:/.test(s));
  return !!defaultSection && /\n\s+cache:/.test(defaultSection);
}

export const wgl049: PostSynthCheck = {
  id: "WGL049",
  description: "Job installs dependencies with no cache: in scope",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      if (hasPipelineWideCache(yaml)) continue;

      for (const [jobName, job] of extractJobs(yaml)) {
        if (jobName.startsWith(".")) continue; // hidden/template job, not run directly
        if (job.extends && job.extends.length > 0) continue; // cache may be inherited; can't confirm

        const section = extractJobSection(yaml, jobName);
        if (!section) continue;
        if (/^\s+cache:/m.test(section)) continue; // job-level cache present
        if (!DEP_INSTALL_RE.test(section)) continue;

        diagnostics.push({
          checkId: "WGL049",
          severity: "info",
          message: `Job "${jobName}" installs dependencies with no cache: in scope — every run re-fetches from the registry. Add a cache: covering the dependency directory.`,
          entity: jobName,
          lexicon: "gitlab",
        });
      }
    }

    return diagnostics;
  },
};
