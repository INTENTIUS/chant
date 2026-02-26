// SidecarApp: API with envoy sidecar proxy.

import {
  Deployment,
  Service,
  SidecarApp,
} from "@intentius/chant-lexicon-k8s";

const NAMESPACE = "web-platform";

const api = SidecarApp({
  name: "api",
  image: "hashicorp/http-echo:0.2.3",
  port: 8080,
  replicas: 3,
  namespace: NAMESPACE,
  sidecars: [{
    name: "envoy",
    image: "envoyproxy/envoy:v1.28-latest",
    ports: [{ containerPort: 9901, name: "envoy-admin" }],
  }],
  sharedVolumes: [{ name: "envoy-config", emptyDir: {} }],
});

export const apiDeployment = new Deployment(api.deployment);
export const apiService = new Service(api.service);
