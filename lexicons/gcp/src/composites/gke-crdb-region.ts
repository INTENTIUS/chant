/**
 * GkeCrdbRegion composite — GKE cluster + public DNS zone + per-region IAM for a CockroachDB region.
 *
 * Replaces the 2-file per-region GCP infra pattern (infra/cluster.ts + infra/dns.ts) with
 * a single composite call. Handles the GKE cluster, the public DNS zone, and all per-region
 * Workload Identity IAM bindings for both ExternalDNS and CockroachDB pods.
 */

import { Composite } from "@intentius/chant";
import { GkeCluster } from "./gke-cluster";
import { DNSManagedZone, GCPServiceAccount, IAMPolicyMember } from "../generated";

export interface GkeCrdbRegionNodeConfig {
  /** Machine type (default: "n2-standard-2"). */
  machineType?: string;
  /** Disk size per node in GB (default: 100). */
  diskSizeGb?: number;
  /** Initial/min node count (default: 1). */
  nodeCount?: number;
  /** Maximum node count for autoscaling (default: 3). */
  maxNodeCount?: number;
}

export interface GkeCrdbRegionConfig {
  /**
   * GCP region (e.g. "us-east4").
   * Used as both the cluster location and for NAT router naming.
   */
  region: string;
  /** GKE cluster name (e.g. "gke-crdb-east"). Used as prefix for child resources. */
  clusterName: string;
  /** VPC network resource name. */
  network: string;
  /** Node subnet resource name for the cluster. */
  subnetwork: string;
  /** Public DNS domain for this region (e.g. "east.crdb.example.com"). */
  domain: string;
  /** GCP project ID for Workload Identity pool and service account names. */
  project: string;
  /**
   * K8s namespace where CockroachDB pods run (e.g. "crdb-east").
   * Used in the Workload Identity binding subject for CRDB pods.
   */
  crdbNamespace: string;
  /**
   * K8s ServiceAccount name for CockroachDB pods (default: "cockroachdb").
   * Used in the Workload Identity binding subject.
   */
  crdbK8sSa?: string;
  /**
   * CIDR block for the GKE master's private endpoint (e.g. "172.16.0.0/28").
   * Must be /28, unique per cluster, not overlapping with node/pod CIDRs.
   */
  masterCidr?: string;
  /** Node pool configuration. */
  nodeConfig?: GkeCrdbRegionNodeConfig;
  /** GCP release channel for cluster upgrades (default: "REGULAR"). */
  releaseChannel?: "RAPID" | "REGULAR" | "STABLE";
  /** Optional backup bucket name to grant CRDB GSA storage.objectAdmin access. */
  backupBucket?: string;
  /** Additional labels for all resources. */
  labels?: Record<string, string>;
  /** Namespace for Config Connector resources. */
  namespace?: string;
}

/**
 * Create a GkeCrdbRegion composite — returns all GCP resources for one CockroachDB region:
 * GKE cluster, public DNS zone, per-region GSAs, and Workload Identity IAM bindings.
 *
 * @example
 * ```ts
 * import { GkeCrdbRegion } from "@intentius/chant-lexicon-gcp";
 *
 * export const east = GkeCrdbRegion({
 *   region: "us-east4",
 *   clusterName: "gke-crdb-east",
 *   network: "crdb-multi-region",
 *   subnetwork: "crdb-multi-region-east-nodes",
 *   domain: "east.crdb.example.com",
 *   project: GCP_PROJECT_ID,
 *   crdbNamespace: "crdb-east",
 *   masterCidr: "172.16.0.0/28",
 * });
 * ```
 */
export const GkeCrdbRegion = Composite<GkeCrdbRegionConfig>((props) => {
  const {
    region,
    clusterName,
    network,
    subnetwork,
    domain,
    project,
    crdbNamespace,
    crdbK8sSa = "cockroachdb",
    masterCidr = "172.16.0.0/28",
    nodeConfig = {},
    releaseChannel = "REGULAR",
    backupBucket,
    labels: extraLabels = {},
    namespace,
  } = props;

  const {
    machineType = "n2-standard-2",
    diskSizeGb = 100,
    nodeCount = 1,
    maxNodeCount = 3,
  } = nodeConfig;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": clusterName,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const meta = (component: string, resourceName: string) => ({
    name: resourceName,
    ...(namespace && { namespace }),
    labels: { ...commonLabels, "app.kubernetes.io/component": component },
  });

  // ── GKE Cluster ──────────────────────────────────────────────────────────────

  const { cluster, nodePool, defaultPool } = GkeCluster({
    name: clusterName,
    location: region,
    machineType,
    diskSizeGb,
    initialNodeCount: nodeCount,
    minNodeCount: nodeCount,
    maxNodeCount,
    network,
    subnetwork,
    workloadIdentity: true,
    privateNodes: true,
    masterCidr,
    releaseChannel,
    labels: extraLabels,
    ...(namespace && { namespace }),
  });

  // ── Public DNS Zone ───────────────────────────────────────────────────────────

  const dnsZoneName = `${clusterName}-zone`;

  const dnsZone = new DNSManagedZone({
    metadata: meta("dns", dnsZoneName),
    dnsName: `${domain}.`,
    description: `CockroachDB ${region} UI — managed by chant`,
  } as Record<string, unknown>);

  // ── ExternalDNS Service Account ───────────────────────────────────────────────

  const dnsGsaName = `${clusterName}-dns`;

  const dnsGsa = new GCPServiceAccount({
    metadata: meta("iam", dnsGsaName),
    displayName: `CockroachDB ${region} ExternalDNS workload identity`,
  } as Record<string, unknown>);

  const dnsWiBinding = new IAMPolicyMember({
    metadata: meta("iam", `${dnsGsaName}-wi`),
    member: `serviceAccount:${project}.svc.id.goog[kube-system/external-dns-sa]`,
    role: "roles/iam.workloadIdentityUser",
    resourceRef: {
      apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
      kind: "IAMServiceAccount",
      name: dnsGsaName,
    },
  } as Record<string, unknown>);

  const dnsAdminBinding = new IAMPolicyMember({
    metadata: meta("iam", `${dnsGsaName}-admin`),
    member: `serviceAccount:${dnsGsaName}@${project}.iam.gserviceaccount.com`,
    role: "roles/dns.admin",
    resourceRef: {
      apiVersion: "resourcemanager.cnrm.cloud.google.com/v1beta1",
      kind: "Project",
      external: `projects/${project}`,
    },
  } as Record<string, unknown>);

  // ── CockroachDB Service Account ───────────────────────────────────────────────

  const crdbGsaName = `${clusterName}-crdb`;

  const crdbGsa = new GCPServiceAccount({
    metadata: meta("iam", crdbGsaName),
    displayName: `CockroachDB ${region} workload identity`,
  } as Record<string, unknown>);

  const crdbWiBinding = new IAMPolicyMember({
    metadata: meta("iam", `${crdbGsaName}-wi`),
    member: `serviceAccount:${project}.svc.id.goog[${crdbNamespace}/${crdbK8sSa}]`,
    role: "roles/iam.workloadIdentityUser",
    resourceRef: {
      apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
      kind: "IAMServiceAccount",
      name: crdbGsaName,
    },
  } as Record<string, unknown>);

  const result: Record<string, any> = {
    cluster,
    nodePool,
    defaultPool,
    dnsZone,
    dnsGsa,
    dnsWiBinding,
    dnsAdminBinding,
    crdbGsa,
    crdbWiBinding,
  };

  // Optional: GCS backup access for CRDB GSA
  if (backupBucket) {
    result.crdbBackupBinding = new IAMPolicyMember({
      metadata: meta("iam", `${crdbGsaName}-backup`),
      member: `serviceAccount:${crdbGsaName}@${project}.iam.gserviceaccount.com`,
      role: "roles/storage.objectAdmin",
      resourceRef: {
        apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
        kind: "StorageBucket",
        name: backupBucket,
      },
    } as Record<string, unknown>);
  }

  return result;
}, "GkeCrdbRegion");
