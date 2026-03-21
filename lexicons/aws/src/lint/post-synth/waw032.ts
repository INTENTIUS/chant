/**
 * WAW032: EFS Transit Encryption Disabled
 *
 * Flags EFS volume configurations on Fargate task definitions where transit
 * encryption has been explicitly disabled. FargateService defaults to ENABLED;
 * this rule catches intentional opt-outs.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

export function checkEfsTransitEncryption(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::ECS::TaskDefinition") continue;

      const volumes = resource.Properties?.Volumes;
      if (!Array.isArray(volumes)) continue;

      for (const volume of volumes) {
        const efsConfig = volume?.EFSVolumeConfiguration;
        if (!efsConfig) continue;

        if (efsConfig.TransitEncryption === "DISABLED") {
          diagnostics.push({
            checkId: "WAW032",
            severity: "warning",
            message: `EFS volume "${volume.Name ?? "unnamed"}" in task "${logicalId}" has transit encryption disabled — set TransitEncryption: ENABLED to protect data in transit`,
            entity: logicalId,
            lexicon: "aws",
          });
        }
      }
    }
  }

  return diagnostics;
}

export const waw032: PostSynthCheck = {
  id: "WAW032",
  description: "EFS volume on Fargate task has transit encryption disabled",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkEfsTransitEncryption(ctx);
  },
};
