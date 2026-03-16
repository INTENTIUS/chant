/**
 * AZR028: Network interface missing NSG
 *
 * Warns when a Network Interface does not have a Network Security Group
 * associated. NSGs provide essential firewall rules to control inbound
 * and outbound traffic.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const NIC_TYPE = "Microsoft.Network/networkInterfaces";

export const azr028: PostSynthCheck = {
  id: "AZR028",
  description: "Network interface missing NSG — associate an NSG to control network traffic",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      for (const resource of template.resources) {
        if (resource.type !== NIC_TYPE) continue;

        const resourceName = typeof resource.name === "string" ? resource.name : String(resource.name);
        const props = resource.properties ?? {};

        if (!props.networkSecurityGroup) {
          diagnostics.push({
            checkId: "AZR028",
            severity: "warning",
            message: `Network interface "${resourceName}" does not have an NSG associated — set networkSecurityGroup.id`,
            entity: resourceName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
