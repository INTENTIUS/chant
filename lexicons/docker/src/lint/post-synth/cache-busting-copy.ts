/**
 * DKRD013: Whole build context copied before installing dependencies
 *
 * `COPY . .` followed by a dependency install (npm ci, pip install -r,
 * go mod download, ...) in the same stage invalidates the install layer on
 * every source change. Copy the dependency manifests first, install, then
 * copy the rest.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { commandText, eachDockerfile, instrText, stageLabel } from "./docker-helpers";

/** Installs whose inputs are a few manifest files rather than the whole source tree. */
const INSTALL = [
  /\bnpm\s+(ci|install|i)(\s+--?[\w-]+(=\S+)?)*\s*($|&&|;|\|)/m,
  /\byarn(\s+install)?(\s+--[\w-]+)*\s*($|&&|;|\|)/m,
  /\bpnpm\s+(install|i)\b/,
  /\bbun\s+install\b/,
  /\bpip3?\s+install\b[^&;|]*\s-r\s/,
  /\bpoetry\s+install\b/,
  /\buv\s+sync\b/,
  /\bpipenv\s+install\b/,
  /\bgo\s+mod\s+download\b/,
  /\bbundle\s+install\b/,
  /\bcomposer\s+install\b/,
  /\bcargo\s+fetch\b/,
  /\bdotnet\s+restore\b/,
  /\bmvn\b[^&;|]*\bdependency:go-offline\b/,
];

/** `COPY . <dest>` (or `./`) from the build context, not from another stage. */
function copiesWholeContext(value: string): boolean {
  const words = value.split(/\s+/).filter((w) => w.length > 0);
  if (words.some((w) => w.startsWith("--from"))) return false;
  const args = words.filter((w) => !w.startsWith("--"));
  if (args[0]?.startsWith("[")) return false;
  return args.slice(0, -1).some((src) => src === "." || src === "./");
}

export const dkrd013: PostSynthCheck = {
  id: "DKRD013",
  description: "Whole build context copied before a dependency install — every source change re-runs the install",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const { fileName, parsed } of eachDockerfile(ctx.outputs)) {
      for (const stage of parsed.stages) {
        const copyAt = stage.instructions.findIndex((i) => i.instruction === "COPY" && copiesWholeContext(i.value));
        if (copyAt === -1) continue;
        const install = stage.instructions.slice(copyAt + 1).find((i) => i.instruction === "RUN" && INSTALL.some((re) => re.test(commandText(i))));
        if (!install) continue;
        diagnostics.push({
          checkId: "DKRD013",
          severity: "warning",
          message: `${fileName} ${stageLabel(stage)}: ${instrText(stage.instructions[copyAt]!)} comes before ${instrText(install)}, so any source change re-runs the install. Copy the dependency manifests first, run the install, then copy the rest.`,
          lexicon: "docker",
        });
      }
    }

    return diagnostics;
  },
};
