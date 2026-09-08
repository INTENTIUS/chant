import { Deployment, ConfigMap, ServiceAccount } from "@intentius/chant-lexicon-k8s";
import { cells, shared, SYSTEM_NS } from "../config";

const canaryCell = cells.find(c => c.canary)!;

const systemLabels = { "app.kubernetes.io/part-of": "system" };

export const runnerSa = new ServiceAccount({
  metadata: { name: "gitlab-runner", namespace: SYSTEM_NS, labels: systemLabels },
});

export const runnerConfig = new ConfigMap({
  metadata: { name: "gitlab-runner-config", namespace: SYSTEM_NS, labels: systemLabels },
  data: {
    "config.toml": `
concurrent = ${shared.runnerConcurrency}
[[runners]]
  name = "cells-runner"
  url = "https://${canaryCell.host}"
  executor = "kubernetes"
  [runners.kubernetes]
    namespace = "system"
    service_account = "gitlab-runner"
    image = "alpine:latest"
`,
  },
});

export const runnerDeployment = new Deployment({
  metadata: {
    name: "gitlab-runner",
    namespace: SYSTEM_NS,
    labels: { "app.kubernetes.io/name": "gitlab-runner", "app.kubernetes.io/part-of": "system" },
  },
  spec: {
    replicas: shared.runnerReplicas,
    selector: { matchLabels: { "app.kubernetes.io/name": "gitlab-runner" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "gitlab-runner" } },
      spec: {
        serviceAccountName: "gitlab-runner",
        containers: [{
          name: "runner",
          image: shared.runnerImage,
          command: ["gitlab-runner", "run"],
          // The manager process only polls the coordinator and spawns job pods;
          // the jobs themselves run in their own pods and are sized separately.
          resources: {
            requests: { cpu: "100m", memory: "128Mi" },
            limits: { cpu: "500m", memory: "512Mi" },
          },
          volumeMounts: [{ name: "config", mountPath: "/etc/gitlab-runner" }],
        }],
        volumes: [{ name: "config", configMap: { name: "gitlab-runner-config" } }],
      },
    },
  },
});
