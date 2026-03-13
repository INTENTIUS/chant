import { CloudSqlInstance, SQLInstance } from "@intentius/chant-lexicon-gcp";
import { cells, shared } from "../config";

// Per-cell Cloud SQL PostgreSQL instances
// Export as flat arrays of Resources so the chant discovery system can find them.
const _cellDatabases = cells.map(c => CloudSqlInstance({
  name: `gitlab-${c.name}-db`,
  databaseVersion: "POSTGRES_16",
  tier: c.pgTier,
  region: shared.region,
  databaseName: "gitlabhq_production",
  diskSize: c.pgDiskSize,
  diskAutoresize: true,
  backupEnabled: true,
  highAvailability: c.pgHighAvailability,
  defaults: {
    instance: {
      settings: {
        ipConfiguration: {
          privateNetworkRef: { name: shared.clusterName },
        },
      },
    },
  },
}));

export const cellDbInstances = _cellDatabases.map(d => d.instance);
export const cellDbDatabases = _cellDatabases.map(d => d.database);
export const cellDbUsers = _cellDatabases.map(d => d.user);

// Read replicas (conditional on pgReadReplicas > 0)
export const readReplicas = cells.flatMap(c =>
  Array.from({ length: c.pgReadReplicas }, (_, i) =>
    new SQLInstance({
      metadata: { name: `gitlab-${c.name}-db-replica-${i}` },
      databaseVersion: "POSTGRES_16",
      region: shared.region,
      masterInstanceRef: { name: `gitlab-${c.name}-db` },
      settings: {
        tier: c.pgTier,
        diskSize: c.pgDiskSize,
        ipConfiguration: {
          ipv4Enabled: false,
          privateNetworkRef: { name: shared.clusterName },
        },
      },
    })
  )
);

// Topology service database
export const topologyDb = CloudSqlInstance({
  name: "gitlab-topology-db",
  databaseVersion: "POSTGRES_16",
  tier: shared.topologyDbTier,
  region: shared.region,
  databaseName: "topology_production",
  defaults: {
    instance: {
      settings: {
        ipConfiguration: {
          privateNetworkRef: { name: shared.clusterName },
        },
      },
    },
  },
});
