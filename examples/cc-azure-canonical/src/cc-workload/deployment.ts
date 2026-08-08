/**
 * The Deployment behind the Service — same shape as cc-aws-canonical's
 * (chant#1198), because the runtime tier it demonstrates is
 * substrate-independent: the controller creates Pods the cluster owns through
 * `ownerReferences`, selector and template labels make the Service →
 * Deployment join real, and the image is pinned, unprivileged and public so
 * the emulator's k3s node can pull it like any cluster would.
 */
import { Deployment, Container, Probe, PodDisruptionBudget } from "@intentius/chant-lexicon-k8s";

export const apiDeployment = new Deployment({
  metadata: { name: "cc-api", namespace: "default", labels: { app: "cc-api" } },
  spec: {
    replicas: 2,
    selector: { matchLabels: { app: "cc-api" } },
    template: {
      metadata: { labels: { app: "cc-api" } },
      spec: {
        containers: [
          new Container({
            name: "api",
            image: "nginxinc/nginx-unprivileged:1.27-alpine",
            imagePullPolicy: "IfNotPresent",
            ports: [{ containerPort: 8080, name: "http" }],
            resources: {
              requests: { cpu: "50m", memory: "64Mi" },
              limits: { cpu: "250m", memory: "128Mi" },
            },
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 101, // the image's own nginx UID

              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            livenessProbe: new Probe({ httpGet: { path: "/", port: 8080 } }),
            readinessProbe: new Probe({ httpGet: { path: "/", port: 8080 } }),
          }),
        ],
      },
    },
  },
});

/** Keeps one replica through voluntary disruptions — and gives the estate a
 * second plumbing-free k8s kind for behold's zoom tiers to show. */
export const apiPdb = new PodDisruptionBudget({
  metadata: { name: "cc-api", namespace: "default", labels: { app: "cc-api" } },
  spec: {
    minAvailable: 1,
    selector: { matchLabels: { app: "cc-api" } },
  },
});
