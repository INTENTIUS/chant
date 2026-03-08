// K8s workloads: CockroachDB cluster (AKS slice — 3 of 9 nodes).

import { CockroachDbCluster } from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

const NAMESPACE = "crdb-aks";

const crdb = CockroachDbCluster({
  name: config.name,
  namespace: NAMESPACE,
  replicas: config.replicas,
  image: config.image,
  storageSize: config.storageSize,
  storageClassName: "premium-lrs",
  cpuLimit: config.cpuLimit,
  memoryLimit: config.memoryLimit,
  locality: config.locality,
  joinAddresses: config.joinAddresses,
  secure: true,
  labels: {
    "app.kubernetes.io/part-of": "cockroachdb-multi-cloud",
    "app.kubernetes.io/instance": "aks",
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
