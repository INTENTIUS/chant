/**
 * WHM204: Dependencies should use semver ranges.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getChartFiles } from "./helm-helpers";

const SEMVER_RANGE_PATTERN = /^[~^>=<*]|\.x/;

export const whm204: PostSynthCheck = {
  id: "WHM204",
  description: "Chart dependencies should use semver ranges, not pinned versions",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const files = getChartFiles(output);
      const chartYaml = files["Chart.yaml"];
      if (!chartYaml) continue;

      // Simple extraction of dependency versions from Chart.yaml
      const lines = chartYaml.split("\n");
      let inDependencies = false;
      let currentDep = "";

      for (const line of lines) {
        if (line.startsWith("dependencies:")) {
          inDependencies = true;
          continue;
        }
        if (inDependencies) {
          if (/^\S/.test(line) && !line.startsWith(" ")) {
            inDependencies = false;
            continue;
          }

          const nameMatch = line.match(/name:\s*(.+)/);
          if (nameMatch) currentDep = nameMatch[1].trim();

          const versionMatch = line.match(/version:\s*'?([^']+)'?/);
          if (versionMatch && currentDep) {
            const version = versionMatch[1].trim();
            if (!SEMVER_RANGE_PATTERN.test(version)) {
              diagnostics.push({
                checkId: "WHM204",
                severity: "info",
                message: `Dependency "${currentDep}" uses pinned version "${version}" — consider a semver range (e.g. "~${version}" or "^${version}")`,
                entity: currentDep,
                lexicon: "helm",
              });
            }
          }
        }
      }
    }

    return diagnostics;
  },
};
