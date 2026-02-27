/**
 * AZR021: App Service missing HTTPS-only
 *
 * Warns when a Web App does not enforce HTTPS-only traffic.
 * HTTP traffic can be intercepted and exposes sensitive data.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const WEB_APP_TYPE = "Microsoft.Web/sites";

export const azr021: PostSynthCheck = {
  id: "AZR021",
  description: "App Service missing HTTPS-only — set httpsOnly to true to enforce encrypted traffic",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== WEB_APP_TYPE) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);
        const props = resource.properties ?? {};

        if (props.httpsOnly !== true) {
          diagnostics.push({
            checkId: "AZR021",
            severity: "warning",
            message: `App Service "${resourceName}" does not enforce HTTPS-only — set httpsOnly to true`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
