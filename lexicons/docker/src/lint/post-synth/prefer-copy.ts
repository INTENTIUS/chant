/**
 * DKRD011: Prefer COPY over ADD
 *
 * ADD has surprising behavior (auto-extracts archives, fetches URLs).
 * Use COPY when you just need to copy local files.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { extractDockerfiles } from "./docker-helpers";

function looksLikeUrl(src: string): boolean {
  return src.startsWith("http://") || src.startsWith("https://") || src.startsWith("ftp://");
}

function looksLikeArchive(src: string): boolean {
  return /\.(tar|tar\.gz|tgz|tar\.bz2|tar\.xz|zip)$/i.test(src);
}

export const dkrd011: PostSynthCheck = {
  id: "DKRD011",
  description: "Prefer COPY over ADD when not fetching URLs or extracting archives",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_outputName, output] of ctx.outputs) {
      const dockerfiles = extractDockerfiles(output);

      for (const [fileName, content] of dockerfiles) {
        const lines = content.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (/^ADD\s+/.test(trimmed)) {
            // Extract src argument (first token after ADD)
            const parts = trimmed.replace(/^ADD\s+/, "").split(/\s+/);
            const src = parts[0];

            if (!looksLikeUrl(src) && !looksLikeArchive(src)) {
              diagnostics.push({
                checkId: "DKRD011",
                severity: "info",
                message: `${fileName}: Use COPY instead of ADD when not fetching URLs or extracting archives. ADD "${src}" could be COPY.`,
                lexicon: "docker",
              });
            }
          }
        }
      }
    }

    return diagnostics;
  },
};
