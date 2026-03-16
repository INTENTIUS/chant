/**
 * WAW022: Lambda Not in VPC
 *
 * Flags Lambda functions without VpcConfig.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

export function checkLambdaVpc(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::Lambda::Function") continue;

      const props = resource.Properties ?? {};
      if (!("VpcConfig" in props)) {
        diagnostics.push({
          checkId: "WAW022",
          severity: "warning",
          message: `Lambda function "${logicalId}" is not configured with a VPC — consider adding VpcConfig for network isolation`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw022: PostSynthCheck = {
  id: "WAW022",
  description: "Lambda function is not configured with a VPC — consider adding VpcConfig for network isolation",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkLambdaVpc(ctx);
  },
};
