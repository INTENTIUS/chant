// Shared CockroachDB cluster configuration.
// One logical database cluster spanning EKS, AKS, and GKE — 9 nodes total.

export const CRDB_CLUSTER = {
  name: "cockroachdb",
  image: "cockroachdb/cockroach:v24.3.0",
  replicas: 3,
  storageSize: "100Gi",
  cpuLimit: "2",
  memoryLimit: "8Gi",
  // All 9 nodes join the same cluster.
  // Each cloud uses a unique namespace (crdb-eks, crdb-aks, crdb-gke).
  // CoreDNS in each cluster forwards queries for peer namespaces via VPN.
  joinAddresses: [
    // EKS nodes (namespace: crdb-eks)
    "cockroachdb-0.cockroachdb.crdb-eks.svc.cluster.local",
    "cockroachdb-1.cockroachdb.crdb-eks.svc.cluster.local",
    "cockroachdb-2.cockroachdb.crdb-eks.svc.cluster.local",
    // AKS nodes (namespace: crdb-aks, resolved via CoreDNS forwarding over VPN)
    "cockroachdb-0.cockroachdb.crdb-aks.svc.cluster.local",
    "cockroachdb-1.cockroachdb.crdb-aks.svc.cluster.local",
    "cockroachdb-2.cockroachdb.crdb-aks.svc.cluster.local",
    // GKE nodes (namespace: crdb-gke, resolved via CoreDNS forwarding over VPN)
    "cockroachdb-0.cockroachdb.crdb-gke.svc.cluster.local",
    "cockroachdb-1.cockroachdb.crdb-gke.svc.cluster.local",
    "cockroachdb-2.cockroachdb.crdb-gke.svc.cluster.local",
  ],
};

// Base domain for UI ingress. Override with CRDB_DOMAIN env var.
export const CRDB_DOMAIN = process.env.CRDB_DOMAIN ?? "crdb.example.com";

// Non-overlapping CIDRs for VPN routing.
export const CIDRS = {
  eks: { vpc: "10.1.0.0/16", service: "172.20.0.0/16", dnsIp: "172.20.0.10" },
  aks: { vpc: "10.2.0.0/16", service: "172.21.0.0/16", dnsIp: "172.21.0.10" },
  gke: { vpc: "10.3.0.0/16", pods: "10.3.128.0/17", service: "172.22.0.0/16", dnsIp: "172.22.0.10" },
};
