// ConfiguredApp: API with mounted config, secret volume, and envFrom.

import {
  Deployment,
  Service,
  ConfigMap,
  ConfiguredApp,
} from "@intentius/chant-lexicon-k8s";

const NAMESPACE = "batch-workers";

const api = ConfiguredApp({
  name: "task-api",
  image: "nginx:1.25-alpine",
  port: 8080,
  replicas: 2,
  namespace: NAMESPACE,
  configData: { "app.yaml": "server:\n  port: 8080\nredis:\n  url: redis://redis:6379" },
  configMountPath: "/etc/task-api",
  secretName: "task-api-creds",
  secretMountPath: "/secrets",
  envFrom: { secretRef: "task-api-env" },
});

export const apiDeployment = new Deployment(api.deployment);
export const apiService = new Service(api.service);
export const apiConfigMap = new ConfigMap(api.configMap!);
