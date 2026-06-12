/**
 * GHA051: Publish/Release Step Using a Long-Lived Token Instead of OIDC
 *
 * Flags a job that publishes a release/package using a long-lived token secret
 * (`*_TOKEN`, `*_PASSWORD`, `*_API_KEY`) while the workflow requests no
 * `id-token: write` permission. Registries that support OIDC let a workflow mint
 * a short-lived, audience-scoped credential per run instead of holding a
 * standing secret. Advisory — not every registry supports OIDC.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, linesByJob } from "./yaml-helpers";

const PUBLISH_RE = /npm publish|yarn publish|pnpm publish|twine upload|poetry publish|cargo publish|gh release create|docker push|gh-action-pypi-publish|npm-publish/;
const LONG_LIVED_SECRET_RE = /secrets\.(?!GITHUB_TOKEN\b)\w*(TOKEN|PASSWORD|API_KEY|APIKEY)/i;

export const gha051: PostSynthCheck = {
  id: "GHA051",
  description: "Publish/release step using a long-lived token instead of OIDC",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const requestsOidc = /id-token:\s*write/.test(yaml);
      if (requestsOidc) continue;

      for (const [job, lines] of linesByJob(yaml)) {
        const text = lines.join("\n");
        if (PUBLISH_RE.test(text) && LONG_LIVED_SECRET_RE.test(text)) {
          diagnostics.push({
            checkId: "GHA051",
            severity: "info",
            message: `Job "${job}" publishes using a long-lived token secret and requests no id-token: write. If the registry supports OIDC, mint a short-lived federated credential (permissions: id-token: write) instead of holding a standing token.`,
            entity: job,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
