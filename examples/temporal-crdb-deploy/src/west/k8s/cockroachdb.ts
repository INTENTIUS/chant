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
  skipInit: true,
  skipCertGen: true,
  mountClientCerts: true,
  advertiseHostDomain: `west.${INTERNAL_DOMAIN}`,
  extraCertNodeAddresses: [
    `cockroachdb-0.west.${INTERNAL_DOMAIN}`,
    `cockroachdb-1.west.${INTERNAL_DOMAIN}`,
    `cockroachdb-2.west.${INTERNAL_DOMAIN}`,
  ],
  labels: {
    "app.kubernetes.io/part-of": "cockroachdb-multi-region",
    "app.kubernetes.io/instance": "west",
  },
  defaults: {
    serviceAccount: {
      metadata: {
        annotations: {
          "iam.gke.io/gcp-service-account": config.crdbGsaEmail,
        },
      },
    },
    publicService: {
      metadata: {
        annotations: {
          "cloud.google.com/backend-config": '{"default":"crdb-ui-backend"}',
          "cloud.google.com/app-protocols": '{"http":"HTTPS"}',
        },
      },
    },
    headlessService: {
      metadata: {
        annotations: {
          "external-dns.alpha.kubernetes.io/hostname": `west.${INTERNAL_DOMAIN}`,
        },
      },
    },
  },
});

export const cockroachdbServiceAccount = crdb.serviceAccount;
export const cockroachdbRole = crdb.role;
export const cockroachdbRoleBinding = crdb.roleBinding;
export const cockroachdbClusterRole = crdb.clusterRole;
export const cockroachdbClusterRoleBinding = crdb.clusterRoleBinding;
export const cockroachdbPublicService = crdb.publicService;
export const cockroachdbHeadlessService = crdb.headlessService;
export const cockroachdbPdb = crdb.pdb;
export const cockroachdbStatefulSet = crdb.statefulSet;
// No initJob for west — skipInit: true, east runs cockroach init for the full cluster
export const cockroachdbCertGenJob = crdb.certGenJob;
