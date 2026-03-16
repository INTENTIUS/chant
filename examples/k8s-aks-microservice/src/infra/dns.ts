// DNS: Azure DNS Zone for the application domain.

import { DnsZone, Azure } from "@intentius/chant-lexicon-azure";

export const dnsZone = new DnsZone({
  name: "aks-microservice-demo.dev",
  location: "global",
  tags: { "managed-by": "chant" },
});
