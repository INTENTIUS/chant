/**
 * West region (us-west1) Kubernetes resources.
 *
 * Replaces: k8s/namespace.ts + k8s/storage.ts + k8s/cockroachdb.ts +
 *           k8s/external-secrets.ts + k8s/ingress.ts + k8s/tls.ts +
 *           k8s/backend-config.ts + k8s/monitoring.ts  (8 files → 1 call)
 */

import { CockroachDbRegionStack } from "@intentius/chant-lexicon-k8s";
import { GCP_PROJECT_ID, CRDB_DOMAIN, INTERNAL_DOMAIN, CRDB_CLUSTER, ALL_CIDRS } from "../shared/config";

export const west = CockroachDbRegionStack({
  region: "west",
  namespace: "crdb-west",
  domain: `west.${CRDB_DOMAIN}`,
  internalDomain: `west.${INTERNAL_DOMAIN}`,
  publicRootDomain: CRDB_DOMAIN,

  projectId: GCP_PROJECT_ID,
  clusterName: "gke-crdb-west",
  clusterRegion: "us-west1",
  crdbGsaEmail: `gke-crdb-west-crdb@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
  externalDnsGsaEmail: `gke-crdb-west-dns@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,

  cockroachdb: {
    ...CRDB_CLUSTER,
    locality: "cloud=gcp,region=us-west1",
    skipInit: true,
    mountClientCerts: true,
    advertiseHostDomain: `west.${INTERNAL_DOMAIN}`,
    extraCertNodeAddresses: [
      `cockroachdb-0.west.${INTERNAL_DOMAIN}`,
      `cockroachdb-1.west.${INTERNAL_DOMAIN}`,
      `cockroachdb-2.west.${INTERNAL_DOMAIN}`,
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
