// DNS: Cloud DNS private zone for cross-cluster CockroachDB discovery.
// ExternalDNS in each cluster registers pod IPs as A records (e.g., cockroachdb-0.east.crdb.internal).
// Visible to all 3 GKE clusters since they share the same VPC.

import { DNSManagedZone } from "@intentius/chant-lexicon-gcp";
import { INTERNAL_DOMAIN } from "../config";

export const privateDnsZone = new DNSManagedZone({
  metadata: {
    name: "crdb-internal",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  dnsName: `${INTERNAL_DOMAIN}.`,
  description: "CockroachDB cross-region discovery — managed by chant",
  visibility: "private",
  privateVisibilityConfig: {
    networks: [
      { networkRef: { name: "crdb-multi-region" } },
    ],
  },
});
