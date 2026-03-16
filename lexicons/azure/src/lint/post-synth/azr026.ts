/**
 * AZR026: AKS missing network policy
 *
 * Warns when an AKS cluster does not have a network policy configured.
 * Network policies control pod-to-pod traffic and are essential for
 * microsegmentation and defense in depth.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const AKS_TYPE = "Microsoft.ContainerService/managedClusters";

export const azr026: PostSynthCheck = {
  id: "AZR026",
  description: "AKS cluster missing network policy — configure networkPolicy for pod-to-pod traffic control",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== AKS_TYPE) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);
        const props = resource.properties ?? {};
        const networkProfile = props.networkProfile as Record<string, unknown> | undefined;

        if (!networkProfile?.networkPolicy) {
          diagnostics.push({
            checkId: "AZR026",
            severity: "warning",
            message: `AKS cluster "${resourceName}" does not have a network policy configured — set networkProfile.networkPolicy to "azure" or "calico"`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
