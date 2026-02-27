/**
 * AZR017: Key Vault purge protection not enabled
 *
 * Warns when a Key Vault does not have purge protection enabled.
 * Purge protection prevents permanent deletion of soft-deleted vaults
 * and vault objects during the retention period.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const KEY_VAULT_TYPE = "Microsoft.KeyVault/vaults";

export const azr017: PostSynthCheck = {
  id: "AZR017",
  description: "Key Vault purge protection not enabled — enable to prevent permanent deletion during retention period",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== KEY_VAULT_TYPE) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);
        const props = resource.properties ?? {};

        if (props.enablePurgeProtection !== true) {
          diagnostics.push({
            checkId: "AZR017",
            severity: "warning",
            message: `Key Vault "${resourceName}" does not have purge protection enabled — set enablePurgeProtection to true`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
