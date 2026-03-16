/**
 * WAW025: SNS Topic Not Encrypted
 *
 * Flags SNS topics without KmsMasterKeyId.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

export function checkSnsEncryption(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::SNS::Topic") continue;

      const props = resource.Properties ?? {};
      if (!("KmsMasterKeyId" in props)) {
        diagnostics.push({
          checkId: "WAW025",
          severity: "warning",
          message: `SNS topic "${logicalId}" is not encrypted — add KmsMasterKeyId for encryption at rest`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw025: PostSynthCheck = {
  id: "WAW025",
  description: "SNS topic is not encrypted — add KmsMasterKeyId for encryption at rest",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkSnsEncryption(ctx);
  },
};
