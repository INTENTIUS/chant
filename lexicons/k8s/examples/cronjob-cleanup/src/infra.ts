import { CronJob, Container } from "@intentius/chant-lexicon-k8s";

export const cleanupJob = new CronJob({
  metadata: {
    name: "temp-cleanup",
    labels: { "app.kubernetes.io/name": "temp-cleanup" },
  },
  spec: {
    schedule: "0 * * * *",
    concurrencyPolicy: "Forbid",
    successfulJobsHistoryLimit: 3,
    failedJobsHistoryLimit: 1,
    jobTemplate: {
      spec: {
        ttlSecondsAfterFinished: 3600,
        backoffLimit: 2,
        template: {
          spec: {
            restartPolicy: "OnFailure",
            containers: [
              new Container({
                name: "cleanup",
                image: "busybox:1.36",
                command: [
                  "sh",
                  "-c",
                  "echo 'Cleaning temp files...'; find /tmp -type f -mmin +60 -delete; echo 'Done.'",
                ],
                securityContext: {
                  runAsNonRoot: true,
                  runAsUser: 1000,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
              }),
            ],
          },
        },
      },
    },
  },
});
