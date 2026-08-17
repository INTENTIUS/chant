// The three regional slices, locally.
//
// This is CockroachDbCluster rather than CockroachDbRegionStack, and the
// difference is the point: everything CockroachDbRegionStack adds on top is
// GKE — External Secrets against Secret Manager, a GCE Ingress with a
// Google-managed certificate, Cloud Armor, ExternalDNS writing to Cloud DNS,
// Workload Identity annotations. None of that exists in k3d, and faking it
// would test the fake.
//
// What is shared with the real thing, and what this therefore covers:
//   - the same StatefulSet, services, RBAC and PDB the GKE path emits
//   - secure mode on a shared CA, node certs distributed out of band
//   - one region initialises, the other two join
//   - advertiseHostDomain, so nodes gossip over a name rather than $(hostname -f)
//   - three distinct localities, which is what multi-region SQL is built on

import { CockroachDbCluster, NamespaceEnv } from "@intentius/chant-lexicon-k8s";
import { JOIN_ADDRESSES, LOCAL_CRDB, NODE_ADDRESSES } from "./config";

const east = NamespaceEnv({ name: "crdb-east" });
const central = NamespaceEnv({ name: "crdb-central" });
const west = NamespaceEnv({ name: "crdb-west" });

export const eastNamespace = east.namespace;
export const centralNamespace = central.namespace;
export const westNamespace = west.namespace;

// No default-deny policy: k3s runs flannel, which does not enforce
// NetworkPolicy at all. Emitting one would read as coverage it isn't.

export const eastCrdb = CockroachDbCluster({
  ...LOCAL_CRDB,
  namespace: "crdb-east",
  locality: "cloud=k3d,region=us-east4",
  joinAddresses: JOIN_ADDRESSES,
  secure: true,
  // The shared CA is generated once and pushed into all three namespaces by
  // the Op's Certificates phase — a per-region cert-gen Job would mint three
  // different CAs and nothing would trust anything.
  skipCertGen: true,
  advertiseHostDomain: "cockroachdb.crdb-east.svc.cluster.local",
  extraCertNodeAddresses: NODE_ADDRESSES.east,
  // ClusterRole and ClusterRoleBinding are cluster-scoped, and the composite
  // names both after the cluster — which is `cockroachdb` in all three regions.
  // On GKE each region is its own cluster so that never collides; here all
  // three land in one, and the last binding applied would be the only one that
  // took, quietly leaving two regions without CSR permission.
  defaults: {
    clusterRole: { metadata: { name: "cockroachdb-east" } },
    clusterRoleBinding: {
      metadata: { name: "cockroachdb-east" },
      roleRef: { name: "cockroachdb-east" },
    },
  },
  // East initialises; it needs a client cert to do it.
  mountClientCerts: true,
});

export const centralCrdb = CockroachDbCluster({
  ...LOCAL_CRDB,
  namespace: "crdb-central",
  locality: "cloud=k3d,region=us-central1",
  joinAddresses: JOIN_ADDRESSES,
  secure: true,
  skipCertGen: true,
  skipInit: true,
  advertiseHostDomain: "cockroachdb.crdb-central.svc.cluster.local",
  extraCertNodeAddresses: NODE_ADDRESSES.central,
  // Cluster-scoped, so it needs a per-region name — see east above.
  defaults: {
    clusterRole: { metadata: { name: "cockroachdb-central" } },
    clusterRoleBinding: {
      metadata: { name: "cockroachdb-central" },
      roleRef: { name: "cockroachdb-central" },
    },
  },
});

export const westCrdb = CockroachDbCluster({
  ...LOCAL_CRDB,
  namespace: "crdb-west",
  locality: "cloud=k3d,region=us-west1",
  joinAddresses: JOIN_ADDRESSES,
  secure: true,
  skipCertGen: true,
  skipInit: true,
  advertiseHostDomain: "cockroachdb.crdb-west.svc.cluster.local",
  extraCertNodeAddresses: NODE_ADDRESSES.west,
  // Cluster-scoped, so it needs a per-region name — see east above.
  defaults: {
    clusterRole: { metadata: { name: "cockroachdb-west" } },
    clusterRoleBinding: {
      metadata: { name: "cockroachdb-west" },
      roleRef: { name: "cockroachdb-west" },
    },
  },
});
