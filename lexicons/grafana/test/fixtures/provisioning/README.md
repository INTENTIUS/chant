# Datasource provisioning files

Used by `src/import/roundtrip.test.ts` (each file is imported with
`chant import`, built back, and compared with the file here) and by
`src/import/generated-types.e2e.test.ts` (the generated source is
type-checked against the typed `jsonData` of #2951).

| File | Source | License |
|---|---|---|
| `typed-plugins.datasources.yaml` | Written for chant on 2026-09-28: one datasource of each plugin whose settings chant types, with settings a production setup commonly carries, including every datasource link the types know. It was provisioned into `grafana/grafana:13.2.2` and `grafana/grafana:12.4.11` (defaults, anonymous Admin, `GF_PLUGINS_PREINSTALL_SYNC=grafana-bigquery-datasource@3.4.2`, the file mounted under `/etc/grafana/provisioning/datasources/`), and both loaded all 13 datasources with no provisioning error. Secrets are `$__env{...}` expansions. | this repository's |
| `docker-otel-lgtm.datasources.yaml` | [grafana/docker-otel-lgtm](https://github.com/grafana/docker-otel-lgtm) `v0.34.0`, `docker/grafana-datasources.yaml`, byte for byte (sha256 `6b444d6c871737e104c70cf41a10757ee8f6d1e601773006e495cccc69e798ac`). Downloaded on 2026-09-28. | Apache-2.0 |

The docker-otel-lgtm file sets Tempo's `lokiSearch`, which the Tempo plugin
bundled with Grafana 13.2.2 (13.1.5) no longer reads. It imports and builds
back unchanged; `tsc` reports it, and the type-check test pins that.

Grafana's own provisioning examples (`devenv/datasources.yaml`) and the
dashboards its plugins ship are AGPL-3.0 and are not vendored here.
