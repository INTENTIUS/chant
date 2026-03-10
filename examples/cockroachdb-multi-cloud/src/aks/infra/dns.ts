// DNS: Azure DNS zone for the AKS CockroachDB UI subdomain.
// After deploy, delegate NS records at your registrar.

import { DnsZone } from "@intentius/chant-lexicon-azure";
import { config } from "../config";

export const dnsZone = new DnsZone({
  name: config.domain,
  location: "global",
  tags: { "managed-by": "chant" },
});
