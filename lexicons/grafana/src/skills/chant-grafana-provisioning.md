---
skill: chant-grafana-provisioning
description: Load chant-built Grafana dashboards and datasources into a running Grafana through its provisioning directories, in Docker or Kubernetes
user-invocable: true
---

# Provisioning chant-built dashboards into Grafana

`chant build src --lexicon grafana -o dist/grafana/index.json` writes, next to the index:

| Path | What Grafana does with it |
|---|---|
| `provisioning/datasources/chant.yaml` | creates or updates every declared `Datasource` |
| `provisioning/dashboards/chant.yaml` | a file provider pointing at the dashboards directory |
| `dashboards/<uid>.json`, `dashboards/<folder>/<uid>.json` | one dashboard each; the subdirectory becomes the folder |

## Docker

```bash
docker run -p 3000:3000 \
  -v "$PWD/dist/grafana/provisioning:/etc/grafana/provisioning:ro" \
  -v "$PWD/dist/grafana/dashboards:/var/lib/grafana/dashboards:ro" \
  grafana/grafana:12.4.11
```

## Kubernetes

Use `GrafanaConfigMaps({ entities, namespace })` from `@intentius/chant-lexicon-grafana/k8s` in a k8s build root. It writes one ConfigMap per dashboard labelled `grafana_dashboard: "1"`, with the folder in the `k8s-sidecar-target-directory` annotation. The datasource file goes in a ConfigMap labelled `grafana_datasource: "1"`, and the provider file in a third. The Grafana Helm chart's sidecar picks these up as they are. For a Grafana without the sidecar, spread `grafanaVolumes({ entities })`'s `volumes` and `volumeMounts` into the Deployment: provisioning goes under `/etc/grafana/provisioning`, and each dashboard folder gets a projected volume of its own. `grafanaFiles(entities)` still returns every file by path for any other layout.

## Changing where dashboards live

Declare a `DashboardProvider` to change the mount path, pin a folder, or allow UI edits:

```ts
export const provider = new DashboardProvider({ name: "team", path: "/dashboards", allowUiUpdates: true });
```

With no provider declared, chant writes one named `chant` that reads `/var/lib/grafana/dashboards` and maps subdirectories to folders.

## Checking before Grafana does

`chant lint` and `chant build` run the GRAF1xx checks on the output, including a check against Grafana's dashboard schema at the pinned version and a PromQL syntax check on every query sent to a Prometheus. To check against a real Grafana, the lexicon's `import.test.ts` boots `grafana/grafana` with Docker, provisions the example and reads each dashboard back over the HTTP API.
