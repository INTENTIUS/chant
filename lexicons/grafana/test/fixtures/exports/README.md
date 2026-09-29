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

### Newer enum values (chant #2971)

`grafana-13.2.2/cells.json` and `cells.external.json` were captured the same
way on 2026-09-28 from `grafana/grafana:13.2.2` (commit 1bea008f), from
`seed/cells.json` and the library panel `seed/owners.library-panel.json`.
They use enum values the pinned schemas lack and the overlay adds: the pill,
markdown (with `dynamicHeight`) and geo table cell types, the viridis, magma,
plasma, inferno and cividis color schemes, and the `accessible` line style.
The library panel is a markdown table, so the external export's `__elements`
carries a model with newer values too. The Classic model was picked under
Advanced options in the export drawer, since 13.2 defaults to V2 Resource.
There is no 12.4.11 capture because the `accessible` line style is new in
13.x.

### Ad hoc, group by and switch variables (chant #2952)

`drilldown.json` and `drilldown.external.json` in both version directories
were captured on 2026-09-28 from `seed/drilldown.json`, the same way, with
two differences: each Grafana ran with `GF_FEATURE_TOGGLES_ENABLE=groupByVariable`
(group by variables are experimental in 12.4 and 13.x, and without the
toggle Grafana drops them on load), and the Prometheus datasource pointed
at a running, empty `prom/prometheus:v3.15.0`, so the variables' key and
value lookups answered. The seed has query variables in object form
(`{ qryType, query, refId }`, a label-values and a series query), an ad hoc
variable with filters, base filters and static keys, a group by variable
with static options and a default, two switch variables (one with its own
enabled and disabled values), and a panel repeated over a multi-value
variable.

Two Grafana behaviours show in them:

- Grafana 12.4.11 cannot export a dashboard that has a group by variable:
  the export drawer stays empty, and `makeExportableExternally` throws
  `"groupby" not found in: query,custom,textbox,constant,datasource,interval,adhoc,system,switch`.
  The 12.4.11 captures are of the seed with the group by variable removed.
- Grafana 13.2.2 leaves the group by variable out of the "for sharing
  externally" export; the plain export keeps it.

## Adding a fixture

Run the same steps against another Grafana version (a new directory named
after the image tag) or another dashboard (a new seed). Export from the UI
rather than `GET /api/dashboards/uid/...`: the API returns what was saved,
and the UI export is what users hand to chant. If a new export fails GRAF107,
check Grafana's CUE for the dashboard kind at that version before adding an
overlay patch (see the "Where the Types Come From" docs page).
