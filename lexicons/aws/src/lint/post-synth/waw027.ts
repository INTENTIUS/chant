/**
 * WAW027: DynamoDB Missing Point-in-Time Recovery
 *
 * Flags DynamoDB tables without PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

export function checkDynamoDbPitr(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::DynamoDB::Table") continue;

      const props = resource.Properties ?? {};
      const pitrSpec = props.PointInTimeRecoverySpecification;

      let pitrEnabled = false;
      if (typeof pitrSpec === "object" && pitrSpec !== null) {
        pitrEnabled = (pitrSpec as Record<string, unknown>).PointInTimeRecoveryEnabled === true;
      }

      if (!pitrEnabled) {
        diagnostics.push({
          checkId: "WAW027",
          severity: "info",
          message: `DynamoDB table "${logicalId}" does not have point-in-time recovery enabled — consider enabling for data protection`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw027: PostSynthCheck = {
  id: "WAW027",
  description: "DynamoDB table does not have point-in-time recovery enabled",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkDynamoDbPitr(ctx);
  },
};
