/**
 * AZR025: AKS missing RBAC
 *
 * Warns when an AKS cluster does not have RBAC enabled.
 * RBAC provides fine-grained access control for Kubernetes
 * resources within the cluster.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const AKS_TYPE = "Microsoft.ContainerService/managedClusters";

export const azr025: PostSynthCheck = {
  id: "AZR025",
  description: "AKS cluster missing RBAC — enable Kubernetes RBAC for access control",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== AKS_TYPE) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);
        const props = resource.properties ?? {};

        if (props.enableRBAC !== true) {
          diagnostics.push({
            checkId: "AZR025",
            severity: "warning",
            message: `AKS cluster "${resourceName}" does not have RBAC enabled — set enableRBAC to true`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
