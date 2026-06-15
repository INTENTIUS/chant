/**
 * WFJ011: GitHub-hosted runner label.
 *
 * `runs-on` labels like `macos-latest` / `windows-latest` name GitHub-hosted
 * runners that don't exist on Forgejo, and `ubuntu-*` labels that the dialect
 * didn't map (e.g. when mapping is overridden away) won't be advertised by a
 * default Forgejo runner. Flags any such label that survives into the output.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput } from "@intentius/chant/lint/post-synth";
import { extractRunsOnByJob } from "@intentius/chant-lexicon-github/lint/post-synth/yaml-helpers";

/** Labels that name a GitHub-hosted runner image (no fixed Forgejo equivalent). */
const GITHUB_HOSTED = /^(ubuntu|macos|windows)-/;

export const wfj011: PostSynthCheck = {
  id: "WFJ011",
  description: "GitHub-hosted runner label with no Forgejo equivalent",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const [job, labels] of extractRunsOnByJob(yaml)) {
        for (const label of labels) {
          if (GITHUB_HOSTED.test(label)) {
            diagnostics.push({
              checkId: "WFJ011",
              severity: "warning",
              message: `Job "${job}" runs on '${label}', a GitHub-hosted runner label with no Forgejo equivalent. Map it via forgejo.runnerLabels or target a label your Forgejo runners advertise.`,
              entity: job,
              lexicon: "forgejo",
            });
          }
        }
      }
    }
    return diagnostics;
  },
};
