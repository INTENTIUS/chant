/**
 * AZR014: Public Blob Access Enabled
 *
 * Warns when a Storage Account has allowBlobPublicAccess set to true
 * or when the property is missing (defaults to true in older API versions).
 * Public blob access can expose data to the internet.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const STORAGE_ACCOUNT_TYPE = "Microsoft.Storage/storageAccounts";

export const azr014: PostSynthCheck = {
  id: "AZR014",
  description: "Public blob access enabled on storage account — disable allowBlobPublicAccess to prevent public data exposure",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== STORAGE_ACCOUNT_TYPE) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);
        const props = resource.properties ?? {};

        // allowBlobPublicAccess defaults to true in older API versions
        // It should be explicitly set to false
        const allowBlobPublicAccess = props.allowBlobPublicAccess;

        if (allowBlobPublicAccess === true) {
          diagnostics.push({
            checkId: "AZR014",
            severity: "warning",
            message: `Storage account "${resourceName}" has allowBlobPublicAccess set to true — disable public blob access`,
            entity: resourceName,
            lexicon: "azure",
          });
        } else if (allowBlobPublicAccess === undefined) {
          diagnostics.push({
            checkId: "AZR014",
            severity: "warning",
            message: `Storage account "${resourceName}" does not set allowBlobPublicAccess — explicitly set to false to prevent public access`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
