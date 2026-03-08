// Lightweight Prometheus + Grafana for cluster and per-cell observability.
// Production deployments should use kube-prometheus-stack via Helm.

import { Deployment, Service } from "@intentius/chant-lexicon-k8s";

const labels = {
  "app.kubernetes.io/part-of": "system",
  "app.kubernetes.io/managed-by": "chant",
};

// ── Prometheus ─────────────────────────────────────────────────────

export const prometheus = new Deployment({
  metadata: {
    name: "prometheus",
    namespace: "system",
    labels: { ...labels, "app.kubernetes.io/name": "prometheus" },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { "app.kubernetes.io/name": "prometheus" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "prometheus" } },
      spec: {
        containers: [{
          name: "prometheus",
          image: "prom/prometheus:v2.51.0",
          ports: [{ containerPort: 9090, name: "http" }],
          resources: {
            requests: { cpu: "200m", memory: "512Mi" },
            limits: { cpu: "500m", memory: "1Gi" },
          },
        }],
      },
    },
  },
});

export const prometheusSvc = new Service({
  metadata: {
    name: "prometheus",
    namespace: "system",
    labels: { ...labels, "app.kubernetes.io/name": "prometheus" },
  },
  spec: {
    selector: { "app.kubernetes.io/name": "prometheus" },
    ports: [{ port: 9090, targetPort: 9090, name: "http" }],
    type: "ClusterIP",
  },
});

// ── Grafana ────────────────────────────────────────────────────────

export const grafana = new Deployment({
  metadata: {
    name: "grafana",
    namespace: "system",
    labels: { ...labels, "app.kubernetes.io/name": "grafana" },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { "app.kubernetes.io/name": "grafana" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "grafana" } },
      spec: {
        containers: [{
          name: "grafana",
          image: "grafana/grafana:10.4.1",
          ports: [{ containerPort: 3000, name: "http" }],
          resources: {
            requests: { cpu: "100m", memory: "256Mi" },
            limits: { cpu: "250m", memory: "512Mi" },
          },
        }],
      },
    },
  },
});

export const grafanaSvc = new Service({
  metadata: {
    name: "grafana",
    namespace: "system",
    labels: { ...labels, "app.kubernetes.io/name": "grafana" },
  },
  spec: {
    selector: { "app.kubernetes.io/name": "grafana" },
    ports: [{ port: 3000, targetPort: 3000, name: "http" }],
    type: "ClusterIP",
  },
});
