// DNS: Cloud DNS public zone for the central CockroachDB UI subdomain.

import { DNSManagedZone } from "@intentius/chant-lexicon-gcp";
import { config } from "../config";

export const dnsZone = new DNSManagedZone({
  metadata: {
    name: "crdb-central-zone",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  dnsName: `${config.domain}.`,
  description: "CockroachDB central UI — managed by chant",
});
