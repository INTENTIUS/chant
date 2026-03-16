/**
 * Cloud Run service with IAM policy for public invocation.
 */

import {
  CloudRunService, IAMPolicyMember, RunRoles,
  GCP, defaultAnnotations,
} from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const service = new CloudRunService({
  metadata: {
    name: "hello-service",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  location: GCP.Region,
  projectRef: { external: GCP.ProjectId },
  template: {
    containers: [
      {
        image: "us-docker.pkg.dev/cloudrun/container/hello",
        ports: [{ containerPort: 8080 }],
        resources: {
          limits: { cpu: "1000m", memory: "512Mi" },
        },
      },
    ],
    scaling: { minInstanceCount: 0, maxInstanceCount: 5 },
  },
  ingress: "INGRESS_TRAFFIC_ALL",
});

export const invoker = new IAMPolicyMember({
  metadata: {
    name: "hello-service-invoker",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: "allUsers",
  role: RunRoles.Invoker,
  resourceRef: {
    kind: "RunService",
    name: "hello-service",
  },
});
