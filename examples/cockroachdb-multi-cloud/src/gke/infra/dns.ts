// DNS: Cloud DNS managed zone for gke.crdb.intentius.io.
// After deploy, delegate NS records at your registrar.

import { DNSManagedZone } from "@intentius/chant-lexicon-gcp";

export const dnsZone = new DNSManagedZone({
  metadata: {
    name: "gke-cockroachdb-zone",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  dnsName: "gke.crdb.intentius.io.",
  description: "CockroachDB GKE UI — managed by chant",
});
