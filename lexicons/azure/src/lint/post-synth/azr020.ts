/**
 * AZR020: App Service missing managed identity
 *
 * Warns when a Web App does not have a managed identity configured.
 * Managed identity eliminates the need for credentials in code
 * and enables secure access to Azure services.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const WEB_APP_TYPE = "Microsoft.Web/sites";

export const azr020: PostSynthCheck = {
  id: "AZR020",
  description: "App Service missing managed identity — enable SystemAssigned or UserAssigned identity",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== WEB_APP_TYPE) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);
        const identity = resource.identity as Record<string, unknown> | undefined;

        if (!identity || !identity.type) {
          diagnostics.push({
            checkId: "AZR020",
            severity: "warning",
            message: `App Service "${resourceName}" does not have managed identity configured — set identity.type to "SystemAssigned" or "UserAssigned"`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
