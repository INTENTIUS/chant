// DNS: Cloud DNS managed zone for the GKE CockroachDB UI subdomain.
// After deploy, delegate NS records at your registrar.

import { DNSManagedZone } from "@intentius/chant-lexicon-gcp";
import { config } from "../config";

export const dnsZone = new DNSManagedZone({
  metadata: {
    name: "gke-cockroachdb-zone",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  dnsName: `${config.domain}.`,
  description: "CockroachDB GKE UI — managed by chant",
});
