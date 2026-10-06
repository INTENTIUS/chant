/**
 * WK8701-WK8705: Prometheus Operator selection checks, and WK8606: the PROM
 * rule checks over PrometheusRule groups (chant #3366).
 */
import { describe, expect, test } from "vitest";
import { dump } from "js-yaml";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import { wk8606 } from "./wk8606";
import { wk8701 } from "./wk8701";
import { wk8702 } from "./wk8702";
import { wk8703 } from "./wk8703";
import { wk8704 } from "./wk8704";
import { wk8705 } from "./wk8705";

const yaml = (...docs: object[]) => makePostSynthCtx("k8s", docs.map((d) => dump(d, { lineWidth: -1 })).join("---\n"));

const MON = "monitoring.coreos.com/v1";
const ALPHA = "monitoring.coreos.com/v1alpha1";

const meta = (name: string, namespace = "monitoring", labels?: Record<string, string>) => ({
  name,
  namespace,
  ...(labels ? { labels } : {}),
});

const prometheus = (spec: Record<string, unknown>, namespace = "monitoring") => ({
  apiVersion: MON,
  kind: "Prometheus",
  metadata: meta("main", namespace),
  spec,
});

const rule = (labels: Record<string, string> = { role: "alert" }, namespace = "monitoring") => ({
  apiVersion: MON,
  kind: "PrometheusRule",
  metadata: meta("rules", namespace, labels),
  spec: { groups: [{ name: "g", rules: [{ alert: "Down", expr: "up == 0", for: "5m" }] }] },
});

describe("WK8701: PrometheusRule selected by no Prometheus or ThanosRuler", () => {
  test("a null ruleSelector selects nothing", () => {
    const d = wk8701.check(yaml(prometheus({ ruleSelector: null }), rule()));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ checkId: "WK8701", severity: "warning", entity: "rules" });
    expect(d[0].message).toContain("PrometheusRule monitoring/rules");
  });

  test("an absent ruleSelector counts as null", () => {
    expect(wk8701.check(yaml(prometheus({}), rule()))).toHaveLength(1);
  });

  test("an empty ruleSelector selects every rule", () => {
    expect(wk8701.check(yaml(prometheus({ ruleSelector: {} }), rule()))).toEqual([]);
  });

  test("a null ruleNamespaceSelector selects only the Prometheus's own namespace", () => {
    const other = rule({ role: "alert" }, "apps");
    expect(wk8701.check(yaml(prometheus({ ruleSelector: {}, ruleNamespaceSelector: null }), other))).toHaveLength(1);
    expect(wk8701.check(yaml(prometheus({ ruleSelector: {} }), other))).toHaveLength(1);
    expect(wk8701.check(yaml(prometheus({ ruleSelector: {} }), rule()))).toEqual([]);
  });

  test("an empty ruleNamespaceSelector selects every namespace", () => {
    expect(wk8701.check(yaml(prometheus({ ruleSelector: {}, ruleNamespaceSelector: {} }), rule({ role: "alert" }, "apps")))).toEqual([]);
  });

  test("matchLabels and matchExpressions pick by the rule's labels", () => {
    const sel = (s: object) => wk8701.check(yaml(prometheus({ ruleSelector: s }), rule({ role: "alert", team: "a" })));
    expect(sel({ matchLabels: { role: "alert" } })).toEqual([]);
    expect(sel({ matchLabels: { role: "other" } })).toHaveLength(1);
    expect(sel({ matchExpressions: [{ key: "team", operator: "In", values: ["a", "b"] }] })).toEqual([]);
    expect(sel({ matchExpressions: [{ key: "team", operator: "NotIn", values: ["a"] }] })).toHaveLength(1);
    expect(sel({ matchExpressions: [{ key: "team", operator: "Exists" }] })).toEqual([]);
    expect(sel({ matchExpressions: [{ key: "team", operator: "DoesNotExist" }] })).toHaveLength(1);
  });

  test("a namespace label selector matches the name label, and a declared Namespace's labels", () => {
    const p = prometheus({ ruleSelector: {}, ruleNamespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "apps" } } });
    expect(wk8701.check(yaml(p, rule({ role: "alert" }, "apps")))).toEqual([]);
    expect(wk8701.check(yaml(p, rule({ role: "alert" }, "other")))).toHaveLength(1);

    const byLabel = prometheus({ ruleSelector: {}, ruleNamespaceSelector: { matchLabels: { tier: "prod" } } });
    const ns = (labels: Record<string, string>) => ({ apiVersion: "v1", kind: "Namespace", metadata: { name: "apps", labels } });
    expect(wk8701.check(yaml(byLabel, ns({ tier: "prod" }), rule({ role: "alert" }, "apps")))).toEqual([]);
    expect(wk8701.check(yaml(byLabel, ns({ tier: "dev" }), rule({ role: "alert" }, "apps")))).toHaveLength(1);
    // The namespace is not declared in the build, so its labels are unknown.
    expect(wk8701.check(yaml(byLabel, rule({ role: "alert" }, "apps")))).toEqual([]);
  });

  test("one selecting Prometheus is enough, and a ThanosRuler counts", () => {
    const thanos = { apiVersion: MON, kind: "ThanosRuler", metadata: meta("t"), spec: { ruleSelector: {} } };
    expect(wk8701.check(yaml(prometheus({ ruleSelector: null }), thanos, rule()))).toEqual([]);
    expect(wk8701.check(yaml(prometheus({ ruleSelector: null }), prometheus({ ruleSelector: {} }, "monitoring"), rule()))).toEqual([]);
  });

  test("silent when the build has no Prometheus or ThanosRuler", () => {
    expect(wk8701.check(yaml(rule()))).toEqual([]);
    expect(wk8701.check(yaml(rule(), { apiVersion: MON, kind: "Alertmanager", metadata: meta("am"), spec: {} }))).toEqual([]);
  });
});

describe("WK8702: monitor selected by no Prometheus or PrometheusAgent", () => {
  const monitors = () => [
    { apiVersion: MON, kind: "ServiceMonitor", metadata: meta("sm", "monitoring", { app: "x" }), spec: { selector: {}, endpoints: [] } },
    { apiVersion: MON, kind: "PodMonitor", metadata: meta("pm", "monitoring", { app: "x" }), spec: { selector: {}, podMetricsEndpoints: [] } },
    { apiVersion: MON, kind: "Probe", metadata: meta("pr", "monitoring", { app: "x" }), spec: {} },
    { apiVersion: ALPHA, kind: "ScrapeConfig", metadata: meta("sc", "monitoring", { app: "x" }), spec: {} },
  ];

  test("all four selectors null: every monitor kind is reported", () => {
    const d = wk8702.check(yaml(prometheus({}), ...monitors()));
    expect(d.map((x) => x.entity).sort()).toEqual(["pm", "pr", "sc", "sm"]);
    expect(d[0]).toMatchObject({ checkId: "WK8702", severity: "warning" });
  });

  test("explicit null selectors select nothing", () => {
    const spec = { serviceMonitorSelector: null, podMonitorSelector: null, probeSelector: null, scrapeConfigSelector: null };
    expect(wk8702.check(yaml(prometheus(spec), ...monitors()))).toHaveLength(4);
  });

  test("empty selectors select every monitor of their kind", () => {
    const spec = { serviceMonitorSelector: {}, podMonitorSelector: {}, probeSelector: {}, scrapeConfigSelector: {} };
    expect(wk8702.check(yaml(prometheus(spec), ...monitors()))).toEqual([]);
  });

  test("each kind reads its own selector", () => {
    const d = wk8702.check(yaml(prometheus({ serviceMonitorSelector: {}, probeSelector: {} }), ...monitors()));
    expect(d.map((x) => x.entity).sort()).toEqual(["pm", "sc"]);
  });

  test("a null namespace selector leaves out a monitor in another namespace; {} takes it", () => {
    const other = { apiVersion: MON, kind: "ServiceMonitor", metadata: meta("sm", "apps"), spec: { selector: {}, endpoints: [] } };
    expect(wk8702.check(yaml(prometheus({ serviceMonitorSelector: {}, serviceMonitorNamespaceSelector: null }), other))).toHaveLength(1);
    expect(wk8702.check(yaml(prometheus({ serviceMonitorSelector: {}, serviceMonitorNamespaceSelector: {} }), other))).toEqual([]);
  });

  test("a PrometheusAgent selects too", () => {
    const agent = { apiVersion: ALPHA, kind: "PrometheusAgent", metadata: meta("agent"), spec: { serviceMonitorSelector: {} } };
    expect(wk8702.check(yaml(prometheus({}), agent, monitors()[0]))).toEqual([]);
    expect(wk8702.check(yaml(agent, monitors()[1]))).toHaveLength(1);
  });

  test("silent when the build has no Prometheus or PrometheusAgent", () => {
    expect(wk8702.check(yaml(...monitors()))).toEqual([]);
  });
});

describe("WK8703: AlertmanagerConfig selected by no Alertmanager", () => {
  const alertmanager = (spec: Record<string, unknown>) => ({ apiVersion: MON, kind: "Alertmanager", metadata: meta("am"), spec });
  const config = (namespace = "monitoring") => ({
    apiVersion: ALPHA,
    kind: "AlertmanagerConfig",
    metadata: meta("cfg", namespace, { team: "a" }),
    spec: { route: { receiver: "r" }, receivers: [{ name: "r" }] },
  });

  test("a null alertmanagerConfigSelector selects nothing", () => {
    const d = wk8703.check(yaml(alertmanager({ alertmanagerConfigSelector: null }), config()));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ checkId: "WK8703", severity: "warning", entity: "cfg" });
  });

  test("an absent alertmanagerConfigSelector counts as null", () => {
    expect(wk8703.check(yaml(alertmanager({}), config()))).toHaveLength(1);
  });

  test("an empty alertmanagerConfigSelector selects every config in the namespace", () => {
    expect(wk8703.check(yaml(alertmanager({ alertmanagerConfigSelector: {} }), config()))).toEqual([]);
  });

  test("a null namespace selector keeps to the Alertmanager's namespace; {} takes every one", () => {
    const am = (ns: unknown) => alertmanager({ alertmanagerConfigSelector: {}, alertmanagerConfigNamespaceSelector: ns });
    expect(wk8703.check(yaml(am(null), config("apps")))).toHaveLength(1);
    expect(wk8703.check(yaml(am({}), config("apps")))).toEqual([]);
  });

  test("matchLabels picks by the config's labels", () => {
    expect(wk8703.check(yaml(alertmanager({ alertmanagerConfigSelector: { matchLabels: { team: "a" } } }), config()))).toEqual([]);
    expect(wk8703.check(yaml(alertmanager({ alertmanagerConfigSelector: { matchLabels: { team: "b" } } }), config()))).toHaveLength(1);
  });

  test("silent when the build has no Alertmanager, whatever Prometheus is there", () => {
    expect(wk8703.check(yaml(config()))).toEqual([]);
    expect(wk8703.check(yaml(prometheus({}), config()))).toEqual([]);
  });
});

describe("WK8704: monitor selects no Service or pod, or names a missing port", () => {
  const service = (labels: Record<string, string>, ports: Array<{ name?: string; port: number }>, namespace = "apps") => ({
    apiVersion: "v1",
    kind: "Service",
    metadata: meta("web", namespace, labels),
    spec: { selector: { app: "web" }, ports },
  });
  const sm = (spec: Record<string, unknown>, namespace = "apps") => ({
    apiVersion: MON,
    kind: "ServiceMonitor",
    metadata: meta("web", namespace),
    spec,
  });

  test("a selector that matches no Service is reported, with no Prometheus in the build", () => {
    const d = wk8704.check(yaml(service({ app: "web" }, [{ name: "http", port: 80 }]), sm({ selector: { matchLabels: { app: "api" } }, endpoints: [{ port: "http" }] })));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ checkId: "WK8704", severity: "warning", entity: "web" });
    expect(d[0].message).toContain("matches no Service");
  });

  test("an empty selector matches every Service in the namespace", () => {
    expect(wk8704.check(yaml(service({ app: "web" }, [{ name: "http", port: 80 }]), sm({ selector: {}, endpoints: [{ port: "http" }] })))).toEqual([]);
  });

  test("a null or absent selector is read as empty", () => {
    expect(wk8704.check(yaml(service({ app: "web" }, [{ name: "http", port: 80 }]), sm({ selector: null, endpoints: [{ port: "http" }] })))).toEqual([]);
    expect(wk8704.check(yaml(service({ app: "web" }, [{ name: "http", port: 80 }]), sm({ endpoints: [{ port: "http" }] })))).toEqual([]);
  });

  test("a Service in another namespace is not seen unless namespaceSelector reaches it", () => {
    const svc = service({ app: "web" }, [{ name: "http", port: 80 }], "other");
    expect(wk8704.check(yaml(svc, sm({ selector: {}, endpoints: [] })))).toHaveLength(1);
    expect(wk8704.check(yaml(svc, sm({ selector: {}, namespaceSelector: { matchNames: ["other"] }, endpoints: [] })))).toEqual([]);
    expect(wk8704.check(yaml(svc, sm({ selector: {}, namespaceSelector: { any: true }, endpoints: [] })))).toEqual([]);
  });

  test("an endpoint port no matched Service names is reported", () => {
    const d = wk8704.check(yaml(service({ app: "web" }, [{ name: "http", port: 80 }]), sm({ selector: {}, endpoints: [{ port: "metrics" }, { port: "http" }] })));
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain('"metrics"');
    expect(d[0].message).toContain("http");
  });

  test("an endpoint with targetPort only is not checked", () => {
    expect(wk8704.check(yaml(service({ app: "web" }, [{ port: 80 }]), sm({ selector: {}, endpoints: [{ targetPort: 9090 }] })))).toEqual([]);
  });

  const deployment = (ports: Array<{ name?: string; containerPort: number }>) => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: meta("web", "apps"),
    spec: {
      selector: { matchLabels: { app: "web" } },
      template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "c", image: "x:1", ports }] } },
    },
  });
  const pm = (spec: Record<string, unknown>) => ({ apiVersion: MON, kind: "PodMonitor", metadata: meta("web", "apps"), spec });

  test("PodMonitor: a selector that matches no pod template is reported", () => {
    const d = wk8704.check(yaml(deployment([{ name: "metrics", containerPort: 9090 }]), pm({ selector: { matchLabels: { app: "api" } }, podMetricsEndpoints: [{ port: "metrics" }] })));
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain("matches no pod");
  });

  test("PodMonitor: an empty selector matches, and a missing container port is reported", () => {
    expect(wk8704.check(yaml(deployment([{ name: "metrics", containerPort: 9090 }]), pm({ selector: {}, podMetricsEndpoints: [{ port: "metrics" }] })))).toEqual([]);
    const d = wk8704.check(yaml(deployment([{ name: "http", containerPort: 80 }]), pm({ selector: {}, podMetricsEndpoints: [{ port: "metrics" }] })));
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain('"metrics"');
  });
});

describe("WK8705: Prometheus whose four monitor selectors are all null", () => {
  test("absent selectors are null", () => {
    const d = wk8705.check(yaml(prometheus({})));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ checkId: "WK8705", severity: "warning", entity: "main" });
    expect(d[0].message).toContain("Prometheus monitoring/main");
  });

  test("explicit nulls report", () => {
    expect(wk8705.check(yaml(prometheus({ serviceMonitorSelector: null, podMonitorSelector: null, probeSelector: null, scrapeConfigSelector: null })))).toHaveLength(1);
  });

  test("one empty selector is enough to silence it", () => {
    for (const k of ["serviceMonitorSelector", "podMonitorSelector", "probeSelector", "scrapeConfigSelector"]) {
      expect(wk8705.check(yaml(prometheus({ [k]: {} })))).toEqual([]);
    }
  });

  test("a matchLabels selector counts as set", () => {
    expect(wk8705.check(yaml(prometheus({ serviceMonitorSelector: { matchLabels: { release: "p" } } })))).toEqual([]);
  });

  test("silent without a Prometheus", () => {
    expect(wk8705.check(yaml(rule()))).toEqual([]);
  });
});

describe("WK8606: PROM checks over PrometheusRule groups", () => {
  test("a duplicate group name is PROM101, naming the PrometheusRule", () => {
    const doc = {
      apiVersion: MON,
      kind: "PrometheusRule",
      metadata: meta("rules", "obs"),
      spec: { groups: [{ name: "g", rules: [{ alert: "A", expr: "up == 0" }] }, { name: "g", rules: [{ alert: "B", expr: "up == 0" }] }] },
    };
    const d = wk8606.check(yaml(doc));
    expect(d.map((x) => x.checkId)).toContain("PROM101");
    const prom101 = d.find((x) => x.checkId === "PROM101")!;
    expect(prom101.message).toContain("PrometheusRule obs/rules");
  });

  test("a bad duration is reported under its PROM id", () => {
    const doc = {
      apiVersion: MON,
      kind: "PrometheusRule",
      metadata: meta("rules"),
      spec: { groups: [{ name: "g", interval: "soon", rules: [{ alert: "A", expr: "up == 0" }] }] },
    };
    expect(wk8606.check(yaml(doc)).map((x) => x.checkId)).toContain("PROM103");
  });

  test("a clean PrometheusRule and other kinds are silent", () => {
    expect(wk8606.check(yaml(rule()))).toEqual([]);
    expect(wk8606.check(yaml({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "c" }, data: { groups: "x" } }))).toEqual([]);
  });
});
