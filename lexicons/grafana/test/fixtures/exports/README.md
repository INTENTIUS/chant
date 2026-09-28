# Grafana dashboard exports

Real dashboard JSON written by Grafana's own UI, used by
`src/schema-overlay.test.ts` to check that the pinned schemas (with the
correction overlay in `src/spec/overlay/`) accept what Grafana produces:
every classic export here must pass GRAF107 with no errors and no warnings.
Later work (dashboard import, #2945; v2 read, #2947) can reuse them.

## Provenance

Captured on 2026-09-28 from the official images `grafana/grafana:12.4.11`
(commit 96836a94) and `grafana/grafana:13.2.2` (commit 1bea008f), each run
locally with defaults plus anonymous Admin access.

1. Two datasources were created through `POST /api/datasources`: Prometheus
   (uid `prom`) and Loki (uid `loki`). Nothing was listening behind them;
   export does not query.
2. The library panel `seed/burn-rate.library-panel.json` was created through
   `POST /api/library-elements`, and the dashboards `seed/checkout.json` and
   `seed/slo.json` through `POST /api/dashboards/db`. Between them they have
   field overrides with string, object and `scope` matchers, dashboard, panel
   and field links, value mappings, transformations, a repeated panel, a
   repeated collapsed row, a library panel, a Prometheus annotation, and
   datasource, query (object-form `query`), custom, ad hoc, interval,
   constant and textbox variables.
3. Each dashboard was opened in the UI (headless Chrome) and exported from
   Export > Export as JSON with the Classic model, once as it is
   (`<name>.json`) and once with "Export for sharing externally" / "Share
   dashboard with another instance" turned on (`<name>.external.json`, which
   adds `__inputs`, `__requires` and `__elements`). The JSON is the text of
   the export drawer's editor, reformatted with `jq .`.
4. `grafana-13.2.2/checkout.v2-resource.json` is the same dashboard exported
   with the "V2 Resource" model, Grafana 13's default. It is not a classic
   dashboard and is not validated against the v1 schema; it is here for the
   v2 work.

The seed files are what was posted, before Grafana migrated them to
`schemaVersion` 42; the exports are what came back.

## Adding a fixture

Run the same steps against another Grafana version (a new directory named
after the image tag) or another dashboard (a new seed). Export from the UI
rather than `GET /api/dashboards/uid/...`: the API returns what was saved,
and the UI export is what users hand to chant. If a new export fails GRAF107,
check Grafana's CUE for the dashboard kind at that version before adding an
overlay patch (see the "Where the Types Come From" docs page).
