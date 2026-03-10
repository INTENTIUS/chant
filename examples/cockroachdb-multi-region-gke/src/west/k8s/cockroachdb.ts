// K8s workloads: CockroachDB cluster (west slice — 3 of 9 nodes).
// Headless service annotated for ExternalDNS to register pod IPs in Cloud DNS private zone.

import { CockroachDbCluster } from "@intentius/chant-lexicon-k8s";
import { config } from "../config";
import { INTERNAL_DOMAIN } from "../../shared/config";

const NAMESPACE = "crdb-west";

const crdb = CockroachDbCluster({
  name: config.name,
  namespace: NAMESPACE,
  replicas: config.replicas,
  image: config.image,
  storageSize: config.storageSize,
  storageClassName: "pd-ssd",
  cpuLimit: config.cpuLimit,
  memoryLimit: config.memoryLimit,
  locality: config.locality,
  joinAddresses: config.joinAddresses,
  secure: true,
  labels: {
    "app.kubernetes.io/part-of": "cockroachdb-multi-region",
    "app.kubernetes.io/instance": "west",
  },
  defaults: {
    headlessService: {
      metadata: {
        annotations: {
          "external-dns.alpha.kubernetes.io/hostname": `west.${INTERNAL_DOMAIN}`,
        },
      },
    },
  },
});

export const crdbServiceAccount = crdb.serviceAccount;
export const crdbRole = crdb.role;
export const crdbRoleBinding = crdb.roleBinding;
export const crdbClusterRole = crdb.clusterRole;
export const crdbClusterRoleBinding = crdb.clusterRoleBinding;
export const crdbPublicService = crdb.publicService;
export const crdbHeadlessService = crdb.headlessService;
export const crdbPdb = crdb.pdb;
export const crdbStatefulSet = crdb.statefulSet;
export const crdbInitJob = crdb.initJob;
export const crdbCertGenJob = crdb.certGenJob;
