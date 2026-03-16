// DNS: Cloud DNS public zone for the west CockroachDB UI subdomain.

import { DNSManagedZone } from "@intentius/chant-lexicon-gcp";
import { config } from "../config";

export const dnsZone = new DNSManagedZone({
  metadata: {
    name: "crdb-west-zone",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  dnsName: `${config.domain}.`,
  description: "CockroachDB west UI — managed by chant",
});
