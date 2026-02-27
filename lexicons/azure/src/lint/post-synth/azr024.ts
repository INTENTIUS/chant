/**
 * AZR024: VM missing boot diagnostics
 *
 * Warns when a Virtual Machine does not have boot diagnostics enabled.
 * Boot diagnostics helps troubleshoot VM startup failures by capturing
 * serial console output and screenshots.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const VM_TYPE = "Microsoft.Compute/virtualMachines";

export const azr024: PostSynthCheck = {
  id: "AZR024",
  description: "VM missing boot diagnostics — enable for troubleshooting startup failures",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== VM_TYPE) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);
        const props = resource.properties ?? {};
        const diagnosticsProfile = props.diagnosticsProfile as Record<string, unknown> | undefined;
        const bootDiagnostics = diagnosticsProfile?.bootDiagnostics as Record<string, unknown> | undefined;

        if (!bootDiagnostics || bootDiagnostics.enabled !== true) {
          diagnostics.push({
            checkId: "AZR024",
            severity: "warning",
            message: `VM "${resourceName}" does not have boot diagnostics enabled — set diagnosticsProfile.bootDiagnostics.enabled to true`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
