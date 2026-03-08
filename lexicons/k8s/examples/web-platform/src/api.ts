// SidecarApp: API with nginx reverse-proxy sidecar.

import { SidecarApp } from "@intentius/chant-lexicon-k8s";

const NAMESPACE = "web-platform";

const api = SidecarApp({
  name: "api",
  image: "hashicorp/http-echo:0.2.3",
  port: 5678,
  replicas: 3,
  namespace: NAMESPACE,
  env: [{ name: "ECHO_TEXT", value: "hello from api" }],
  sidecars: [{
    name: "nginx-proxy",
    image: "nginx:1.27-alpine",
    ports: [{ containerPort: 8080, name: "proxy" }],
    resources: {
      limits: { cpu: "100m", memory: "64Mi" },
      requests: { cpu: "50m", memory: "32Mi" },
    },
  }],
});

export const apiDeployment = api.deployment;
export const apiService = api.service;
