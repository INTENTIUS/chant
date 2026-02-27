/**
 * AZR029: Managed disk missing encryption
 *
 * Warns when a managed disk resource does not have encryption
 * configured. Encryption at rest protects data on managed disks
 * against unauthorized access.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const DISK_TYPE = "Microsoft.Compute/disks";

export const azr029: PostSynthCheck = {
  id: "AZR029",
  description: "Managed disk missing encryption — enable encryption to protect data at rest",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== DISK_TYPE) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);
        const props = resource.properties ?? {};
        const encryption = props.encryption as Record<string, unknown> | undefined;

        if (!encryption) {
          diagnostics.push({
            checkId: "AZR029",
            severity: "warning",
            message: `Managed disk "${resourceName}" does not have encryption configured — set encryption.type to "EncryptionAtRestWithPlatformKey" or use customer-managed keys`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
