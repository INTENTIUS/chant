/**
 * The upstream releases this lexicon's hand-written types follow.
 *
 * Neither Prometheus nor Alertmanager publishes a machine-readable schema for
 * its config files, so the types in `model.ts` are written against the Go
 * structs of these releases (`prometheus/model/rulefmt`,
 * `alertmanager/config`). Moving a version is a lexicon change like any
 * other, released with this package.
 */
export const PROMETHEUS_PIN = Object.freeze({
  prometheus: Object.freeze({ source: "github.com/prometheus/prometheus", version: "v3.15.0" }),
  alertmanager: Object.freeze({ source: "github.com/prometheus/alertmanager", version: "v0.34.1" }),
});
