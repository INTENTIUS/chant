/**
 * The CC lane's canonical example, networking half (chant#1200 / #1214).
 *
 * The same VnetDefault estate the azure drift acceptance rides
 * (test/azure-drift-e2e.sh, #1213): VNet + two subnets + NSG + route table,
 * applied per-resource by `azApply` (floci-az has no deployments provider).
 * The NSG declares one rule so a clean apply proves ARM's echo of a DECLARED
 * rule normalizes away, and the subnets carry real `[resourceId(...)]`
 * cross-references — the applier evaluates them, the diff must not compare the
 * formula to its result.
 */
import { VnetDefault } from "@intentius/chant-lexicon-azure";

export const { virtualNetwork, subnet1, subnet2, nsg, routeTable } = VnetDefault({
  name: "cc-vnet",
  tags: { environment: "cc-e2e" },
  defaults: {
    nsg: {
      securityRules: [
        {
          name: "allow-https",
          properties: {
            priority: 100,
            direction: "Inbound",
            access: "Allow",
            protocol: "Tcp",
            sourcePortRange: "*",
            destinationPortRange: "443",
            sourceAddressPrefix: "203.0.113.0/24",
            destinationAddressPrefix: "*",
          },
        },
      ],
    },
  },
});
