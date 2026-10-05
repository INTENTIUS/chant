import { describe, expect, test } from "vitest";
import { expandComposite } from "@intentius/chant/composite";
import { k8sSerializer } from "@intentius/chant-lexicon-k8s";
import { loadAll } from "js-yaml";
import { Dashboard } from "./dashboard";
import { Datasource } from "./datasource";
import { StatPanel } from "./panels";
import { LibraryPanel, LibraryPanelRef } from "./library-panel";
import { PromQuery } from "./query";
import { dashboardJson } from "./build";
import { Folder } from "./folder";
import { AlertRule, AlertRuleGroup, ContactPoint, MuteTiming, NotificationPolicy, NotificationTemplate } from "./alerting";
import {
  GrafanaConfigMaps,
  grafanaConfigMapLayout,
  grafanaVolumes,
  GrafanaOperatorResources,
  operatorDatasource,
  operatorPolicyRoute,
  operatorReceiverSettings,
  operatorRule,
} from "./k8s";

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" });
const stat = () => new StatPanel({ title: "Up", datasource: prometheus, targets: [new PromQuery({ expr: "sum(up)" })] });
const top = new Dashboard({ title: "Top", uid: "Top_Level", panels: [stat()] });
const red = new Dashboard({ title: "RED", uid: "red", folder: "Services", panels: [stat()] });
const slo = new Dashboard({ title: "SLO", uid: "slo", folder: "Services", panels: [stat()] });
const entities = [prometheus, top, red, slo];

type Manifest = { kind: string; metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> }; data: Record<string, string> };

function manifests(instance: ReturnType<typeof GrafanaConfigMaps> | ReturnType<typeof GrafanaOperatorResources>): Manifest[] {
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

type OperatorManifest = { apiVersion: string; kind: string; metadata: Manifest["metadata"]; spec: Record<string, unknown> };

describe("GrafanaOperatorResources (#3015)", () => {
  const selector = { matchLabels: { dashboards: "grafana" } };
  const ops = (props: Partial<Parameters<typeof GrafanaOperatorResources>[0]> = {}) =>
    manifests(GrafanaOperatorResources({ entities, instanceSelector: selector, ...props })) as unknown as OperatorManifest[];

  test("a GrafanaFolder per folder, a GrafanaDashboard per dashboard and a GrafanaDatasource per datasource", () => {
    const docs = ops({ namespace: "obs", labels: { team: "sre" } });
    expect(docs.map((d) => [d.apiVersion, d.kind, d.metadata.name])).toEqual([
      ["grafana.integreatly.org/v1beta1", "GrafanaFolder", "grafana-folder-services"],
      ["grafana.integreatly.org/v1beta1", "GrafanaDashboard", "grafana-dashboard-top-level"],
      ["grafana.integreatly.org/v1beta1", "GrafanaDashboard", "grafana-dashboard-red"],
      ["grafana.integreatly.org/v1beta1", "GrafanaDashboard", "grafana-dashboard-slo"],
      ["grafana.integreatly.org/v1beta1", "GrafanaDatasource", `grafana-datasource-${prometheus.uid}`],
    ]);
    const [folder, topDb, redDb, , ds] = docs;
    expect(folder.metadata).toEqual({ name: "grafana-folder-services", namespace: "obs", labels: { team: "sre" } });
    expect(folder.spec).toEqual({ instanceSelector: selector, uid: "services", title: "Services" });
    expect(topDb.spec).toEqual({ instanceSelector: selector, json: dashboardJson(top) });
    expect(redDb.spec).toEqual({ instanceSelector: selector, json: dashboardJson(red), folderRef: "grafana-folder-services" });
    expect(ds.spec).toEqual({
      instanceSelector: selector,
      uid: prometheus.uid,
      datasource: { name: "Prometheus", type: "prometheus", access: "proxy", url: "http://prometheus:9090", editable: false },
    });
  });

  test("nested folders name their parent; options reach every resource", () => {
    const platform = new Folder({ title: "Platform", uid: "platform" });
    const k8s = new Folder({ title: "Kubernetes", uid: "platform-k8s", parent: platform });
    const nodes = new Dashboard({ title: "Nodes", uid: "nodes", folder: k8s });
    const docs = manifests(
      GrafanaOperatorResources({ entities: [nodes], instanceSelector: {}, name: "obs", allowCrossNamespaceImport: true, resyncPeriod: "5m" }),
    ) as unknown as OperatorManifest[];
    expect(docs.map((d) => [d.kind, d.metadata.name, d.spec.parentFolderRef ?? d.spec.folderRef])).toEqual([
      ["GrafanaFolder", "obs-folder-platform", undefined],
      ["GrafanaFolder", "obs-folder-platform-k8s", "obs-folder-platform"],
      ["GrafanaDashboard", "obs-dashboard-nodes", "obs-folder-platform-k8s"],
    ]);
    for (const d of docs) expect(d.spec).toMatchObject({ instanceSelector: {}, allowCrossNamespaceImport: true, resyncPeriod: "5m" });
  });

  test("dashboardSource configMap points at the ConfigMap GrafanaConfigMaps writes", () => {
    const docs = ops({ entities: [red], dashboardSource: "configMap" });
    const sidecar = grafanaConfigMapLayout({ entities: [red] }).dashboards[0];
    expect(docs[1].spec).toEqual({ instanceSelector: selector, configMapRef: { name: sidecar.configMap, key: sidecar.key }, folderRef: "grafana-folder-services" });
  });

  test("a GrafanaLibraryPanel per library panel the dashboards place, once each, in its folder (#3186)", () => {
    const burn = new LibraryPanel({ name: "Burn rate", folder: "SLOs", panel: stat() });
    const owners = new LibraryPanel({ name: "Owners", uid: "owners", panel: stat() });
    const team = new Dashboard({
      title: "Team",
      uid: "team",
      folder: "Team A",
      panels: [burn, owners, new LibraryPanelRef({ libraryPanel: { uid: "in-grafana", name: "Already there" } })],
    });
    const other = new Dashboard({ title: "Other", uid: "other", panels: [burn] });
    const docs = ops({ entities: [prometheus, team, other] });
    expect(docs.map((d) => [d.kind, d.metadata.name])).toEqual([
      ["GrafanaFolder", "grafana-folder-slos"],
      ["GrafanaFolder", "grafana-folder-team-a"],
      ["GrafanaLibraryPanel", "grafana-library-panel-burn-rate"],
      ["GrafanaLibraryPanel", "grafana-library-panel-owners"],
      ["GrafanaDashboard", "grafana-dashboard-team"],
      ["GrafanaDashboard", "grafana-dashboard-other"],
      ["GrafanaDatasource", `grafana-datasource-${prometheus.uid}`],
    ]);
    const [, , burnDoc, ownersDoc] = docs;
    // The LibraryPanel's own folder; one without a folder goes in the first dashboard's, as the API applier puts it.
    expect(burnDoc.spec).toMatchObject({ instanceSelector: selector, uid: "burn-rate", folderRef: "grafana-folder-slos" });
    expect(ownersDoc.spec).toMatchObject({ instanceSelector: selector, uid: "owners", folderRef: "grafana-folder-team-a" });
    // The operator reads the element's name and uid from the model; the model is the panel as __elements carries it.
    const element = (JSON.parse(dashboardJson(team)) as { __elements: Record<string, { model: Record<string, unknown> }> }).__elements["burn-rate"];
    expect(JSON.parse(burnDoc.spec.json as string)).toEqual({ ...element.model, name: "Burn rate", uid: "burn-rate" });
  });

  test("datasource secrets become valuesFrom entries reading the Secret", () => {
    const loki = new Datasource({
      name: "Loki",
      type: "loki",
      url: "http://loki:3100",
      basicAuth: true,
      basicAuthUser: "${LOKI_USER}",
      secureJsonData: { basicAuthPassword: "$__env{LOKI_PASSWORD}" },
    });
    const [doc] = manifests(GrafanaOperatorResources({ entities: [loki], instanceSelector: selector, secretName: "grafana-secrets" })) as unknown as OperatorManifest[];
    expect(doc.spec.datasource).toMatchObject({ basicAuthUser: "${LOKI_USER}", secureJsonData: { basicAuthPassword: "${LOKI_PASSWORD}" } });
    expect(doc.spec.valuesFrom).toEqual([
      { targetPath: "basicAuthUser", valueFrom: { secretKeyRef: { name: "grafana-secrets", key: "LOKI_USER" } } },
      { targetPath: "secureJsonData.basicAuthPassword", valueFrom: { secretKeyRef: { name: "grafana-secrets", key: "LOKI_PASSWORD" } } },
    ]);
    expect(() => GrafanaOperatorResources({ entities: [loki], instanceSelector: selector })).toThrow(/pass secretName/);
  });

  test("a $__file secret, and fields the CRD lacks", () => {
    const base = { name: "X", type: "loki", uid: "x" };
    expect(() => operatorDatasource({ ...base, secureJsonData: { password: "$__file{/run/secret}" } }, "s")).toThrow(/cannot/);
    expect(operatorDatasource({ ...base, orgId: 1, version: 2, withCredentials: true }, undefined)).toEqual({ datasource: { name: "X", type: "loki" }, valuesFrom: [] });
  });
});

describe("GrafanaOperatorResources alerting (#3156)", () => {
  const selector = { matchLabels: { dashboards: "grafana" } };
  const GROUP = "grafana.integreatly.org/v1beta1";
  const oncall = new ContactPoint({
    name: "oncall",
    receivers: [
      { uid: "oncall-slack", type: "slack", settings: { url: "$__env{SLACK_URL}", title: "chant" } },
      { uid: "oncall-mail", type: "email", settings: { addresses: "a@example.com" }, disableResolveMessage: true },
    ],
  });
  const weekends = new MuteTiming({ name: "weekends", time_intervals: [{ weekdays: ["saturday", "sunday"] }] });
  const template = new NotificationTemplate({ name: "t", template: '{{ define "t" }}x{{ end }}' });
  const policy = new NotificationPolicy({
    receiver: oncall,
    group_by: ["alertname"],
    routes: [{ receiver: "tickets", matchers: ['severity="ticket"'], mute_time_intervals: [weekends], routes: [{ object_matchers: [["team", "=", "a"]] }] }],
  });
  const rule = new AlertRule({
    title: "High errors",
    data: [new PromQuery({ datasource: prometheus, expr: "up" })],
    dashboardUid: "dash1",
    panelId: 2,
    for: "5m",
    labels: { severity: "page" },
  });
  const group = new AlertRuleGroup({ name: "errors", folder: "Alerts", interval: "30s", rules: [rule] });
  const alerting = [oncall, weekends, template, policy, group];

  const ops = (entities: Iterable<unknown>, props: Partial<Parameters<typeof GrafanaOperatorResources>[0]> = {}) =>
    manifests(GrafanaOperatorResources({ entities: entities as never, instanceSelector: selector, secretName: "grafana-secrets", ...props })) as unknown as OperatorManifest[];

  test("one resource per alerting entity, a folder written for a group's folder title", () => {
    const docs = ops([prometheus, ...alerting]);
    expect(docs.map((d) => [d.apiVersion, d.kind, d.metadata.name])).toEqual([
      [GROUP, "GrafanaDatasource", `grafana-datasource-${prometheus.uid}`],
      [GROUP, "GrafanaFolder", "grafana-folder-alerts"],
      [GROUP, "GrafanaAlertRuleGroup", "grafana-rule-group-alerts-errors"],
      [GROUP, "GrafanaContactPoint", "grafana-contact-point-oncall"],
      [GROUP, "GrafanaNotificationPolicy", "grafana-notification-policy"],
      [GROUP, "GrafanaMuteTiming", "grafana-mute-timing-weekends"],
      [GROUP, "GrafanaNotificationTemplate", "grafana-notification-template-t"],
    ]);
    for (const d of docs.slice(1)) expect(d.spec.instanceSelector).toEqual(selector);
    expect(docs[1].spec).toMatchObject({ uid: "alerts", title: "Alerts" });
    expect(docs[5].spec).toMatchObject({ name: "weekends", time_intervals: [{ weekdays: ["saturday", "sunday"] }] });
    expect(docs[6].spec).toMatchObject({ name: "t", template: '{{ define "t" }}x{{ end }}' });
  });

  test("a rule group goes in the GrafanaFolder with its title, and its rules take the CRD's spelling", () => {
    const alerts = new Dashboard({ title: "Errors", uid: "errors", folder: "Alerts", panels: [stat()] });
    const docs = ops([prometheus, alerts, group]);
    expect(docs.map((d) => d.kind)).toEqual(["GrafanaFolder", "GrafanaDashboard", "GrafanaDatasource", "GrafanaAlertRuleGroup"]);
    const spec = docs[3].spec as { name: string; folderRef: string; interval: string; rules: Array<Record<string, unknown>> };
    expect(spec).toMatchObject({ name: "errors", folderRef: "grafana-folder-alerts", interval: "30s" });
    expect(spec.rules).toHaveLength(1);
    expect(spec.rules[0]).toMatchObject({
      uid: "high-errors",
      title: "High errors",
      condition: "A",
      for: "5m",
      noDataState: "NoData",
      execErrState: "Alerting",
      labels: { severity: "page" },
      annotations: { __dashboardUid__: "dash1", __panelId__: "2" },
    });
    expect(spec.rules[0]).not.toHaveProperty("dashboardUid");
    expect(spec.rules[0]).not.toHaveProperty("panelId");
  });

  test("operatorRule fills what the CRD requires and renames notification settings", () => {
    const out = operatorRule({
      uid: "r",
      title: "R",
      condition: "A",
      data: [],
      missing_series_evals_to_resolve: 3,
      notification_settings: { receiver: "oncall", group_by: ["a"] },
    });
    expect(out).toEqual({
      uid: "r",
      title: "R",
      condition: "A",
      data: [],
      for: "0s",
      noDataState: "NoData",
      execErrState: "Alerting",
      missingSeriesEvalsToResolve: 3,
      notificationSettings: { receiver: "oncall", group_by: ["a"] },
    });
  });

  test("contact point secrets leave the settings and become valuesFrom of their receiver", () => {
    const cp = ops(alerting).find((d) => d.kind === "GrafanaContactPoint")!;
    expect(cp.spec.name).toBe("oncall");
    expect(cp.spec.receivers).toEqual([
      {
        uid: "oncall-slack",
        type: "slack",
        settings: { title: "chant" },
        valuesFrom: [{ targetPath: "url", valueFrom: { secretKeyRef: { name: "grafana-secrets", key: "SLACK_URL" } } }],
      },
      { uid: "oncall-mail", type: "email", settings: { addresses: "a@example.com" }, disableResolveMessage: true },
    ]);
    expect(() => GrafanaOperatorResources({ entities: [oncall], instanceSelector: selector })).toThrow(/pass secretName/);
  });

  test("operatorReceiverSettings reaches nested settings and refuses what valuesFrom cannot fill", () => {
    const nested = operatorReceiverSettings("cp", { tlsConfig: { clientKey: "${KEY}", insecureSkipVerify: false }, url: "$TOKEN" }, "s");
    expect(nested.settings).toEqual({ tlsConfig: { insecureSkipVerify: false } });
    expect(nested.valuesFrom).toEqual([
      { targetPath: "tlsConfig.clientKey", valueFrom: { secretKeyRef: { name: "s", key: "KEY" } } },
      { targetPath: "url", valueFrom: { secretKeyRef: { name: "s", key: "TOKEN" } } },
    ]);
    expect(() => operatorReceiverSettings("cp", { url: "https://x/${TOKEN}" }, "s")).toThrow(/inside the text/);
    expect(() => operatorReceiverSettings("cp", { password: "$__file{/run/pw}" }, "s")).toThrow(/inside the text/);
    // Go template text with a plain `$` is not a reference.
    expect(operatorReceiverSettings("cp", { message: "{{ $labels.job }} is down" }, undefined)).toEqual({ settings: { message: "{{ $labels.job }} is down" }, valuesFrom: [] });
  });

  test("the notification policy keeps its tree inline, with Alertmanager matchers as object matchers", () => {
    const doc = ops(alerting).find((d) => d.kind === "GrafanaNotificationPolicy")!;
    expect(doc.spec.route).toEqual({
      receiver: "oncall",
      group_by: ["alertname"],
      routes: [
        {
          receiver: "tickets",
          object_matchers: [["severity", "=", "ticket"]],
          mute_time_intervals: ["weekends"],
          routes: [{ object_matchers: [["team", "=", "a"]] }],
        },
      ],
    });
    expect(operatorPolicyRoute({ orgId: 2, receiver: "x", routes: [{ matchers: ["a!~b.*"] }] })).toEqual({ receiver: "x", routes: [{ object_matchers: [["a", "!~", "b.*"]] }] });
    expect(() => operatorPolicyRoute({ receiver: "x", routes: [{ matchers: ["nonsense"] }] })).toThrow(/cannot read the route matcher/);
  });

  test("a build with no alerting writes none, and options reach the alerting resources", () => {
    expect(ops([prometheus]).map((d) => d.kind)).toEqual(["GrafanaDatasource"]);
    const docs = ops([weekends], { allowCrossNamespaceImport: true, resyncPeriod: "5m", namespace: "obs", name: "obs" });
    expect(docs[0].metadata).toEqual({ name: "obs-mute-timing-weekends", namespace: "obs" });
    expect(docs[0].spec).toMatchObject({ allowCrossNamespaceImport: true, resyncPeriod: "5m" });
  });
});
