// DNS: Cloud DNS managed zone for the application domain.

import { DNSManagedZone } from "@intentius/chant-lexicon-gcp";

export const dnsZone = new DNSManagedZone({
  metadata: {
    name: "gke-microservice-zone",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  dnsName: "gke-microservice-demo.dev.",
  description: "GKE microservice — managed by chant",
});
