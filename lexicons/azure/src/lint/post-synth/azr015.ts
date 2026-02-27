/**
 * AZR015: Missing Encryption on Storage Account
 *
 * Warns when a Storage Account does not have encryption configured.
 * Storage accounts should have encryption services enabled for blob,
 * file, table, and queue to protect data at rest.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const STORAGE_ACCOUNT_TYPE = "Microsoft.Storage/storageAccounts";

export const azr015: PostSynthCheck = {
  id: "AZR015",
  description: "Missing encryption on storage account — enable encryption services to protect data at rest",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== STORAGE_ACCOUNT_TYPE) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);
        const props = resource.properties ?? {};
        const encryption = props.encryption as Record<string, unknown> | undefined;

        if (!encryption) {
          diagnostics.push({
            checkId: "AZR015",
            severity: "warning",
            message: `Storage account "${resourceName}" has no encryption configuration — enable encryption services for blob, file, table, and queue`,
            entity: resourceName,
            lexicon: "azure",
          });
          continue;
        }

        // Check that encryption services are defined
        const services = encryption.services as Record<string, unknown> | undefined;
        if (!services) {
          diagnostics.push({
            checkId: "AZR015",
            severity: "warning",
            message: `Storage account "${resourceName}" has encryption configured but no encryption services specified — enable blob, file, table, and queue encryption`,
            entity: resourceName,
            lexicon: "azure",
          });
          continue;
        }

        // Check for blob and file at minimum
        const missingServices: string[] = [];
        if (!services.blob) missingServices.push("blob");
        if (!services.file) missingServices.push("file");

        if (missingServices.length > 0) {
          diagnostics.push({
            checkId: "AZR015",
            severity: "warning",
            message: `Storage account "${resourceName}" is missing encryption for: ${missingServices.join(", ")}`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
