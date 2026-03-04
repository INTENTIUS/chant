// K8s workloads: CockroachDB cluster (EKS slice — 3 of 9 nodes).

import {
  StatefulSet,
  Service,
  ServiceAccount,
  Role,
  RoleBinding,
  ClusterRole,
  ClusterRoleBinding,
  PodDisruptionBudget,
  Job,
  CockroachDbCluster,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

const NAMESPACE = "crdb-eks";

const crdb = CockroachDbCluster({
  name: config.name,
  namespace: NAMESPACE,
  replicas: config.replicas,
  image: config.image,
  storageSize: config.storageSize,
  storageClassName: "gp3-encrypted",
  cpuLimit: config.cpuLimit,
  memoryLimit: config.memoryLimit,
  locality: config.locality,
  joinAddresses: config.joinAddresses,
  secure: true,
  labels: {
    "app.kubernetes.io/part-of": "cockroachdb-multi-cloud",
    "app.kubernetes.io/instance": "eks",
  },
});

export const crdbServiceAccount = new ServiceAccount(crdb.serviceAccount);
export const crdbRole = new Role(crdb.role);
export const crdbRoleBinding = new RoleBinding(crdb.roleBinding);
export const crdbClusterRole = new ClusterRole(crdb.clusterRole);
export const crdbClusterRoleBinding = new ClusterRoleBinding(crdb.clusterRoleBinding);
export const crdbPublicService = new Service(crdb.publicService);
export const crdbHeadlessService = new Service(crdb.headlessService);
export const crdbPdb = new PodDisruptionBudget(crdb.pdb);
export const crdbStatefulSet = new StatefulSet(crdb.statefulSet);
export const crdbInitJob = new Job(crdb.initJob);
export const crdbCertGenJob = new Job(crdb.certGenJob);
