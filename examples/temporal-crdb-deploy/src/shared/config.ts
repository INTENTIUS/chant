// Shared CockroachDB cluster configuration.
// One logical database cluster spanning 3 GCP regions — 9 nodes total.

export const INTERNAL_DOMAIN = "crdb.internal";

export const CRDB_CLUSTER = {
  name: "cockroachdb",
  image: "cockroachdb/cockroach:v24.3.0",
  replicas: 3,
  storageSize: "10Gi",
  cpuLimit: "500m",
  memoryLimit: "2Gi",
  // All 9 nodes join the same cluster.
  // Each region uses a unique namespace (crdb-east, crdb-central, crdb-west).
  // Cloud DNS private zone (crdb.internal) resolves join addresses across regions.
  joinAddresses: [
    // East nodes (us-east4, namespace: crdb-east)
    `cockroachdb-0.east.${INTERNAL_DOMAIN}`,
    `cockroachdb-1.east.${INTERNAL_DOMAIN}`,
    `cockroachdb-2.east.${INTERNAL_DOMAIN}`,
    // Central nodes (us-central1, namespace: crdb-central)
    `cockroachdb-0.central.${INTERNAL_DOMAIN}`,
    `cockroachdb-1.central.${INTERNAL_DOMAIN}`,
    `cockroachdb-2.central.${INTERNAL_DOMAIN}`,
    // West nodes (us-west1, namespace: crdb-west)
    `cockroachdb-0.west.${INTERNAL_DOMAIN}`,
    `cockroachdb-1.west.${INTERNAL_DOMAIN}`,
    `cockroachdb-2.west.${INTERNAL_DOMAIN}`,
  ],
};

// Base domain for UI ingress. Override with CRDB_DOMAIN env var.
export const CRDB_DOMAIN = process.env.CRDB_DOMAIN ?? "crdb.example.com";

// GCP project ID and number.
export const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID ?? "my-project";
// Project number is needed for Google-managed service agent emails (e.g. GCS service agent).
// Find with: gcloud projects describe $GCP_PROJECT_ID --format='value(projectNumber)'
export const GCP_PROJECT_NUMBER = process.env.GCP_PROJECT_NUMBER ?? "000000000000";

// Resource names for KMS and backups.
export const KMS_KEY_RING = "crdb-multi-region";
export const KMS_CRYPTO_KEY = "crdb-encryption";
export const BACKUP_BUCKET = `${GCP_PROJECT_ID}-crdb-backups`;

// Per-region configuration.
export const REGIONS = {
  east: { region: "us-east4", nodeCidr: "10.1.0.0/20", podCidr: "10.1.16.0/20" },
  central: { region: "us-central1", nodeCidr: "10.2.0.0/20", podCidr: "10.2.16.0/20" },
  west: { region: "us-west1", nodeCidr: "10.3.0.0/20", podCidr: "10.3.16.0/20" },
};

// GKE assigns secondary IP ranges for pods at cluster-creation time.
// These differ from the VPC subnet CIDRs declared in REGIONS above.
// To find the actual values after cluster creation:
//   gcloud container clusters describe gke-crdb-{east|central|west} \
//     --region {us-east4|us-central1|us-west1} \
//     --format="value(clusterIpv4Cidr)"
export const GKE_POD_CIDRS = {
  east:    "10.232.0.0/14",
  central: "10.228.0.0/14",
  west:    "10.88.0.0/14",
};

// All CIDRs for NetworkPolicy allow rules (both VPC subnet CIDRs and GKE pod CIDRs).
// Also used as the source range for the crdb-multi-region-allow-gke-pods firewall rule.
// GCE health check prober ranges are required for GCE Ingress backend health checks.
export const ALL_CIDRS = [
  REGIONS.east.nodeCidr,
  REGIONS.east.podCidr,
  REGIONS.central.nodeCidr,
  REGIONS.central.podCidr,
  REGIONS.west.nodeCidr,
  REGIONS.west.podCidr,
  GKE_POD_CIDRS.east,
  GKE_POD_CIDRS.central,
  GKE_POD_CIDRS.west,
  // GCE health check prober ranges — required for GCE Ingress backend health checks
  "35.191.0.0/16",
  "130.211.0.0/22",
];
