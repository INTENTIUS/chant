/**
 * The CC lane's canonical example, workload half — the Deployment behind the
 * Service (chant#1198; behold#148's runtime clause).
 *
 * The Service alone proves both substrates observe in one read; the Deployment
 * is what makes the K8S *runtime* level demonstrable on the same estate: its
 * controller creates Pods the cluster owns through `ownerReferences`
 * (chant#1180), which is the tier below the declaration boundary a viewer can
 * descend into — and the field-manager surface an out-of-band `kubectl scale`
 * shows up on. Selector and template labels match the Service's selector, so
 * the declared request path (Service → Deployment) is a real join, not a
 * coincidence of names.
 *
 * The image is pinned (lint flags `:latest`), unprivileged, and public — the
 * emulator's k3s node pulls it from Docker Hub like any cluster would. The
 * container carries the hardening the k8s post-synth checks look for, minus
 * `readOnlyRootFilesystem` (nginx wants writable cache/tmp paths, and a volume
 * arrangement would outgrow a canonical estate — that one advisory stands).
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
