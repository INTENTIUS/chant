/**
 * GHA055: Runtime Install of a Tool Already on the Runner
 *
 * Flags a `run:` step that installs (apt/brew/apk/choco) a tool that GitHub-
 * hosted runners already ship. The redundant install adds a third-party
 * download and supply-chain surface for no benefit and slows the job. Advisory;
 * irrelevant on self-hosted runners that may lack the tool.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractRunBlocks } from "./yaml-helpers";
import { PREINSTALLED_TOOLS } from "../rules/data/preinstalled-tools";

const INSTALL_RE = /\b(?:apt(?:-get)?\s+install|brew\s+install|apk\s+add|choco\s+install)\b([^\n]*)/g;

export const gha055: PostSynthCheck = {
  id: "GHA055",
  description: "Runtime install of a tool already present on the runner",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const preinstalled = new Set(PREINSTALLED_TOOLS);

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, run } of extractRunBlocks(yaml)) {
        const redundant = new Set<string>();
        let m: RegExpExecArray | null;
        INSTALL_RE.lastIndex = 0;
        while ((m = INSTALL_RE.exec(run)) !== null) {
          for (const tok of m[1].split(/\s+/)) {
            const name = tok.replace(/[^\w.+-]/g, "");
            if (name && preinstalled.has(name)) redundant.add(name);
          }
        }
        if (redundant.size > 0) {
          diagnostics.push({
            checkId: "GHA055",
            severity: "info",
            message: `Job "${job}" installs ${[...redundant].join(", ")} at runtime, but GitHub-hosted runners already ship ${redundant.size > 1 ? "these tools" : "this tool"}. Drop the redundant install (or rely on the preinstalled version) to reduce supply-chain surface.`,
            entity: job,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
