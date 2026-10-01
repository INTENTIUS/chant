---
skill: chant-grafana-operations
description: Start a Grafana project from a template, bring existing dashboards into chant with chant import, find what changed in a running Grafana with chant lifecycle diff --live, export a Grafana as TypeScript, and apply a build over the HTTP API
user-invocable: true
---

# Operating Grafana with chant

Use this skill when a Grafana already exists: dashboards made in the UI to bring under chant, a provisioned dashboard somebody edited, or a build to push without mounting files. For writing dashboards see the chant-grafana skill; for provisioning files and ConfigMaps, chant-grafana-provisioning; for alert rules, chant-grafana-alerting.

## Start a project

```bash
chant init --lexicon grafana my-dashboards                      # a Prometheus datasource and one dashboard
chant init --lexicon grafana --template red my-dashboards       # RedDashboard over span metrics, ExternalDatasource, Folder
chant init --lexicon grafana --template k8s-pods my-dashboards  # pod dashboard delivered as sidecar ConfigMaps (k8s + grafana)
chant init --lexicon grafana --template slo my-dashboards       # Slo rules, SloDashboard and SloAlertRules (prometheus + grafana)
```

Every template builds clean and passes the GRAF checks as written. `k8s-pods` and `slo` ship a `chant.config.ts` naming both lexicons and a `build` script without `--lexicon`, so both outputs and both lexicons' checks run.

## Import dashboards you already have

Export the dashboard in Grafana (Export > Export as JSON, classic or V2 resource), then:

```bash
chant import checkout.json --output src                      # inside a project that lists grafana
chant import checkout.json --lexicon grafana --output src    # anywhere else
chant build src --lexicon grafana -o dist/grafana/index.json
```

The importer also reads `GET /api/dashboards/uid/<uid>` responses, `dashboard.grafana.app` v1 and v2 resources, and datasource, dashboard and alerting provisioning files. Each dashboard lands in `src/<uid>/`: `dashboard.ts`, `panels.ts`, one `row-<title>.ts` per row, `variables.ts`, and `datasources.ts` with an `ExternalDatasource` per datasource named by uid. Replace an `ExternalDatasource` with a `Datasource` of the same uid to provision it from chant too.

Read every import warning. Anything the lexicon can't express is reported, never dropped. Common ones: a v2 dashboard's tabs become rows, an export made for sharing turns `${DS_*}` inputs into `DatasourceVariable`s, and two imported dashboards naming one datasource both declare it (GRAF104; delete one declaration and import it from the other file).

A dashboard inside a Kubernetes ConfigMap imports with the k8s lexicon: `chant import grafana-configmaps.yaml` gives a grafana `Dashboard` as the ConfigMap's value.

## Point environments at a Grafana

Observe, export and apply read `grafana.profiles.<env>` in `chant.config.ts`. Credentials are named by environment variable, never written in the file:

```ts
import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-grafana";

export default {
  lexicons: ["grafana"],
  ownership: { stack: "shop", env: "prod" },
  grafana: {
    profiles: {
      staging: { url: "https://grafana.staging.example.com", token: { env: "GRAFANA_STAGING_TOKEN" } },
      prod: { url: "https://grafana.example.com", token: { env: "GRAFANA_PROD_TOKEN" }, orgId: 2 },
    },
  },
} satisfies ChantConfig;
```

With no profile, `GRAFANA_URL` plus `GRAFANA_TOKEN` (or `GRAFANA_USER` and `GRAFANA_PASSWORD`) is used. Grafana Cloud also needs `namespace: "stacks-<id>"`. A Viewer service account can observe and export. Applying needs Editor, or a custom role with `grafanaActionsFor("Apply", "Prune")`.

## Find what changed in Grafana

```bash
chant lifecycle diff staging --live
chant lifecycle diff staging --live --json              # the same report as data
chant lifecycle diff staging --live --update-baseline   # accept what it reported
```

Paths are in your source's terms: `panels[0].panels[1].title` is the second panel of the first row. A value you declared that differs is drift. A value you never declared, such as a panel added in the UI, is listed as unclaimed and never proposed as a change. What the build fills in (panel ids, auto grid positions, refIds) and what Grafana adds on read are not reported. A dashboard Grafana 13 stores as v2 is read at v2 and diffed after conversion, so a tab added in the UI shows as drift in the rows.

Ownership decides what counts as chant's. A dashboard loaded by one of the project's providers (named `chant` unless you declared another `DashboardProvider`), or carrying the `app.kubernetes.io/managed-by: chant` label the applier writes, is `owned`. Anything else is `foreign`. Datasources and dashboards on Grafana 11 are `unknown`, and `--owned` leaves them out.

A `DashboardProvider` can't be observed (Grafana serves no API for provisioning files) and is reported as not observed, not missing.

## Export a Grafana as TypeScript

```bash
chant import --from staging --lexicon grafana --output src
chant import --from staging --lexicon grafana --type Grafana::Dashboard --name checkout --output src
chant import --from staging --lexicon grafana --owned --output src
```

It writes every dashboard and datasource in the organisation, laid out like a file import. Datasource secrets come back as `"[REDACTED]"`, each with a warning. Replace them with `$__env{NAME}` or `$__file{path}`, which GRAF002 requires.

## Apply over the HTTP API

When the build's files can't be mounted into Grafana, or you want real folders with pinned uids, apply from an Op:

```ts
// ops/grafana.op.ts, with "build:grafana": "chant build src --lexicon grafana -o dist/grafana.json" in package.json
import { Op, phase, build } from "@intentius/chant/op";
import { grafanaApply } from "@intentius/chant-lexicon-grafana/op/builders";

export default Op({
  name: "grafana-prod",
  phases: [
    phase("Build", [build(".", { script: "build:grafana" })]),
    phase("Apply", [grafanaApply("dist/grafana.json", { environment: "prod", prune: true })]),
  ],
});
```

Run it with `chant run grafana-prod`, or from an agent through the MCP `op-run`, `op-status` and `op-signal` tools. The applier creates folders parents first with their uids, writes library panels found in `__elements`, and sends each dashboard with the project's labels. A dashboard whose live content already matches is `unchanged` and not written; a panel title edited in the UI is put back. `prune` deletes only dashboards and folders labelled with this project's stack and env. It never touches UI-saved or file-provisioned dashboards, library panels, or anything on Grafana 11, and does nothing when no `ownership.stack` is set. Datasources still come from the provisioning file.

## A loop that keeps UI edits

1. `chant lifecycle diff prod --live` shows the edit.
2. Either change the source to match and rebuild, or `chant import --from prod --name <uid>` to pull the dashboard, then copy the changed panel over.
3. Apply, or let provisioning reload, and diff again. It should report nothing.
