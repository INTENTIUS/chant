# kube-prometheus dashboards

The 33 dashboards kube-prometheus ships, used by `src/import/roundtrip.test.ts`
(each is imported with `chant import`, built back with `chant build`, and
compared with the file here) and by `src/import/generated-types.e2e.test.ts`
(the generated source is type-checked).

## Provenance

[prometheus-operator/kube-prometheus](https://github.com/prometheus-operator/kube-prometheus)
at tag `v0.19.0` (commit `799f3d73b5adf5758c3119c9201d9f417accb6d0`),
`manifests/grafana-dashboardDefinitions.yaml` (sha256
`c5bec08ea8ff35c6aaa67e8ae30d9fee6011c8db25248c7f62ed4c9486e3b9fd`), a
ConfigMapList with one ConfigMap per dashboard. Each file here is the value
of the one `data` key of one item, named by that key, byte for byte (the
upstream values have no trailing newline). The `grafana-dashboard-configmap.yaml`
fixture of the k8s lexicon (`lexicons/k8s/src/import/testdata/embedded/`) is the
`alertmanager-overview` item of the same file.

Downloaded on 2026-09-28. The dashboards are generated from the jsonnet
mixins kube-prometheus vendors (kubernetes-mixin, node-mixin, the Prometheus,
Alertmanager and Grafana mixins); 32 are at `schemaVersion` 39 and
`grafana-overview.json` at 41.

## License

kube-prometheus is licensed under the Apache License 2.0
(https://github.com/prometheus-operator/kube-prometheus/blob/v0.19.0/LICENSE).
The files are redistributed unchanged under that license.

## What they exercise

- Rows whose `gridPos.y` leaves an empty band above them (`nodes*.json`,
  `node-rsrc-use.json`, `node-cluster-rsrc-use.json`), and a row on the
  same line as the panel after it (`prometheus-remote-write.json`). The
  importer keeps each row's `y`, so the build does not move it (chant #2992).
- Panels whose `gridPos` has no `x` (`persistentvolumesusage.json`), which
  Grafana reads as 0.
- A text panel with the Mixed datasource and no queries (`apiserver.json`).
- Values Grafana's CUE schema rejects and GRAF107 reports as errors: a
  `thresholds` without `mode`, a transformation without `options`, a table
  footer whose `fields` is `""`, and an `axisColorMode` of `"thresholds"`.
  The round trip carries them as they are; the test pins them per file.
