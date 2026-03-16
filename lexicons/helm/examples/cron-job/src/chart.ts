import { Chart, Values } from "@intentius/chant-lexicon-helm";
import { values, include, printf, toYaml } from "@intentius/chant-lexicon-helm";
import { CronJob, Container } from "@intentius/chant-lexicon-k8s";

export const chart = new Chart({
  apiVersion: "v2",
  name: "db-backup",
  version: "0.1.0",
  appVersion: "1.0.0",
  type: "application",
  description: "A Helm chart for a database backup CronJob",
});

export const valuesSchema = new Values({
  image: {
    repository: "bitnami/postgresql",
    tag: "16",
    pullPolicy: "IfNotPresent",
  },
  schedule: "0 3 * * *",
  restartPolicy: "OnFailure",
  concurrencyPolicy: "Forbid",
  successfulJobsHistoryLimit: 3,
  failedJobsHistoryLimit: 1,
  backoffLimit: 2,
  command: ["/bin/sh"],
  args: ["-c", "pg_dump $DATABASE_URL | gzip > /backups/db-$(date +%Y%m%d%H%M%S).sql.gz"],
  resources: {
    requests: { cpu: "100m", memory: "256Mi" },
    limits: { cpu: "500m", memory: "512Mi" },
  },
  env: {
    databaseUrl: "",
  },
});

export const cronJob = new CronJob({
  metadata: {
    name: include("db-backup.fullname"),
    labels: include("db-backup.labels"),
  },
  spec: {
    schedule: values.schedule,
    concurrencyPolicy: values.concurrencyPolicy,
    successfulJobsHistoryLimit: values.successfulJobsHistoryLimit,
    failedJobsHistoryLimit: values.failedJobsHistoryLimit,
    jobTemplate: {
      spec: {
        backoffLimit: values.backoffLimit,
        template: {
          metadata: {
            labels: include("db-backup.selectorLabels"),
          },
          spec: {
            restartPolicy: values.restartPolicy,
            securityContext: { runAsNonRoot: true, fsGroup: 1001 },
            containers: [
              new Container({
                name: "backup",
                image: printf("%s:%s", values.image.repository, values.image.tag),
                imagePullPolicy: values.image.pullPolicy,
                command: values.command,
                args: values.args,
                resources: toYaml(values.resources),
                securityContext: {
                  runAsUser: 1001,
                  allowPrivilegeEscalation: false,
                },
                env: [
                  { name: "DATABASE_URL", value: values.env.databaseUrl },
                ],
              }),
            ],
          },
        },
      },
    },
  },
});
