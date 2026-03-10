import { Deployment, Service, ConfigMap, PodDisruptionBudget, HorizontalPodAutoscaler } from "@intentius/chant-lexicon-k8s";
import { shared } from "../config";

const labels = {
  "app.kubernetes.io/name": "ingress-nginx-controller",
  "app.kubernetes.io/part-of": "system",
};

export const ingressConfig = new ConfigMap({
  metadata: { name: "ingress-nginx-controller", namespace: "system", labels },
  data: {
    "use-forwarded-headers": "true",
    "ssl-redirect": "true",
    "proxy-body-size": "0",
  },
});

export const ingressController = new Deployment({
  metadata: { name: "ingress-nginx-controller", namespace: "system", labels },
  spec: {
    replicas: shared.ingressReplicas,
    selector: { matchLabels: { "app.kubernetes.io/name": "ingress-nginx-controller" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "ingress-nginx-controller" } },
      spec: {
        containers: [{
          name: "controller",
          image: "registry.k8s.io/ingress-nginx/controller:v1.10.0",
          args: [
            "/nginx-ingress-controller",
            "--ingress-class=nginx",
            "--configmap=system/ingress-nginx-controller",
            "--default-ssl-certificate=system/gitlab-tls",
            "--publish-service=system/ingress-nginx-controller",
          ],
          ports: [
            { name: "http", containerPort: 80, protocol: "TCP" },
            { name: "https", containerPort: 443, protocol: "TCP" },
          ],
          resources: {
            requests: { cpu: "500m", memory: "512Mi" },
            limits: { cpu: "2", memory: "1Gi" },
          },
          livenessProbe: { httpGet: { path: "/healthz", port: 10254, scheme: "HTTP" }, initialDelaySeconds: 10, periodSeconds: 10 },
          readinessProbe: { httpGet: { path: "/healthz", port: 10254, scheme: "HTTP" }, initialDelaySeconds: 10, periodSeconds: 10 },
          securityContext: {
            runAsUser: 101,
            allowPrivilegeEscalation: true,
            capabilities: { add: ["NET_BIND_SERVICE"], drop: ["ALL"] },
          },
        }],
      },
    },
  },
});

export const ingressService = new Service({
  metadata: { name: "ingress-nginx-controller", namespace: "system", labels },
  spec: {
    type: "LoadBalancer",
    selector: { "app.kubernetes.io/name": "ingress-nginx-controller" },
    ports: [
      { name: "http", port: 80, targetPort: "http", protocol: "TCP" },
      { name: "https", port: 443, targetPort: "https", protocol: "TCP" },
    ],
  },
});

export const ingressPdb = new PodDisruptionBudget({
  metadata: { name: "ingress-nginx-controller", namespace: "system" },
  spec: {
    minAvailable: 1,
    selector: { matchLabels: { "app.kubernetes.io/name": "ingress-nginx-controller" } },
  },
});

export const ingressHpa = shared.ingressHpaEnabled
  ? new HorizontalPodAutoscaler({
      metadata: { name: "ingress-nginx-controller", namespace: "system" },
      spec: {
        scaleTargetRef: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: "ingress-nginx-controller",
        },
        minReplicas: shared.ingressReplicas,
        maxReplicas: shared.ingressHpaMaxReplicas,
        metrics: [
          { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } },
        ],
      },
    })
  : null;
