/**
 * WAW026: SQS Queue Not Encrypted
 *
 * Flags SQS queues without SqsManagedSseEnabled or KmsMasterKeyId.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

export function checkSqsEncryption(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::SQS::Queue") continue;

      const props = resource.Properties ?? {};
      const hasSseSqs = props.SqsManagedSseEnabled === true;
      const hasKms = "KmsMasterKeyId" in props;

      if (!hasSseSqs && !hasKms) {
        diagnostics.push({
          checkId: "WAW026",
          severity: "warning",
          message: `SQS queue "${logicalId}" is not encrypted — enable SqsManagedSseEnabled or set KmsMasterKeyId`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw026: PostSynthCheck = {
  id: "WAW026",
  description: "SQS queue is not encrypted — enable SqsManagedSseEnabled or set KmsMasterKeyId",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkSqsEncryption(ctx);
  },
};
