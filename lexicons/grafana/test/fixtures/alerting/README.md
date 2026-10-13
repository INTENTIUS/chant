# Alerting provisioning files

The corpus for `src/import/alerting-roundtrip.test.ts` (import, build back,
compare), `src/import/generated-types.e2e.test.ts` (the generated source
type-checks) and `src/alerting.e2e.test.ts` (the rebuilt exports provision
into Grafana).

## Grafana's own exports

`grafana-12.4.11/` and `grafana-13.2.2/` were captured on 2026-09-28 from the
official images `grafana/grafana:12.4.11` (commit 96836a94) and
`grafana/grafana:13.2.2` (commit 1bea008f), each run locally with defaults
and anonymous Admin access, by `seed.sh`:

1. Prometheus (uid `prom`) and Loki (uid `loki`) datasources, a folder
   "Checkout alerts" (uid `chant-fx-alerts`), a notification template, two
   mute timings, three contact points (email, Slack, webhook) and a policy
   tree with nested routes, through the provisioning API.
2. One rule group, `checkout`, through
   `PUT /api/v1/provisioning/folder/chant-fx-alerts/rule-groups/checkout`,
   in the shape Grafana's rule editor saves: a Prometheus query with reduce
   and threshold (with a recovery threshold) expressions, a resample, reduce
   and math chain, a Loki query with classic conditions, and a recording
   rule; with `keepFiringFor`, `notification_settings`, `isPaused` and
   `missing_series_evals_to_resolve` among them.
3. `GET /api/v1/provisioning/{alert-rules,contact-points,policies,mute-timings}/export?format=yaml`,
   saved as it came back. The contact point export was made without
   `decrypt=true`, so the Slack URL is `[REDACTED]`, as a user's export would be.

The two versions export byte-identical files. Grafana has no export for
notification templates (`/api/v1/provisioning/templates/export` is a 404 on
both).

## Files other projects provision from

Each file is the upstream file at the commit named, byte for byte. Every one is
published under a license that permits redistribution.

| File | Upstream | Commit | License |
|---|---|---|---|
| `community/grafana-examples.alert_resources.yaml` | [grafana/provisioning-alerting-examples](https://github.com/grafana/provisioning-alerting-examples) `config-files/grafana/provisioning/alerting/alert_resources.yaml` | 8ab4c444 | Apache-2.0 |
| `community/grafana-examples.alert_rules.yaml` | same repository, `alert_rules.yaml` | 8ab4c444 | Apache-2.0 |
| `community/marin.contact-points.yaml`, `marin.mute-timings.yaml`, `marin.policies.yaml`, `marin.rules.yaml` | [marin-community/marin](https://github.com/marin-community/marin) `infra/grafana/provisioning/alerting/` | 4aa26ec7 | Apache-2.0 |
| `community/proto-fleet.contact-points.yaml`, `proto-fleet.notification-policies.yaml`, `proto-fleet.proto-fleet-rules.yaml`, `proto-fleet.proto-fleet-system-rules.yaml` | [block/proto-fleet](https://github.com/block/proto-fleet) `server/monitoring/grafana/provisioning/alerting/` | 4bb52462 | Apache-2.0 |
| `community/viya4.cas-memory-usage-high.yaml` | [sassoftware/viya4-monitoring-kubernetes](https://github.com/sassoftware/viya4-monitoring-kubernetes) `samples/alerts/cas/cas-memory-usage-high.yaml` | fd385d8a | Apache-2.0 |
| `community/eth-docker.disk_space.yml` | [ethstaker/eth-docker](https://github.com/ethstaker/eth-docker) `grafana/default-alerts/disk_space.yml` | 26ac53f0 | Apache-2.0 |

Downloaded on 2026-09-28.

Between them they cover infinity (JSON API) and PostgreSQL queries whose
datasource type the file does not state, Prometheus queries with and without
`model.datasource`, typed expressions with and without the keys Grafana's
editor adds, `deleteRules` and `deleteContactPoints` tombstones, environment
variables in contact point settings, flow-style YAML, and policy trees with
`object_matchers`, regex matchers and mute timings.

## Adding a file

Take it at a commit, check that the repository's license permits
redistribution, add a row above, and drop it in `community/`; the tests pick
up every `.yaml` and `.yml` here. For a new Grafana version, run `seed.sh
<tag> <dir>` and copy the four exports into `grafana-<tag>/`.
