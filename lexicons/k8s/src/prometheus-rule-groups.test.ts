/**
 * The prometheus lexicon's RuleGroup inside the k8s lexicon (#2901): the same
 * group renders as a rule file and inside a PrometheusRule, whether it goes
 * in directly or through MonitoredService, and MonitoredService's older
 * alertRules input renders exactly as before.
 */
import { describe, expect, test } from "vitest";
import { load, loadAll } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import {
  RuleGroup,
  hasTool,
  prometheusSerializer,
  promtoolCheckRules,
  emitYaml,
  type RuleFileConfig,
} from "@intentius/chant-lexicon-prometheus";
import { k8sSerializer } from "./serializer";
import { PrometheusRule } from "./generated";
import { MonitoredService } from "./composites/monitored-service";

function entities(record: Record<string, unknown>): Map<string, Declarable> {
  return new Map(Object.entries(record) as Array<[string, Declarable]>);
}

function k8sDocs(record: Record<string, unknown>): Array<Record<string, any>> {
  const out = k8sSerializer.serialize(entities(record));
  return loadAll(typeof out === "string" ? out : out.primary) as Array<Record<string, any>>;
}

function ruleFile(record: Record<string, unknown>): RuleFileConfig {
  const out = prometheusSerializer.serialize(entities(record));
  return load(typeof out === "string" ? out : out.primary) as RuleFileConfig;
}

const apiGroup = () =>
  new RuleGroup({
    name: "api",
    interval: "30s",
    rules: [
      { record: "job:http_errors:ratio5m", expr: 'sum by (job) (rate(http_requests_total{code=~"5.."}[5m])) / sum by (job) (rate(http_requests_total[5m]))' },
      { alert: "ApiErrors", expr: "job:http_errors:ratio5m > 0.05", for: "10m", labels: { severity: "page" }, annotations: { summary: "5xx above 5%" } },
    ],
  });

describe("PrometheusRule takes RuleGroups", () => {
  test("an exported RuleGroup renders as the group the rule file holds, not as a reference", () => {
    const api = apiGroup();
    const rule = new PrometheusRule({ metadata: { name: "api-rules" }, spec: { groups: [api] } });
    const [doc] = k8sDocs({ api, rule });
    expect(doc.kind).toBe("PrometheusRule");
    expect(doc.spec.groups).toEqual(ruleFile({ api }).groups);
  });

  test("an inline RuleGroup renders the same way", () => {
    const rule = new PrometheusRule({ metadata: { name: "api-rules" }, spec: { groups: [apiGroup()] } });
    const [doc] = k8sDocs({ rule });
    expect(doc.spec.groups).toEqual(ruleFile({ api: apiGroup() }).groups);
  });

  test("plain group objects still pass through untouched", () => {
    const groups = [{ name: "raw", rules: [{ alert: "A", expr: "vector(1)" }] }];
    const [doc] = k8sDocs({ rule: new PrometheusRule({ metadata: { name: "raw" }, spec: { groups } }) });
    expect(doc.spec.groups).toEqual(groups);
  });

  test.skipIf(!hasTool(process.env.PROMTOOL ?? "promtool"))("the CRD's groups pass promtool as a rule file", () => {
    const [doc] = k8sDocs({ rule: new PrometheusRule({ metadata: { name: "api-rules" }, spec: { groups: [apiGroup()] } }) });
    const r = promtoolCheckRules(emitYaml({ groups: doc.spec.groups }));
    expect(r.ok, r.output).toBe(true);
  });
});

describe("MonitoredService ruleGroups", () => {
  const minProps = { name: "api", image: "api:1.0" };

  test("creates a PrometheusRule holding the groups", () => {
    const result = MonitoredService({ ...minProps, ruleGroups: [apiGroup()] });
    const docs = k8sDocs({ prometheusRule: result.prometheusRule });
    expect(docs[0].metadata.name).toBe("api-alerts");
    expect(docs[0].spec.groups).toEqual(ruleFile({ api: apiGroup() }).groups);
  });

  test("takes plain group props too", () => {
    const result = MonitoredService({ ...minProps, ruleGroups: [{ name: "plain", rules: [{ record: "a:b", expr: "sum(up)" }] }] });
    expect(k8sDocs({ r: result.prometheusRule })[0].spec.groups).toEqual([{ name: "plain", rules: [{ record: "a:b", expr: "sum(up)" }] }]);
  });

  test("with alertRules, the alertRules group comes first", () => {
    const result = MonitoredService({
      ...minProps,
      alertRules: [{ name: "HighError", expr: "rate(errors[5m]) > 0.1", severity: "critical" }],
      ruleGroups: [apiGroup()],
    });
    expect(k8sDocs({ r: result.prometheusRule })[0].spec.groups.map((g: { name: string }) => g.name)).toEqual(["api.rules", "api"]);
  });

  test("alertRules alone renders exactly as it did before ruleGroups existed", () => {
    const result = MonitoredService({
      ...minProps,
      alertRules: [
        { name: "HighError", expr: "rate(errors[5m]) > 0.1", for: "5m", severity: "critical", annotations: { summary: "s" } },
        { name: "NoSeverity", expr: "up == 0" },
      ],
    });
    const out = k8sSerializer.serialize(entities({ r: result.prometheusRule }));
    expect(typeof out === "string" ? out : out.primary).toBe(`apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: api-alerts
  labels:
    app.kubernetes.io/name: api
    app.kubernetes.io/managed-by: chant
    app.kubernetes.io/component: monitoring
spec:
  groups:
    - name: api.rules
      rules:
        - alert: HighError
          expr: rate(errors[5m]) > 0.1
          for: '5m'
          labels:
            severity: critical
          annotations:
            summary: s
        - alert: NoSeverity
          expr: up == 0
          labels: {}
`);
  });

  test("no rules, no PrometheusRule", () => {
    expect(MonitoredService({ ...minProps, ruleGroups: [] }).prometheusRule).toBeUndefined();
  });
});
