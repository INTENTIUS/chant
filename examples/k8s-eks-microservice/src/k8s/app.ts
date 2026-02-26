// K8s workloads: AutoscaledService + IrsaServiceAccount + ConfigMap.
//
// The app IRSA role ARN comes from the AWS infra stack output. In a real
// deployment you'd pass it via environment variable or parameter; here
// we use a placeholder that maps to the CloudFormation output.

import {
  Deployment,
  Service,
  HorizontalPodAutoscaler,
  PodDisruptionBudget,
  ServiceAccount,
  ConfigMap,
  AutoscaledService,
  IrsaServiceAccount,
  ConfiguredApp,
} from "@intentius/chant-lexicon-k8s";

const NAMESPACE = "microservice";

// ── IRSA ServiceAccount ────────────────────────────────────────────

const irsa = IrsaServiceAccount({
  name: "microservice-app",
  // In production, this ARN comes from the AWS stack output:
  //   aws cloudformation describe-stacks --stack-name eks-microservice \
  //     --query 'Stacks[0].Outputs[?OutputKey==`appRoleArn`].OutputValue'
  iamRoleArn: "arn:aws:iam::123456789012:role/eks-microservice-app-role",
  namespace: NAMESPACE,
});

export const appServiceAccount = new ServiceAccount(irsa.serviceAccount);

// ── AutoscaledService (Deployment + Service + HPA + PDB) ───────────

const app = AutoscaledService({
  name: "microservice-api",
  image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/microservice:v1.0.0",
  port: 8080,
  replicas: 3,
  minReplicas: 2,
  maxReplicas: 10,
  targetCPU: 70,
  minAvailable: 1,
  namespace: NAMESPACE,
  cpuRequest: "200m",
  memoryRequest: "256Mi",
  cpuLimit: "1",
  memoryLimit: "512Mi",
  env: [
    { name: "APP_ENV", value: "production" },
    { name: "LOG_LEVEL", value: "info" },
  ],
  labels: {
    "app.kubernetes.io/part-of": "eks-microservice",
    "app.kubernetes.io/version": "v1.0.0",
  },
});

export const appDeployment = new Deployment({
  ...app.deployment,
  spec: {
    ...(app.deployment.spec as Record<string, unknown>),
    template: {
      ...((app.deployment.spec as Record<string, unknown>).template as Record<string, unknown>),
      spec: {
        ...(((app.deployment.spec as Record<string, unknown>).template as Record<string, unknown>).spec as Record<string, unknown>),
        serviceAccountName: "microservice-app-sa",
      },
    },
  },
});
export const appService = new Service(app.service);
export const appHpa = new HorizontalPodAutoscaler(app.hpa);
export const appPdb = new PodDisruptionBudget(app.pdb!);

// ── App ConfigMap ──────────────────────────────────────────────────

export const appConfig = new ConfigMap({
  metadata: {
    name: "microservice-config",
    namespace: NAMESPACE,
    labels: {
      "app.kubernetes.io/name": "microservice-api",
      "app.kubernetes.io/managed-by": "chant",
      "app.kubernetes.io/component": "config",
    },
  },
  data: {
    "config.yaml": [
      "server:",
      "  port: 8080",
      "  gracefulShutdown: 30s",
      "database:",
      "  maxConnections: 20",
      "  idleTimeout: 5m",
      "cache:",
      "  ttl: 60s",
    ].join("\n"),
  },
});
