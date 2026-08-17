// Shared CockroachDB cluster configuration.
// One logical database cluster spanning 3 GCP regions — 9 nodes total.

import { params } from "@intentius/chant/params";

export const INTERNAL_DOMAIN = "crdb.internal";

// The nine nodes, by the names ExternalDNS registers in the private zone.
// Each region needs its own three for the node cert's SANs, and all nine as
// join addresses — declared once here rather than in both places.
export const NODE_ADDRESSES = {
  east: [
    `cockroachdb-0.east.${INTERNAL_DOMAIN}`,
    `cockroachdb-1.east.${INTERNAL_DOMAIN}`,
    `cockroachdb-2.east.${INTERNAL_DOMAIN}`,
  ],
  central: [
    `cockroachdb-0.central.${INTERNAL_DOMAIN}`,
    `cockroachdb-1.central.${INTERNAL_DOMAIN}`,
    `cockroachdb-2.central.${INTERNAL_DOMAIN}`,
  ],
  west: [
    `cockroachdb-0.west.${INTERNAL_DOMAIN}`,
    `cockroachdb-1.west.${INTERNAL_DOMAIN}`,
    `cockroachdb-2.west.${INTERNAL_DOMAIN}`,
  ],
};

export const CRDB_CLUSTER = {
  name: "cockroachdb",
  image: "cockroachdb/cockroach:v24.3.0",
  replicas: 3,
  storageSize: "10Gi",
  cpuLimit: "500m",
  memoryLimit: "2Gi",
  // All nine nodes join one logical cluster. Each region has its own namespace
  // (crdb-east / crdb-central / crdb-west), and the private crdb.internal zone
  // is what makes these addresses resolvable from every cluster.
  joinAddresses: [
    ...NODE_ADDRESSES.east,
    ...NODE_ADDRESSES.central,
    ...NODE_ADDRESSES.west,
  ],
};

// Declared in chant.config.ts's buildParams. Supply with --param, --params-file,
// or the env vars in .env; every one has a placeholder default so the example
// builds with nothing set.
export const CRDB_DOMAIN = params.domain as string;
export const GCP_PROJECT_ID = params.projectId as string;
export const GCP_PROJECT_NUMBER = params.projectNumber as string;

// Names the shared stack creates and the regional stacks refer to.
export const KMS_KEY_RING = "crdb-multi-region";
export const KMS_CRYPTO_KEY = "crdb-encryption";
export const BACKUP_BUCKET = `${GCP_PROJECT_ID}-crdb-backups`;
export const WAF_POLICY = "crdb-ui-waf";
export const ESO_GSA = "crdb-eso";

// Secret Manager entries holding the cluster's TLS material. The shared stack
// declares them; CockroachDbRegionStack's ESO wiring reads this same object.
export const CERT_SECRET_NAMES = {
  ca: "crdb-ca-crt",
  nodeCrt: "crdb-node-crt",
  nodeKey: "crdb-node-key",
  clientRootCrt: "crdb-client-root-crt",
  clientRootKey: "crdb-client-root-key",
};

// Per-region configuration.
export const REGION_KEYS = ["east", "central", "west"];

export const REGIONS = {
  east: { region: "us-east4", nodeCidr: "10.1.0.0/20", podCidr: "10.1.16.0/20" },
  central: { region: "us-central1", nodeCidr: "10.2.0.0/20", podCidr: "10.2.16.0/20" },
  west: { region: "us-west1", nodeCidr: "10.3.0.0/20", podCidr: "10.3.16.0/20" },
};

// GKE allocates its own secondary IP ranges for pods, and they are not the pod
// subnet CIDRs declared above. Cross-region gossip therefore has to be allowed
// for these, in two places: the VPC firewall (shared/infra.ts) and every
// region's NetworkPolicy. They used to be written out in both — one list now.
// Find the real ranges with:
//   gcloud compute networks subnets describe <name> --region=<region>
export const GKE_POD_CIDRS = [
  "10.64.0.0/14",   // east   (gke-gke-crdb-east-pods)
  "10.128.0.0/14",  // central (gke-gke-crdb-central-pods)
  "10.84.0.0/14",   // west   (gke-gke-crdb-west-pods)
];

// GCE health check probers — the GCE Ingress backends are unreachable without them.
export const HEALTH_CHECK_CIDRS = ["35.191.0.0/16", "130.211.0.0/22"];

// Everything allowed to reach CockroachDB's ports (26257 gossip/SQL, 8080 UI).
export const ALL_CIDRS = [
  REGIONS.east.nodeCidr,
  REGIONS.east.podCidr,
  REGIONS.central.nodeCidr,
  REGIONS.central.podCidr,
  REGIONS.west.nodeCidr,
  REGIONS.west.podCidr,
  ...GKE_POD_CIDRS,
  ...HEALTH_CHECK_CIDRS,
];
