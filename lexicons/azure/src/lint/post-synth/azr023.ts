/**
 * AZR023: VM missing managed disk
 *
 * Warns when a Virtual Machine's OS disk does not use managed disks.
 * Managed disks provide better reliability, scalability, and
 * simplified management compared to unmanaged (VHD-based) disks.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const VM_TYPE = "Microsoft.Compute/virtualMachines";

export const azr023: PostSynthCheck = {
  id: "AZR023",
  description: "VM missing managed disk — use managed disks for better reliability and management",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== VM_TYPE) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);
        const props = resource.properties ?? {};
        const storageProfile = props.storageProfile as Record<string, unknown> | undefined;
        const osDisk = storageProfile?.osDisk as Record<string, unknown> | undefined;

        if (!osDisk?.managedDisk) {
          diagnostics.push({
            checkId: "AZR023",
            severity: "warning",
            message: `VM "${resourceName}" OS disk does not use managed disks — add managedDisk configuration to storageProfile.osDisk`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
