// DNS: Cloud DNS public zone for the east CockroachDB UI subdomain.

import { DNSManagedZone } from "@intentius/chant-lexicon-gcp";
import { config } from "../config";

export const dnsZone = new DNSManagedZone({
  metadata: {
    name: "crdb-east-zone",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  dnsName: `${config.domain}.`,
  description: "CockroachDB east UI — managed by chant",
});
