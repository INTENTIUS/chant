import { Deployment, ConfigMap, ServiceAccount } from "@intentius/chant-lexicon-k8s";
import { cells, shared } from "../config";

const canaryCell = cells.find(c => c.canary)!;

const systemLabels = { "app.kubernetes.io/part-of": "system" };

export const runnerSa = new ServiceAccount({
  metadata: { name: "gitlab-runner", namespace: "system", labels: systemLabels },
});

export const runnerConfig = new ConfigMap({
  metadata: { name: "gitlab-runner-config", namespace: "system", labels: systemLabels },
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
    namespace: "system",
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
          volumeMounts: [{ name: "config", mountPath: "/etc/gitlab-runner" }],
        }],
        volumes: [{ name: "config", configMap: { name: "gitlab-runner-config" } }],
      },
    },
  },
});
