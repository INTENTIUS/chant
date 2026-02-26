// WebApp: frontend with PDB.

import {
  Deployment,
  Service,
  PodDisruptionBudget,
  WebApp,
} from "@intentius/chant-lexicon-k8s";

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

export const frontendDeployment = new Deployment(frontend.deployment);
export const frontendService = new Service(frontend.service);
export const frontendPdb = new PodDisruptionBudget(frontend.pdb!);
