import { cells } from "../config";

// Export references so load-outputs.sh can query these resources
// kubectl get sqlinstances gitlab-alpha-db -o jsonpath='{.status.ipAddresses[0].ipAddress}'
export const outputs = {
  cellDatabases: cells.map(c => ({
    cell: c.name,
    sqlInstance: `gitlab-${c.name}-db`,
    readReplica: c.pgReadReplicas > 0 ? `gitlab-${c.name}-db-replica-0` : null,
  })),
  topologyDb: "gitlab-topology-db",
  redis: cells.map(c => ({
    cell: c.name,
    persistent: `gitlab-${c.name}-persistent`,
    cache: `gitlab-${c.name}-cache`,
  })),
  buckets: cells.map(c => ({
    cell: c.name,
    artifacts: `${c.name}-artifacts`,
    registry: `${c.name}-registry`,
  })),
};
