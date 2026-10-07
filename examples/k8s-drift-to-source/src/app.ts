// The estate: one composite call and one resource written directly.
import { Deployment } from "@intentius/chant-lexicon-k8s";
import { WebApp } from "../composites/web-app";

const image = "nginxinc/nginx-unprivileged:1.27-alpine";

// Expands to webDeployment and webService.
export const web = WebApp({
  name: "web-app",
  image,
  replicas: 3,
  port: 8080,
});

// Written directly: no composite sits between this source and the Deployment.
export const worker = new Deployment({
  metadata: { name: "worker", labels: { "app.kubernetes.io/name": "worker" } },
  spec: {
    replicas: 2,
    selector: { matchLabels: { "app.kubernetes.io/name": "worker" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "worker" } },
      spec: {
        containers: [
          {
            name: "worker",
            image,
            resources: {
              requests: { cpu: "10m", memory: "16Mi" },
              limits: { cpu: "100m", memory: "64Mi" },
            },
            readinessProbe: { httpGet: { path: "/", port: 8080 } },
            livenessProbe: { httpGet: { path: "/", port: 8080 } },
            imagePullPolicy: "IfNotPresent",
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 101,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
          },
        ],
      },
    },
  },
});
