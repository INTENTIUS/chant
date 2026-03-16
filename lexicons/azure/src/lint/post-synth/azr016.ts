/**
 * AZR016: Key Vault soft-delete not enabled
 *
 * Warns when a Key Vault does not have soft-delete enabled.
 * Soft delete is required to protect against accidental deletion
 * of keys, secrets, and certificates.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const KEY_VAULT_TYPE = "Microsoft.KeyVault/vaults";

export const azr016: PostSynthCheck = {
  id: "AZR016",
  description: "Key Vault soft-delete not enabled — enable to protect against accidental deletion",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== KEY_VAULT_TYPE) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);
        const props = resource.properties ?? {};

        if (props.enableSoftDelete !== true) {
          diagnostics.push({
            checkId: "AZR016",
            severity: "warning",
            message: `Key Vault "${resourceName}" does not have soft-delete enabled — set enableSoftDelete to true`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
