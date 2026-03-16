/**
 * GCP-specific naming configuration for the core NamingStrategy.
 *
 * Maps Config Connector resource types to concise TypeScript class names.
 */

import {
  NamingStrategy as CoreNamingStrategy,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

import type { GcpParseResult } from "../spec/parse";
import { gcpShortName, gcpServiceName } from "../spec/parse";

/**
 * Fixed TypeScript class names for key GCP resources.
 */
const priorityNames: Record<string, string> = {
  "GCP::Compute::Instance": "ComputeInstance",
  "GCP::Compute::Network": "VPCNetwork",
  "GCP::Compute::Subnetwork": "Subnetwork",
  "GCP::Compute::Firewall": "Firewall",
  "GCP::Compute::Address": "ComputeAddress",
  "GCP::Compute::Disk": "ComputeDisk",
  "GCP::Compute::ForwardingRule": "ForwardingRule",
  "GCP::Compute::HealthCheck": "ComputeHealthCheck",
  "GCP::Compute::Router": "Router",
  "GCP::Compute::RouterNAT": "RouterNAT",
  "GCP::Compute::BackendService": "BackendService",
  "GCP::Compute::TargetHTTPProxy": "TargetHTTPProxy",
  "GCP::Compute::URLMap": "URLMap",
  "GCP::Compute::SSLCertificate": "SSLCertificate",
  "GCP::Storage::Bucket": "StorageBucket",
  "GCP::Sql::Instance": "SQLInstance",
  "GCP::Sql::Database": "SQLDatabase",
  "GCP::Sql::User": "SQLUser",
  "GCP::Container::Cluster": "GKECluster",
  "GCP::Container::NodePool": "NodePool",
  "GCP::Iam::ServiceAccount": "GCPServiceAccount",
  "GCP::Iam::PolicyMember": "IAMPolicyMember",
  "GCP::Iam::Policy": "IAMPolicy",
  "GCP::Iam::AuditConfig": "IAMAuditConfig",
  "GCP::Run::Service": "CloudRunService",
  "GCP::Run::Job": "CloudRunJob",
  "GCP::Pubsub::Topic": "PubSubTopic",
  "GCP::Pubsub::Subscription": "PubSubSubscription",
  "GCP::Bigquery::Dataset": "BigQueryDataset",
  "GCP::Bigquery::Table": "BigQueryTable",
  "GCP::Dns::ManagedZone": "DNSManagedZone",
  "GCP::Dns::RecordSet": "DNSRecordSet",
  "GCP::Logging::Metric": "LoggingMetric",
  "GCP::Monitoring::AlertPolicy": "AlertPolicy",
  "GCP::Secretmanager::Secret": "SecretManagerSecret",
  "GCP::Secretmanager::SecretVersion": "SecretManagerSecretVersion",
  "GCP::Artifactregistry::Repository": "ArtifactRegistryRepository",
  "GCP::Cloudfunctions::Function": "CloudFunction",
  "GCP::Kms::KeyRing": "KMSKeyRing",
  "GCP::Kms::CryptoKey": "KMSCryptoKey",
  "GCP::Redis::Instance": "RedisInstance",
  "GCP::Memcache::Instance": "MemcacheInstance",
  "GCP::Spanner::Instance": "SpannerInstance",
  "GCP::Spanner::Database": "SpannerDatabase",
  "GCP::Dataflow::Job": "DataflowJob",
  "GCP::Bigtable::Instance": "BigtableInstance",
  "GCP::Bigtable::Table": "BigtableTable",
};

/**
 * Additional TypeScript names beyond the primary priority name.
 */
const priorityAliases: Record<string, string[]> = {
  "GCP::Compute::Network": ["VPC"],
  "GCP::Container::Cluster": ["GKE"],
  "GCP::Storage::Bucket": ["GCSBucket"],
  "GCP::Sql::Instance": ["CloudSQL"],
  "GCP::Iam::ServiceAccount": ["GSA"],
  "GCP::Run::Service": ["CloudRun"],
};

/**
 * Service name abbreviations for collision-resolved names.
 */
const serviceAbbreviations: Record<string, string> = {
  Compute: "Compute",
  Storage: "Gcs",
  Container: "Gke",
  Sql: "Sql",
  Iam: "Iam",
  Bigquery: "BQ",
  Pubsub: "PubSub",
  Dns: "Dns",
  Logging: "Log",
  Monitoring: "Mon",
  Secretmanager: "Sm",
  Artifactregistry: "Ar",
  Cloudfunctions: "Gcf",
  Kms: "Kms",
  Redis: "Redis",
  Run: "Run",
  Spanner: "Spanner",
  Dataflow: "Df",
  Bigtable: "Bt",
  Memcache: "Mc",
};

const gcpNamingConfig: NamingConfig = {
  priorityNames,
  priorityAliases,
  priorityPropertyAliases: {
    "GCP::Compute::Instance": {
      NetworkInterface: "InstanceNetworkInterface",
      AccessConfig: "InstanceAccessConfig",
      AttachedDisk: "InstanceAttachedDisk",
      Metadata: "InstanceMetadata",
      Scheduling: "InstanceScheduling",
      ServiceAccount: "InstanceServiceAccount",
      ShieldedInstanceConfig: "InstanceShieldedConfig",
    },
    "GCP::Container::Cluster": {
      NetworkConfig: "ClusterNetworkConfig",
      NodeConfig: "ClusterNodeConfig",
      IpAllocationPolicy: "ClusterIpAllocationPolicy",
      MasterAuth: "ClusterMasterAuth",
      PrivateClusterConfig: "ClusterPrivateConfig",
      AddonsConfig: "ClusterAddonsConfig",
    },
    "GCP::Container::NodePool": {
      NodeConfig: "NodePoolNodeConfig",
      AutoScaling: "NodePoolAutoScaling",
      Management: "NodePoolManagement",
      UpgradeSettings: "NodePoolUpgradeSettings",
    },
    "GCP::Sql::Instance": {
      IpConfiguration: "SqlIpConfiguration",
      BackupConfiguration: "SqlBackupConfiguration",
      DatabaseFlags: "SqlDatabaseFlags",
      Settings: "SqlSettings",
    },
    "GCP::Storage::Bucket": {
      Encryption: "BucketEncryption",
      Versioning: "BucketVersioning",
      Lifecycle: "BucketLifecycle",
      LifecycleRule: "BucketLifecycleRule",
      Logging: "BucketLogging",
      RetentionPolicy: "BucketRetentionPolicy",
    },
    "GCP::Compute::Network": {
      RoutingConfig: "NetworkRoutingConfig",
    },
    "GCP::Compute::Subnetwork": {
      LogConfig: "SubnetworkLogConfig",
      SecondaryIpRange: "SubnetworkSecondaryIpRange",
    },
  },
  serviceAbbreviations,
  shortName: gcpShortName,
  serviceName: (typeName: string) => {
    const parts = typeName.split("::");
    return parts.length >= 2 ? parts[1] : "Other";
  },
};

/**
 * GCP-specific NamingStrategy — wraps the core algorithm with GCP data tables.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(results: GcpParseResult[]) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, gcpNamingConfig);
  }
}
