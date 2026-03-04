// DNS: Azure DNS zone for aks.crdb.intentius.io.
// After deploy, delegate NS records at your registrar.

import { DnsZone } from "@intentius/chant-lexicon-azure";

export const dnsZone = new DnsZone({
  name: "aks.crdb.intentius.io",
  location: "global",
  tags: { "managed-by": "chant" },
});
