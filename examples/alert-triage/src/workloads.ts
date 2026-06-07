// The alert-triage app's Kubernetes surface — typed, synthesized to plain YAML.
//
// Two workloads: a webhook receiver that accepts incoming alerts over HTTP, and
// a Temporal worker that runs the triage workflow's activities. Both use
// composites so the output carries production defaults and lints clean.
import { WebApp, WorkerPool } from "@intentius/chant-lexicon-k8s";
import { webhookImage, workerImage } from "./config";

const secureContext = {
  runAsNonRoot: true,
  runAsUser: 1000,
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
};

// Webhook receiver — Deployment + Service + Ingress + PodDisruptionBudget.
const webhook = WebApp({
  name: "alert-webhook",
  image: webhookImage,
  port: 8080,
  replicas: 2,
  minAvailable: 1,
  ingressHost: "alerts.example.com",
  cpuRequest: "50m",
  memoryRequest: "64Mi",
  cpuLimit: "200m",
  memoryLimit: "256Mi",
  securityContext: secureContext,
});

export const webhookDeployment = webhook.deployment;
export const webhookService = webhook.service;
export const webhookIngress = webhook.ingress!;
export const webhookPdb = webhook.pdb!;

// Temporal worker — Deployment only (no Service); runs the triage activities.
const worker = WorkerPool({
  name: "alert-worker",
  image: workerImage,
  replicas: 2,
  minAvailable: 1,
  cpuRequest: "100m",
  memoryRequest: "128Mi",
  cpuLimit: "500m",
  memoryLimit: "256Mi",
  securityContext: secureContext,
});

export const workerDeployment = worker.deployment;
export const workerPdb = worker.pdb!;
