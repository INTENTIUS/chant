// WebApp: frontend with PDB.

import { WebApp } from "@intentius/chant-lexicon-k8s";

const NAMESPACE = "web-platform";

const frontend = WebApp({
  name: "frontend",
  image: "nginx:1.25-alpine",
  port: 80,
  replicas: 2,
  minAvailable: 1,
  namespace: NAMESPACE,
  cpuRequest: "50m",
  memoryRequest: "64Mi",
});

export const frontendDeployment = frontend.deployment;
export const frontendService = frontend.service;
export const frontendPdb = frontend.pdb!;
