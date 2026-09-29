import { describe, expect, test } from "vitest";
import { expandComposite } from "@intentius/chant/composite";
import { k8sSerializer } from "@intentius/chant-lexicon-k8s";
import { loadAll } from "js-yaml";
import { Dashboard } from "./dashboard";
import { Datasource } from "./datasource";
import { StatPanel } from "./panels";
import { PromQuery } from "./query";
import { dashboardJson } from "./build";
import { GrafanaConfigMaps, grafanaConfigMapLayout, grafanaVolumes } from "./k8s";

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" });
const stat = () => new StatPanel({ title: "Up", datasource: prometheus, targets: [new PromQuery({ expr: "sum(up)" })] });
const top = new Dashboard({ title: "Top", uid: "Top_Level", panels: [stat()] });
const red = new Dashboard({ title: "RED", uid: "red", folder: "Services", panels: [stat()] });
const slo = new Dashboard({ title: "SLO", uid: "slo", folder: "Services", panels: [stat()] });
const entities = [prometheus, top, red, slo];

type Manifest = { kind: string; metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> }; data: Record<string, string> };

function manifests(instance: ReturnType<typeof GrafanaConfigMaps>): Manifest[] {
  const out = k8sSerializer.serialize(expandComposite("grafana", instance));
  return (loadAll(typeof out === "string" ? out : out.primary) as Manifest[]).filter(Boolean);
}

describe("GrafanaConfigMaps", () => {
  test("one ConfigMap per dashboard, labelled for the sidecar, holding dashboardJson(dashboard)", () => {
    const docs = manifests(GrafanaConfigMaps({ entities, namespace: "obs", labels: { team: "sre" } }));
    expect(docs.map((d) => d.metadata.name)).toEqual([
      "grafana-dashboard-top-level",
      "grafana-dashboard-red",
      "grafana-dashboard-slo",
      "grafana-datasources",
      "grafana-dashboard-providers",
    ]);
    const [topCm, redCm] = docs;
    expect(topCm.metadata).toEqual({ name: "grafana-dashboard-top-level", namespace: "obs", labels: { team: "sre", grafana_dashboard: "1" } });
    expect(topCm.data).toEqual({ "Top_Level.json": dashboardJson(top) });
    expect(redCm.metadata.annotations).toEqual({ "k8s-sidecar-target-directory": "Services" });
    expect(docs[3].metadata.labels).toEqual({ team: "sre", grafana_datasource: "1" });
    expect(Object.keys(docs[3].data)).toEqual(["chant.yaml"]);
    expect(docs[3].data["chant.yaml"]).toContain("url: http://prometheus:9090");
    expect(docs[4].metadata.labels).toEqual({ team: "sre" });
  });

  test("labels and the folder annotation can be changed or left off", () => {
    const docs = manifests(GrafanaConfigMaps({ entities: [red], name: "Obs", dashboardLabel: ["dashboards", "obs"], folderAnnotation: false }));
    expect(docs[0].metadata).toEqual({ name: "obs-dashboard-red", labels: { dashboards: "obs" } });
    const bare = manifests(GrafanaConfigMaps({ entities: [prometheus], datasourceLabel: false }));
    expect(bare.map((d) => [d.metadata.name, d.metadata.labels])).toEqual([["grafana-datasources", {}]]);
  });

  test("names stay unique and DNS-1123 when uids collide after lower-casing", () => {
    const a = new Dashboard({ title: "A", uid: "Same" });
    const b = new Dashboard({ title: "B", uid: "same" });
    expect(grafanaConfigMapLayout({ entities: [a, b] }).dashboards.map((d) => d.configMap)).toEqual(["grafana-dashboard-same", "grafana-dashboard-same-2"]);
  });
});

describe("grafanaVolumes", () => {
  test("provisioning under /etc/grafana/provisioning, each dashboard folder a projected volume of its own", () => {
    const { volumes, volumeMounts } = grafanaVolumes({ entities });
    expect(volumeMounts).toEqual([
      { name: "grafana-provisioning", mountPath: "/etc/grafana/provisioning", readOnly: true },
      { name: "grafana-dashboards-0", mountPath: "/var/lib/grafana/dashboards", readOnly: true },
      { name: "grafana-dashboards-1", mountPath: "/var/lib/grafana/dashboards/Services", readOnly: true },
    ]);
    expect(volumes).toEqual([
      {
        name: "grafana-provisioning",
        projected: {
          sources: [
            { configMap: { name: "grafana-datasources", items: [{ key: "chant.yaml", path: "datasources/chant.yaml" }] } },
            { configMap: { name: "grafana-dashboard-providers", items: [{ key: "chant.yaml", path: "dashboards/chant.yaml" }] } },
          ],
        },
      },
      { name: "grafana-dashboards-0", projected: { sources: [{ configMap: { name: "grafana-dashboard-top-level", items: [{ key: "Top_Level.json", path: "Top_Level.json" }] } }] } },
      {
        name: "grafana-dashboards-1",
        projected: {
          sources: [
            { configMap: { name: "grafana-dashboard-red", items: [{ key: "red.json", path: "red.json" }] } },
            { configMap: { name: "grafana-dashboard-slo", items: [{ key: "slo.json", path: "slo.json" }] } },
          ],
        },
      },
    ]);
  });

  test("a different dashboards path or volume name", () => {
    const { volumeMounts } = grafanaVolumes({ entities: [red] }, { dashboardsPath: "/dash/", volumeName: "g" });
    expect(volumeMounts.map((m) => [m.name, m.mountPath])).toEqual([
      ["g-provisioning", "/etc/grafana/provisioning"],
      ["g-dashboards-0", "/dash/Services"],
    ]);
  });
});
