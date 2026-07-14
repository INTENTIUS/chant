/**
 * WAW053: ECR Image Scanning Disabled
 *
 * Flags ECR repositories without ImageScanningConfiguration.ScanOnPush: true
 * — pushed images aren't scanned for known CVEs.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic } from "./cf-refs";

export function checkEcrScanOnPush(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::ECR::Repository") continue;

      const props = resource.Properties ?? {};
      const scanConfig = props.ImageScanningConfiguration;

      if (isIntrinsic(scanConfig)) continue;

      const scanOnPush =
        typeof scanConfig === "object" && scanConfig !== null ? (scanConfig as Record<string, unknown>).ScanOnPush : undefined;

      if (isIntrinsic(scanOnPush)) continue;

      if (scanOnPush !== true) {
        diagnostics.push({
          checkId: "WAW053",
          severity: "error",
          message: `ECR repository "${logicalId}" does not have ImageScanningConfiguration.ScanOnPush: true — pushed images aren't scanned for vulnerabilities`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw053: PostSynthCheck = {
  id: "WAW053",
  description: "ECR repository does not scan images on push",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkEcrScanOnPush(ctx);
  },
};
