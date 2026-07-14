/**
 * WAW043: KMS Key Rotation Disabled
 *
 * Flags customer-managed KMS keys without EnableKeyRotation: true. Skips
 * asymmetric/HMAC keys (a non-default KeySpec) — AWS does not support
 * automatic rotation for those.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

function supportsRotation(props: Record<string, unknown>): boolean {
  const keySpec = props.KeySpec;
  if (keySpec === undefined) return true; // default is SYMMETRIC_DEFAULT
  if (isIntrinsic(keySpec)) return false; // can't statically verify — don't guess
  return keySpec === "SYMMETRIC_DEFAULT";
}

export function checkKmsKeyRotation(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::KMS::Key") continue;

      const props = resource.Properties ?? {};
      if (!supportsRotation(props)) continue;

      const rotation = props.EnableKeyRotation;
      if (isIntrinsic(rotation)) continue;

      if (rotation !== true) {
        diagnostics.push({
          checkId: "WAW043",
          severity: "warning",
          message: `KMS key "${logicalId}" does not have EnableKeyRotation: true — enable automatic annual key rotation`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw043: PostSynthCheck = {
  id: "WAW043",
  description: "KMS customer-managed key does not have automatic key rotation enabled",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkKmsKeyRotation(ctx);
  },
};
