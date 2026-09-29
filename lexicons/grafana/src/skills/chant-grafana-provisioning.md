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

Put the two provisioning files in one ConfigMap mounted at `/etc/grafana/provisioning/datasources` and `/etc/grafana/provisioning/dashboards` (a `subPath` each, or two ConfigMaps), and the dashboard JSON in another mounted at `/var/lib/grafana/dashboards`. `grafanaFiles(entities)` returns every file by path, so a k8s composite can build those ConfigMaps from the same declarations without a second build.

## Changing where dashboards live

Declare a `DashboardProvider` to change the mount path, pin a folder, or allow UI edits:

```ts
export const provider = new DashboardProvider({ name: "team", path: "/dashboards", allowUiUpdates: true });
```

With no provider declared, chant writes one named `chant` that reads `/var/lib/grafana/dashboards` and maps subdirectories to folders. A provider with `folder` set puts every dashboard in that folder and ignores the dashboards' own `folder`; GRAF109 warns. Two providers on the same or nested paths load every dashboard twice, which GRAF109 reports as an error. A dashboard `folder` of `"Platform/Kubernetes"` nests on Grafana 13.1 and later.

## Checking before Grafana does

`chant lint` and `chant build` run the GRAF1xx checks on the output, including a check against Grafana's dashboard schema at the pinned version, a PromQL syntax check on every query sent to a Prometheus, and a check that the providers put each dashboard in its declared folder, once. To check against a real Grafana, the lexicon's `import.test.ts` boots `grafana/grafana` with Docker, provisions the example and reads each dashboard back over the HTTP API.
