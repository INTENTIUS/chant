# Embedded-content import fixtures

Manifests that hold another lexicon's content, for `embedded-roundtrip.test.ts`
and `embedded-types.e2e.test.ts` (#2962).

| File | Source |
|---|---|
| `otel-collector-daemonset.yaml` | open-telemetry/opentelemetry-helm-charts at `b0bce1305083b574c63d6d537431f0b08d36e17f`, chart opentelemetry-collector 0.173.1 (collector 0.160.0): `charts/opentelemetry-collector/examples/daemonset-only/rendered/configmap-agent.yaml` followed by `daemonset.yaml` from the same directory, unchanged. The config is under the chart's `relay` key. |
| `node-exporter-prometheusrule.yaml` | prometheus-operator/kube-prometheus `v0.19.0`, `manifests/nodeExporter-prometheusRule.yaml`, unchanged. |
| `grafana-dashboard-configmap.yaml` | prometheus-operator/kube-prometheus `v0.19.0`, `manifests/grafana-dashboardDefinitions.yaml`: the `grafana-dashboard-alertmanager-overview` item of that ConfigMapList, written as a ConfigMap of its own with the Grafana sidecar's `grafana_dashboard: "1"` label added, re-serialized by js-yaml. The dashboard JSON is unchanged. |
| `agent-observability.yaml` | `chant build src --lexicon k8s` of `examples/agent-observability` at chant `624e1b0cf`: collector ConfigMaps from the k8s collector composites, Prometheus's `rules.yml` from `ruleFileYaml`, and the Grafana files ConfigMap from `grafanaFiles`. |
