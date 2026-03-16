// K8s workloads: CockroachDB cluster (east slice — 3 of 9 nodes).
// Headless service annotated for ExternalDNS to register pod IPs in Cloud DNS private zone.

import { CockroachDbCluster } from "@intentius/chant-lexicon-k8s";
import { config } from "../config";
import { INTERNAL_DOMAIN } from "../../shared/config";

const NAMESPACE = "crdb-east";

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
  skipCertGen: true,
  mountClientCerts: true,
  advertiseHostDomain: `east.${INTERNAL_DOMAIN}`,
  extraCertNodeAddresses: [
    `cockroachdb-0.east.${INTERNAL_DOMAIN}`,
    `cockroachdb-1.east.${INTERNAL_DOMAIN}`,
    `cockroachdb-2.east.${INTERNAL_DOMAIN}`,
  ],
  labels: {
    "app.kubernetes.io/part-of": "cockroachdb-multi-region",
    "app.kubernetes.io/instance": "east",
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
          // Tell the GCE LB to use HTTPS when forwarding to CockroachDB (TLS-only on port 8080)
          "cloud.google.com/app-protocols": '{"http":"HTTPS"}',
        },
      },
    },
    headlessService: {
      metadata: {
        annotations: {
          "external-dns.alpha.kubernetes.io/hostname": `east.${INTERNAL_DOMAIN}`,
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
export const cockroachdbInitJob = crdb.initJob;
// No certGenJob for east — skipCertGen: true, generate-certs.sh handles shared certs
