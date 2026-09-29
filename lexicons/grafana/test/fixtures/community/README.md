# Community dashboards

Popular dashboards from [grafana.com](https://grafana.com/grafana/dashboards/),
used by `src/import/roundtrip.test.ts`: each one is imported with
`chant import`, built back with `chant build`, and compared with the file
here. The UI exports in `../exports/` are the other half of that corpus.

Each file is the revision's download from grafana.com, byte for byte, except
`prometheus-2-stats.grafana-12.4.11.json` (see below). Every one is published
under a license that permits redistribution, and the license is the one of
the author's source repository, which holds the same dashboard. Where the
grafana.com revision differs from the repository's current file, the
repository has moved on since that revision was uploaded.

| File | Dashboard | grafana.com source | Revision (uploaded) | Upstream | License |
|---|---|---|---|---|---|
| `node-exporter-full.json` | Node Exporter Full | https://grafana.com/api/dashboards/1860/revisions/45/download | 45 (2026-04-11) | [rfmoz/grafana-dashboards](https://github.com/rfmoz/grafana-dashboards) `prometheus/node-exporter-full.json` | Apache-2.0 |
| `k8s-views-global.json` | Kubernetes / Views / Global | https://grafana.com/api/dashboards/15757/revisions/43/download | 43 (2025-02-11) | [dotdc/grafana-dashboards-kubernetes](https://github.com/dotdc/grafana-dashboards-kubernetes) `dashboards/k8s-views-global.json` | Apache-2.0 |
| `k8s-views-pods.json` | Kubernetes / Views / Pods | https://grafana.com/api/dashboards/15760/revisions/41/download | 41 (2026-09-20) | [dotdc/grafana-dashboards-kubernetes](https://github.com/dotdc/grafana-dashboards-kubernetes) `dashboards/k8s-views-pods.json` (identical) | Apache-2.0 |
| `traefik.json` | Traefik Official Standalone Dashboard | https://grafana.com/api/dashboards/17346/revisions/9/download | 9 (2024-08-02) | [traefik/traefik](https://github.com/traefik/traefik) `contrib/grafana/traefik.json` (identical) | MIT |
| `redis.json` | Redis Dashboard for Prometheus Redis Exporter 1.x | https://grafana.com/api/dashboards/763/revisions/6/download | 6 (2024-02-17) | [oliver006/redis_exporter](https://github.com/oliver006/redis_exporter) `contrib/grafana_prometheus_redis_dashboard.json` | MIT |
| `prometheus-2-stats.json` | Prometheus 2.0 Stats | https://grafana.com/api/dashboards/15489/revisions/2/download | 2 (2022-01-13) | [linkerd/linkerd2](https://github.com/linkerd/linkerd2) `grafana/dashboards/prometheus-2-stats.json` | Apache-2.0 |

Downloaded on 2026-09-28.

Between them they cover rows (collapsed and expanded), a row with its own
datasource, `__inputs` datasources, datasource, query, custom and interval
variables, transformations, value mappings, field overrides, panel links,
the `piechart` and `bargauge` panels (which chant has no class for yet, so
the importer declares them with `definePanel`), and legacy query fields
(`step`, `intervalFactor`, `metric`) that the pinned query schema no longer
lists.

## The Prometheus 2.0 Stats dashboard, twice

`prometheus-2-stats.json` is from 2022 and is at `schemaVersion` 18: its
panels are the AngularJS `graph` and `singlestat` panels, which keep their
settings as top-level panel keys, and its datasources are names rather than
`{ type, uid }` refs. Grafana migrates all of that when it loads the
dashboard. The importer carries the `schemaVersion`, so Grafana still does,
but it has nowhere to put the top-level panel settings and reports each
panel's as a warning. The test checks those warnings.

`prometheus-2-stats.grafana-12.4.11.json` is the same revision after Grafana
12.4.11 migrated it, captured the way the `../exports/` files were: imported
through `POST /api/dashboards/import` into `grafana/grafana:12.4.11`
(commit 96836a94, defaults plus anonymous Admin access, one Prometheus
datasource with uid `prom` chosen for `DS_PROMETHEUS`), opened in the UI in
headless Chromium, and taken from Export > Export as JSON with the Classic
model, reformatted with `jq .`. This is the path the importing docs page
recommends for an old dashboard, and it round-trips with no warnings about
panel settings.

## Adding a dashboard

Download a revision from `https://grafana.com/api/dashboards/<id>/revisions/<n>/download`,
find the author's source repository and check that its license permits
redistribution, then add a row to the table above and the file name to the
corpus list in `src/import/testdata/fixtures.ts`.
