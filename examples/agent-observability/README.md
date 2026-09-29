# agent-observability

Tracing, metrics, SLOs and dashboards for an agent, declared in one chant project and run on a local k3d cluster with no account and no key. Everything is open source: the OpenTelemetry Collector, Prometheus and Alertmanager, Tempo, Loki and Grafana, each a plain Kubernetes workload (no Helm, no operators).

It is the worked example for [#2904](https://github.com/INTENTIUS/chant/issues/2904), and it uses five lexicons in one build root:

| Lexicon | What it declares here |
|---|---|
| k3d | the cluster: one server, one agent node (`src/cluster.ts`) |
| otel | both collector configs, the `spanmetrics` connector, tail sampling and the GenAI preset (`src/gateway-*.ts`, `src/agent.ts`) |
| k8s | the collector agent DaemonSet and 2-replica gateway (`OtelCollector`, `OtelCollectorGateway`), and every backend workload |
| prometheus | an `Slo` with multiwindow burn-rate alerts (`src/slo.ts`) and Alertmanager routing (`src/alertmanager.ts`) |
| grafana | the datasources and the RED, SLO and agent dashboards (`src/datasources.ts`, `src/dashboards.ts`) |

## What flows where

```
support-agent pod (app/agent.ts, GenAI spans + logs over OTLP/HTTP)
  -> otel-agent DaemonSet, one per node
       traces: loadbalancing exporter, by trace id, to the gateway's headless Service
       logs, metrics: otlp exporter to the gateway's Service
  -> otel-gateway Deployment, 2 replicas
       traces: GenAI content removed, then
         -> spanmetrics              (RED for every span)          -> prometheus exporter
         -> traces/genai branch      (genai_* calls, duration, tokens) -> prometheus exporter
         -> traces/sampled: tail_sampling (errors, >2s, 10% of the rest) -> Tempo
       logs -> Loki (OTLP)
  Prometheus scrapes each gateway replica, evaluates the SLO rules, and sends
  burn-rate alerts to Alertmanager (severity=page -> oncall, severity=ticket -> tickets;
  a page mutes its tickets).
  Grafana reads Prometheus, Tempo and Loki, provisioned from the grafana build.
```

The metrics are computed before sampling, so the SLO counts every run, including the ones Tempo never stores.

The demo agent in `app/agent.ts` makes no model call. Each run emits an `invoke_agent` span with `chat` and `execute_tool` children, following the OpenTelemetry GenAI semantic conventions (`gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.tool.name`, `gen_ai.usage.input_tokens` and so on), plus one log record. Runs are numbered and the number decides the outcome: one in five fails in its tool, one in seven takes three seconds. Its `chat` spans carry the prompt in `gen_ai.input.messages`, which the gateway deletes before anything is stored. It fails a fifth of its runs against a 99% objective on purpose, so that the burn-rate alerts fire and the routing can be seen working.

## Build and lint

```bash
npm run build   # dist/k3d.yaml, dist/k8s.yaml, dist/prometheus/{rules.yml,alertmanager.yml}, dist/grafana/
npm run lint
```

The Prometheus, Alertmanager and Grafana workloads mount ConfigMaps holding exactly what the prometheus and grafana builds write (`ruleFileYaml`, `alertmanagerYaml`, and `GrafanaConfigMaps` with `grafanaVolumes` from `@intentius/chant-lexicon-grafana/k8s`), so the cluster runs the same files `chant build` emits. The Grafana ConfigMaps carry the Helm chart sidecar's `grafana_dashboard` and `grafana_datasource` labels, so the same ones would work with a sidecar too.

Keeping everything in one build root is what lets the cross-document checks see both sides (chant #1939): WK8601 to WK8603 read each collector ConfigMap next to the workload that runs it, PROM202 reads the SLO's severities next to the routes, and GRAF101/GRAF102 read each panel's datasource next to the declared datasources. The collector configs live inside ConfigMaps here, where the OTEL post-build checks don't look; `test/build.test.ts` runs the same checks (`validateCollectorConfig`) over both.

## Run it on k3d

You need Docker, k3d and kubectl.

```bash
npm run build
npm run image                                    # agent-observability-demo:0.1.0
k3d cluster create --config dist/k3d.yaml
k3d image import agent-observability-demo:0.1.0 -c agent-observability
export KUBECONFIG=$(k3d kubeconfig write agent-observability)
kubectl apply -f dist/k8s.yaml
kubectl -n observability port-forward svc/grafana 3000:80
```

Grafana is at http://localhost:3000 (anonymous viewers are let in). `k3d cluster delete agent-observability` removes everything.

## Tests

From the repository root:

```bash
npx vitest run examples/agent-observability                      # fast: build, config shape, the demo agent's spans
npx vitest run --project e2e examples/agent-observability        # on demand: the whole stack on k3d
```

The fast tests build the project and check what it renders: the agent routes traces by trace id, the gateway counts spans before it samples, content removal is on, the rules and routing pass the prometheus lexicon's checks, and the dashboards pass the grafana lexicon's. They run `otelcol-contrib`, `promtool` and `amtool` when those are on PATH and skip them otherwise. They also run `app/agent.ts` against a local HTTP server and check its spans against the conventions.

The e2e skips unless Docker, k3d and kubectl are all available. It runs `promtool check rules`, `amtool check-config` and `otelcol validate` from the stack's own images, brings the cluster up with the k3d lexicon's `k3dUp`, imports the demo agent's locally built image, applies the manifests, and checks that failed and slow runs all reach Tempo while some ordinary runs are sampled away, that no stored span holds prompt content, that the RED and `genai_*` metrics reach Prometheus, that the SLO's rules evaluate and its page alert reaches the `oncall` receiver with the ticket alert inhibited, that the logs reach Loki, and that Grafana serves the provisioned datasources and dashboards, with every Prometheus query on them returning data. Set `CHANT_KEEP_CLUSTER=1` to leave the cluster up afterwards.
