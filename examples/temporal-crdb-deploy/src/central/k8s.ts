/**
 * Central region (us-central1) Kubernetes resources.
 *
 * Replaces: k8s/namespace.ts + k8s/storage.ts + k8s/cockroachdb.ts +
 *           k8s/external-secrets.ts + k8s/ingress.ts + k8s/tls.ts +
 *           k8s/backend-config.ts + k8s/monitoring.ts  (8 files → 1 call)
 */

import { CockroachDbRegionStack } from "@intentius/chant-lexicon-k8s";
import { GCP_PROJECT_ID, CRDB_DOMAIN, INTERNAL_DOMAIN, CRDB_CLUSTER, ALL_CIDRS } from "../shared/config";

export const central = CockroachDbRegionStack({
  region: "central",
  namespace: "crdb-central",
  domain: `central.${CRDB_DOMAIN}`,
  internalDomain: `central.${INTERNAL_DOMAIN}`,
  publicRootDomain: CRDB_DOMAIN,

  projectId: GCP_PROJECT_ID,
  clusterName: "gke-crdb-central",
  clusterRegion: "us-central1",
  crdbGsaEmail: `gke-crdb-central-crdb@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
  externalDnsGsaEmail: `gke-crdb-central-dns@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,

  cockroachdb: {
    ...CRDB_CLUSTER,
    locality: "cloud=gcp,region=us-central1",
    skipInit: true,
    mountClientCerts: true,
    advertiseHostDomain: `central.${INTERNAL_DOMAIN}`,
    extraCertNodeAddresses: [
      `cockroachdb-0.central.${INTERNAL_DOMAIN}`,
      `cockroachdb-1.central.${INTERNAL_DOMAIN}`,
      `cockroachdb-2.central.${INTERNAL_DOMAIN}`,
    ],
  },

  tls: {
    gcpSecretNames: {
      ca:            "crdb-ca-crt",
      nodeCrt:       "crdb-node-crt",
      nodeKey:       "crdb-node-key",
      clientRootCrt: "crdb-client-root-crt",
      clientRootKey: "crdb-client-root-key",
    },
  },

  quota: { cpu: "8", memory: "20Gi", maxPods: 25 },
  allowCidrs: ALL_CIDRS,
  cloudArmor: { policyName: "crdb-ui-waf" },
  monitoring: true,
});
