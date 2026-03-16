/**
 * WAW028: EBS Volume Not Encrypted
 *
 * Flags EBS volumes without Encrypted: true.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

export function checkEbsEncryption(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::EC2::Volume") continue;

      const props = resource.Properties ?? {};
      const encrypted = props.Encrypted;

      if (isIntrinsic(encrypted)) continue;

      if (encrypted !== true) {
        diagnostics.push({
          checkId: "WAW028",
          severity: "warning",
          message: `EBS volume "${logicalId}" does not have Encrypted: true — enable encryption at rest`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw028: PostSynthCheck = {
  id: "WAW028",
  description: "EBS volume is not encrypted — enable encryption at rest",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkEbsEncryption(ctx);
  },
};
