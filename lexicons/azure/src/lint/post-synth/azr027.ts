/**
 * AZR027: Container Registry admin user enabled
 *
 * Warns when a Container Registry has the admin user enabled.
 * Admin user provides shared credentials which cannot be individually
 * revoked. Use Azure AD authentication or service principals instead.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const ACR_TYPE = "Microsoft.ContainerRegistry/registries";

export const azr027: PostSynthCheck = {
  id: "AZR027",
  description: "Container Registry admin user enabled — disable admin and use Azure AD or service principals",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== ACR_TYPE) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);
        const props = resource.properties ?? {};

        if (props.adminUserEnabled === true) {
          diagnostics.push({
            checkId: "AZR027",
            severity: "warning",
            message: `Container Registry "${resourceName}" has admin user enabled — disable adminUserEnabled and use Azure AD authentication`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
