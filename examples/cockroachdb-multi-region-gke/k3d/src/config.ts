// Local shape of the estate: three CockroachDB regions in three namespaces of
// one k3d cluster, instead of three GKE clusters in three GCP regions.
//
// One cluster rather than three is a deliberate limit. Cross-CLUSTER gossip —
// the advertise-host problem that cost this example a day of debugging in
// production — needs three, plus something standing in for Cloud DNS, plus
// roughly triple the memory. What one cluster does prove is everything short
// of that: the manifests apply, a secure cluster forms across three localities
// on a shared CA, and multi-region SQL works.
//
// So the addresses below are cluster-local FQDNs, which resolve across
// namespaces in one cluster the same way crdb.internal names resolve across
// three. Everything else about the topology is the same shape.

export const CLUSTER = "crdb-smoke";

export const REGIONS = [
  { short: "east", namespace: "crdb-east", locality: "cloud=k3d,region=us-east4" },
  { short: "central", namespace: "crdb-central", locality: "cloud=k3d,region=us-central1" },
  { short: "west", namespace: "crdb-west", locality: "cloud=k3d,region=us-west1" },
];

/** `<pod>.<headless service>.<namespace>.svc.cluster.local` — one per region. */
export const NODE_ADDRESSES = {
  east: ["cockroachdb-0.cockroachdb.crdb-east.svc.cluster.local"],
  central: ["cockroachdb-0.cockroachdb.crdb-central.svc.cluster.local"],
  west: ["cockroachdb-0.cockroachdb.crdb-west.svc.cluster.local"],
};

export const JOIN_ADDRESSES = [
  ...NODE_ADDRESSES.east,
  ...NODE_ADDRESSES.central,
  ...NODE_ADDRESSES.west,
];

// One node per region, not three. Three is the quorum CockroachDB needs and
// three is what this gives it — nine would only prove the same thing while
// making the test too heavy to run.
export const LOCAL_CRDB = {
  name: "cockroachdb",
  image: "cockroachdb/cockroach:v24.3.0",
  replicas: 1,
  storageSize: "1Gi",
  cpuLimit: "500m",
  memoryLimit: "1Gi",
  // k3s ships a local-path provisioner; there is no pd-ssd here.
  storageClassName: "local-path",
};
