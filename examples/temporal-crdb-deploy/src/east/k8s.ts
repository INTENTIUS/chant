/**
 * East region (us-east4) Kubernetes resources.
 *
 * CockroachDbRegionStack creates: namespace, storage, CockroachDB StatefulSet,
 * External Secrets (TLS), GCE Ingress, ExternalDNS, BackendConfig (Cloud Armor),
 * ManagedCertificate, FrontendConfig, and Prometheus monitoring.
 *
 * Replaces: k8s/namespace.ts + k8s/storage.ts + k8s/cockroachdb.ts +
 *           k8s/external-secrets.ts + k8s/ingress.ts + k8s/tls.ts +
 *           k8s/backend-config.ts + k8s/monitoring.ts  (8 files → 1 call)
 */

import { CockroachDbRegionStack } from "@intentius/chant-lexicon-k8s";
import { GCP_PROJECT_ID, CRDB_DOMAIN, INTERNAL_DOMAIN, CRDB_CLUSTER, ALL_CIDRS } from "../shared/config";

export const east = CockroachDbRegionStack({
  region: "east",
  namespace: "crdb-east",
  domain: `east.${CRDB_DOMAIN}`,
  internalDomain: `east.${INTERNAL_DOMAIN}`,
  publicRootDomain: CRDB_DOMAIN,

  projectId: GCP_PROJECT_ID,
  clusterName: "gke-crdb-east",
  clusterRegion: "us-east4",
  crdbGsaEmail: `gke-crdb-east-crdb@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
  externalDnsGsaEmail: `gke-crdb-east-dns@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,

  cockroachdb: {
    ...CRDB_CLUSTER,
    locality: "cloud=gcp,region=us-east4",
    skipInit: false,
    mountClientCerts: true,
    advertiseHostDomain: `east.${INTERNAL_DOMAIN}`,
    extraCertNodeAddresses: [
      `cockroachdb-0.east.${INTERNAL_DOMAIN}`,
      `cockroachdb-1.east.${INTERNAL_DOMAIN}`,
      `cockroachdb-2.east.${INTERNAL_DOMAIN}`,
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
