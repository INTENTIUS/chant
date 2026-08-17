// The central slice of the cluster — 3 of 9 nodes — and everything around it.
//
// CockroachDbRegionStack emits the namespace with its quota, limit range and
// default-deny policy; the pd-ssd StorageClass; the CockroachDB StatefulSet,
// services, RBAC and PDB; the ClusterSecretStore and two ExternalSecrets that
// pull TLS material out of Secret Manager; the managed cert, FrontendConfig
// and GCE Ingress for the UI; the Cloud Armor BackendConfig; ExternalDNS; and
// Prometheus.
//
// A secondary: east initialises the cluster, so `skipInit` keeps this region
// from emitting a second init Job that would race it.

import { CockroachDbRegionStack } from "@intentius/chant-lexicon-k8s";
import {
  ALL_CIDRS,
  CERT_SECRET_NAMES,
  CRDB_DOMAIN,
  NODE_ADDRESSES,
  WAF_POLICY,
} from "../shared/config";
import { config } from "./config";

export const central = CockroachDbRegionStack({
  region: config.regionShort,
  namespace: config.namespace,
  domain: config.domain,
  internalDomain: config.internalDomain,
  publicRootDomain: CRDB_DOMAIN,

  projectId: config.projectId,
  clusterName: config.clusterName,
  clusterRegion: config.region,
  crdbGsaEmail: config.crdbGsaEmail,
  externalDnsGsaEmail: config.externalDnsGsaEmail,

  cockroachdb: {
    name: config.name,
    replicas: config.replicas,
    image: config.image,
    storageSize: config.storageSize,
    cpuLimit: config.cpuLimit,
    memoryLimit: config.memoryLimit,
    locality: config.locality,
    joinAddresses: config.joinAddresses,
    // Pods must advertise a name the other two clusters can resolve.
    // `$(hostname -f)` gives a .svc.cluster.local name, which is local to this
    // cluster only, and gossip across regions then never converges.
    advertiseHostDomain: config.internalDomain,
    extraCertNodeAddresses: NODE_ADDRESSES.central,
    skipInit: true,
  },

  tls: { gcpSecretNames: CERT_SECRET_NAMES },

  quota: { cpu: "8", memory: "20Gi", maxPods: 25 },
  allowCidrs: ALL_CIDRS,
  cloudArmor: { policyName: WAF_POLICY },
  monitoring: true,
});
