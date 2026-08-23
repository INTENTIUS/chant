import { ValuesOverride } from "@intentius/chant-lexicon-helm";
import { params } from "@intentius/chant/params";
import { cells, shared } from "../config";

// Per-cell Helm values — generated to gitlab-cell/values-<cell>.yaml at build time.
// Runtime IPs (DB, Redis) are build parameters declared in ../../chant.config.ts;
// load-outputs.sh writes ALPHA_DB_IP, ALPHA_REDIS_PERSISTENT, etc. to .env.
// Pass as: helm upgrade gitlab-cell-<cell> ./gitlab-cell/ -f gitlab-cell/values-base.yaml -f gitlab-cell/values-<cell>.yaml
//
// cellEnvs[i] corresponds to cells[i] — kept in sync with the cells array order.
const cellEnvs = [
  { dbIp: params.alphaDbIp as string, redisPersistent: params.alphaRedisPersistent as string, redisCache: params.alphaRedisCache as string },
  { dbIp: params.betaDbIp as string, redisPersistent: params.betaRedisPersistent as string, redisCache: params.betaRedisCache as string },
];

function makeCellValues(cell: typeof cells[0], env: typeof cellEnvs[0]) {
  return new ValuesOverride({
    filename: `values-${cell.name}`,
    values: {
      global: {
        hosts: { domain: cell.host, https: true },
        cells: { id: cell.cellId, sequence_offset: cell.sequenceOffset },
        psql: {
          host: env.dbIp,
          username: `gitlab-${cell.name}-db-admin`,
        },
        redis: {
          host: env.redisPersistent,
          cache: { host: env.redisCache },
          sharedState: { host: env.redisPersistent },
          queues: { host: env.redisPersistent },
          actioncable: { host: env.redisCache },
        },
        smtp: {
          address: shared.smtpAddress,
          port: shared.smtpPort,
          user_name: shared.smtpUser,
          domain: shared.smtpDomain,
        },
        appConfig: {
          object_store: {
            connection: {
              provider: "Google",
              google_project: shared.projectId,
              google_application_default: true,
            },
          },
          artifacts: { bucket: `${shared.projectId}-${cell.name}-artifacts` },
          uploads: { bucket: `${shared.projectId}-${cell.name}-uploads` },
          lfs: { bucket: `${shared.projectId}-${cell.name}-lfs` },
          packages: { bucket: `${shared.projectId}-${cell.name}-packages` },
        },
      },
      gitlab: {
        webservice: { minReplicas: cell.webserviceReplicas, maxReplicas: cell.webserviceReplicas },
        sidekiq: {
          pods: cell.sidekiqQueues.map(q => ({
            name: q.name,
            queues: q.queues,
            replicas: q.replicas,
            resources: { requests: { cpu: q.cpuRequest, memory: q.memoryRequest } },
          })),
        },
        gitaly: {
          persistence: {
            enabled: true,
            size: `${cell.gitalyDiskSizeGb}Gi`,
            storageClass: "pd-ssd",
          },
        },
      },
    },
  });
}

export const perCellValues = [
  makeCellValues(cells[0], cellEnvs[0]),
  makeCellValues(cells[1], cellEnvs[1]),
];
