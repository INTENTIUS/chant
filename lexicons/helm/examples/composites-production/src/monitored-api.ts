import { HelmMonitoredService } from "@intentius/chant-lexicon-helm";

export const { chart, values, deployment, service, serviceAccount, serviceMonitor, prometheusRule } =
  HelmMonitoredService({
    name: "payment-api",
    imageRepository: "myorg/payment-api",
    port: 8080,
    metricsPort: 9090,
    metricsPath: "/metrics",
    scrapeInterval: "15s",
    replicas: 3,
    alertRules: true,
  });
