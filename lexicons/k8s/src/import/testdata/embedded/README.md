# Embedded-content import fixtures

Manifests that hold another lexicon's content, for `embedded-roundtrip.test.ts`
`embedded-live.test.ts` and `embedded-types.e2e.test.ts` (#2962, #3031).

| File | Source |
|---|---|
| `otel-collector-daemonset.yaml` | open-telemetry/opentelemetry-helm-charts at `b0bce1305083b574c63d6d537431f0b08d36e17f`, chart opentelemetry-collector 0.173.1 (collector 0.160.0): `charts/opentelemetry-collector/examples/daemonset-only/rendered/configmap-agent.yaml` followed by `daemonset.yaml` from the same directory, unchanged. The config is under the chart's `relay` key. |
| `node-exporter-prometheusrule.yaml` | prometheus-operator/kube-prometheus `v0.19.0`, `manifests/nodeExporter-prometheusRule.yaml`, unchanged. |
| `grafana-dashboard-configmap.yaml` | prometheus-operator/kube-prometheus `v0.19.0`, `manifests/grafana-dashboardDefinitions.yaml`: the `grafana-dashboard-alertmanager-overview` item of that ConfigMapList, written as a ConfigMap of its own with the Grafana sidecar's `grafana_dashboard: "1"` label added, re-serialized by js-yaml. The dashboard JSON is unchanged. |
| `agent-observability.yaml` | `chant build src --lexicon k8s` of `examples/agent-observability` as of #2954: collector ConfigMaps from the k8s collector composites, Prometheus's `rules.yml` from `ruleFileYaml`, and the Grafana dashboard, datasource and provider ConfigMaps from `GrafanaConfigMaps` (`@intentius/chant-lexicon-grafana/k8s`). |
| `alertmanager-configmap.yaml` | prometheus-community/helm-charts at `8d235acbefe2d95f1b1365fafdf07279ae05176f`, chart alertmanager 2.0.1 (Alertmanager v0.34.1), Apache-2.0: `helm template alertmanager alertmanager --repo https://prometheus-community.github.io/helm-charts --version 2.0.1 --namespace monitoring --show-only templates/configmap.yaml`, with `config:` set to Alertmanager's own `doc/examples/simple.yml` at v0.34.1 (Apache-2.0; vendored in the prometheus lexicon as `src/import/testdata/upstream/alertmanager-simple.yml`) plus the chart's `enabled: true`. The rendered output is unchanged, apart from the leading `---`. |
| `grafana-v2-dashboard-configmap.yaml` | The grafana lexicon's `test/fixtures/exports/grafana-13.2.2/checkout.v2-resource.json` (Grafana 13.2.2's "V2 Resource" export, provenance in that directory's README), written as the `checkout.json` value of a ConfigMap with the Grafana sidecar's `grafana_dashboard: "1"` label, serialized by js-yaml. The dashboard JSON is unchanged. |
