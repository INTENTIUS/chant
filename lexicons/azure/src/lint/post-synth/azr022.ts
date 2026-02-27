/**
 * AZR022: App Service missing minimum TLS 1.2
 *
 * Warns when a Web App does not enforce a minimum TLS version of 1.2.
 * Older TLS versions (1.0, 1.1) have known vulnerabilities and should
 * not be used.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const WEB_APP_TYPE = "Microsoft.Web/sites";

export const azr022: PostSynthCheck = {
  id: "AZR022",
  description: "App Service missing minimum TLS 1.2 — set minTlsVersion in siteConfig to enforce TLS 1.2+",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== WEB_APP_TYPE) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);
        const props = resource.properties ?? {};
        const siteConfig = props.siteConfig as Record<string, unknown> | undefined;

        const minTlsVersion = siteConfig?.minTlsVersion;

        if (minTlsVersion !== "1.2" && minTlsVersion !== "1.3") {
          diagnostics.push({
            checkId: "AZR022",
            severity: "warning",
            message: `App Service "${resourceName}" does not enforce minimum TLS 1.2 — set siteConfig.minTlsVersion to "1.2"`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
