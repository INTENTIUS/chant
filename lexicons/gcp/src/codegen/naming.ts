/**
 * GCP-specific naming configuration for the core NamingStrategy.
 *
 * Maps Config Connector resource types to concise TypeScript class names.
 *
 * A name the lexicon has published stays with the type that published it
 * (#5549). The committed surface snapshot records which resource type holds
 * each name, and generation reserves those names before short names are
 * contested, so when upstream adds a CRD whose short name an existing type
 * already has, only the newcomer is service-prefixed. Property type names are
 * `<ResourceName>_<Def>`, so they follow their resource and keep their names
 * too. A type with no published name (every type on a first generation, or a
 * type new in this upgrade) is named by the rule below over the whole input:
 * priority name, else short name, else `<Service><Name>` when the short name
 * is shared. No list here has to grow when upstream adds a collision.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NamingStrategy as CoreNamingStrategy,
  reservedNamesFromSnapshot,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

import type { GcpParseResult } from "../spec/parse";
import { gcpShortName, gcpServiceName } from "../spec/parse";

/**
 * Fixed TypeScript class names for key GCP resources.
 *
 * These outrank published names, so an entry here is a deliberate choice of
 * name. They also name these types where no snapshot exists. Keeping names
 * stable across upgrades is the snapshot's job; this table does not need an
 * entry for each type upstream might collide with.
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
  /**
   * @param reservedNames resource type -> the name the lexicon already
   *   published for it, normally {@link publishedNames}. Passed in rather than
   *   read here so a test or a fixture-driven run names its inputs by the
   *   rule alone unless it asks for the published surface.
   */
  constructor(results: GcpParseResult[], reservedNames: Record<string, string> = {}) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, {
      ...gcpNamingConfig,
      priorityNames: { ...newcomerNames(inputs, reservedNames), ...priorityNames },
      reservedNames,
    });
  }
}

/**
 * The names of the types with no published name, as the rule alone would
 * name them over the whole input.
 *
 * Reserving every published name takes those types out of the short-name
 * contest, so without this a newcomer whose short name only published types
 * share would look unshared and take the bare name: a new `Job` type would be
 * `Job` beside `BQJob` and `DataflowJob`. Naming newcomers by the rule over
 * every type keeps a shared short name prefixed, as it was before names were
 * reserved. A rule name that a published type in the input holds is left to
 * the core contest instead of being pinned over it.
 */
function newcomerNames(inputs: NamingInput[], reservedNames: Record<string, string>): Record<string, string> {
  const present = inputs.filter((i) => reservedNames[i.typeName] !== undefined);
  if (present.length === 0) return {};
  const held = new Set(present.map((i) => reservedNames[i.typeName]));
  const rule = new CoreNamingStrategy(inputs, gcpNamingConfig);
  const names: Record<string, string> = {};
  for (const { typeName } of inputs) {
    if (priorityNames[typeName] !== undefined || reservedNames[typeName] !== undefined) continue;
    const name = rule.resolve(typeName);
    if (name !== undefined && !held.has(name)) names[typeName] = name;
  }
  return names;
}

/** The committed surface snapshot beside this package's `src/`. */
export const SURFACE_SNAPSHOT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "surface.snapshot.json");

/**
 * The names the gcp lexicon has published, read from its committed surface
 * snapshot: resource type -> name. Empty when there is no snapshot or it
 * cannot be parsed, so generation falls back to the rule and `surface-diff`
 * shows any rename that follows.
 *
 * Generation reads the snapshot before `surface-diff --update-snapshot`
 * rewrites it, so an upgrade keeps the names of the release before it, and a
 * second run over the updated snapshot names every type the same way.
 */
export function publishedNames(snapshotPath: string = SURFACE_SNAPSHOT_PATH): Record<string, string> {
  try {
    if (!existsSync(snapshotPath)) return {};
    return reservedNamesFromSnapshot(JSON.parse(readFileSync(snapshotPath, "utf-8")));
  } catch {
    return {};
  }
}
