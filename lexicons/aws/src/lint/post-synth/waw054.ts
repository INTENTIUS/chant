/**
 * WAW054: ECR Tag Mutability Not Immutable
 *
 * Flags ECR repositories without ImageTagMutability: IMMUTABLE — mutable tags
 * let a previously deployed/scanned/signed tag (e.g. "prod") silently point at
 * different image content later.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

export function checkEcrTagImmutability(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::ECR::Repository") continue;

      const props = resource.Properties ?? {};
      const mutability = props.ImageTagMutability;

      if (isIntrinsic(mutability)) continue;

      if (mutability !== "IMMUTABLE") {
        diagnostics.push({
          checkId: "WAW054",
          severity: "error",
          message: `ECR repository "${logicalId}" does not have ImageTagMutability: IMMUTABLE — a tag can silently be repointed at different image content`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw054: PostSynthCheck = {
  id: "WAW054",
  description: "ECR repository does not have immutable image tags",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkEcrTagImmutability(ctx);
  },
};
