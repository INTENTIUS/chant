/**
 * AZR012: Deprecated API Version
 *
 * Warns when a resource uses an apiVersion older than 2023-01-01.
 * Older API versions may lack features, security patches, and
 * could be deprecated by Azure.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const MINIMUM_API_DATE = "2023-01-01";

export const azr012: PostSynthCheck = {
  id: "AZR012",
  description: "Deprecated API version — apiVersion older than 2023 may lack features and security patches",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);

        if (typeof resource.apiVersion !== "string") continue;

        // Extract the date portion (YYYY-MM-DD) ignoring any suffix like -preview
        const dateMatch = resource.apiVersion.match(/^(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) continue;

        const apiDate = dateMatch[1];
        if (apiDate < MINIMUM_API_DATE) {
          diagnostics.push({
            checkId: "AZR012",
            severity: "warning",
            message: `Resource "${resourceName}" (${resource.type}) uses outdated apiVersion "${resource.apiVersion}" — consider updating to a version from 2023 or later`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
