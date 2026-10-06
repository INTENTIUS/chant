# observe-converge

Op steps from the prometheus and otel lexicons around a rule file and a collector config this project builds.

```bash
npm run build              # dist/rules.yml (the SLO) and dist/collector.yaml
chant run observability-checks   # promtool over the rules, with tests from the SLO; otelcol over the config
chant run rules-loaded           # one resource per rule group Prometheus should have loaded
chant run collector-health       # one resource for the collector, from the endpoints its config declares
chant run rule-audit             # rule errors, stuck alerts, selectors nothing writes
```

`rules-loaded` and `collector-health` are ConvergeOps on the observe dial: each tick records one verdict per resource, `in-sync`, `drifted` or `unknown`, and reports the drifted ones. Prometheus is read at `$PROMETHEUS_URL` (default `http://localhost:9090`); the collector at the ports its config declares, 13133 for `health_check` and 8888 for its own metrics.

From the repository root, `npx vitest run lexicons/prometheus/examples/observe-converge` checks the Ops and the collector build, and `npx vitest run --project e2e lexicons/prometheus/examples/observe-converge.e2e.test.ts` runs both ConvergeOps against Prometheus and the collector in Docker.
