/**
 * WAW018: S3 Public Access Not Blocked
 *
 * Flags S3 buckets missing PublicAccessBlockConfiguration or with any flag set to false.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

const REQUIRED_FLAGS = [
  "BlockPublicAcls",
  "BlockPublicPolicy",
  "IgnorePublicAcls",
  "RestrictPublicBuckets",
] as const;

export function checkS3PublicAccess(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::S3::Bucket") continue;

      const props = resource.Properties ?? {};
      const pab = props.PublicAccessBlockConfiguration;

      if (!pab) {
        diagnostics.push({
          checkId: "WAW018",
          severity: "error",
          message: `S3 bucket "${logicalId}" is missing PublicAccessBlockConfiguration — all public access should be blocked`,
          entity: logicalId,
          lexicon: "aws",
        });
        continue;
      }

      if (isIntrinsic(pab)) continue;

      if (typeof pab === "object" && pab !== null) {
        const config = pab as Record<string, unknown>;
        for (const flag of REQUIRED_FLAGS) {
          const value = config[flag];
          if (value === false) {
            diagnostics.push({
              checkId: "WAW018",
              severity: "error",
              message: `S3 bucket "${logicalId}" has ${flag} set to false — all public access should be blocked`,
              entity: logicalId,
              lexicon: "aws",
            });
          }
        }
      }
    }
  }

  return diagnostics;
}

export const waw018: PostSynthCheck = {
  id: "WAW018",
  description: "S3 bucket missing public access block — all public access should be blocked",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkS3PublicAccess(ctx);
  },
};
