/**
 * Alerting entities -> `provisioning/alerting/chant.yaml`: defaults, the
 * query and expression models, references between entities, and what the
 * builder refuses. Detection of alerting files against dashboards and
 * Prometheus rule files, and the `SloAlertRules` composite.
 */
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { load } from "js-yaml";
import { Slo, sloMetrics } from "@intentius/chant-lexicon-prometheus/composites/slo";
import { looksLikeRuleFile } from "@intentius/chant-lexicon-prometheus/model";
import { Datasource, ExternalDatasource } from "./datasource";
import { Dashboard } from "./dashboard";
import { LokiQuery, PromQuery } from "./query";
import { DatasourceVariable } from "./variables";
import {
  AlertQuery,
  AlertRule,
  AlertRuleGroup,
  ClassicConditionsExpression,
  ContactPoint,
  MathExpression,
  MuteTiming,
  NotificationPolicy,
  NotificationTemplate,
  ReduceExpression,
  ResampleExpression,
  SqlExpression,
  ThresholdExpression,
} from "./alerting";
import { ALERTING_FILE, alertRuleJson, buildAlerting, contactPointJson, durationSeconds, type AlertingFile } from "./alerting-build";
import { buildGrafana } from "./build";
import { looksLikeAlertingProvisioning, looksLikeDashboard } from "./detect";
import { SloAlertRules, sloAlertQueries } from "./composites/slo-alert-rules";
import { ALERTING, fixturesDir, read } from "./import/testdata/fixtures";

type Json = Record<string, unknown>;

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", uid: "prom" });
const loki = new Datasource({ name: "Loki", type: "loki" });

describe("alert rules", () => {
  test("defaults: uid from the title, condition from the last query, 10 minutes of data, expressions with Grafana's datasource", () => {
    const r = alertRuleJson(
      new AlertRule({
        title: "Checkout errors",
        data: [
          new PromQuery({ datasource: prometheus, expr: "sum(up)", instant: true }),
          new ReduceExpression({ expression: "A", reducer: "last", settings: { mode: "dropNN" } }),
          new ThresholdExpression({ expression: "B", conditions: [{ evaluator: { type: "gt", params: [1] }, unloadEvaluator: { type: "lt", params: [0.5] } }] }),
        ],
      }),
    );
    expect(r).toEqual({
      uid: "checkout-errors",
      title: "Checkout errors",
      condition: "C",
      data: [
        { refId: "A", relativeTimeRange: { from: 600, to: 0 }, datasourceUid: "prom", model: { datasource: { type: "prometheus", uid: "prom" }, refId: "A", expr: "sum(up)", instant: true } },
        {
          refId: "B",
          datasourceUid: "__expr__",
          model: { datasource: { type: "__expr__", uid: "__expr__" }, refId: "B", type: "reduce", expression: "A", reducer: "last", settings: { mode: "dropNN" } },
        },
        {
          refId: "C",
          datasourceUid: "__expr__",
          model: {
            datasource: { type: "__expr__", uid: "__expr__" },
            refId: "C",
            type: "threshold",
            expression: "B",
            conditions: [{ evaluator: { type: "gt", params: [1] }, unloadEvaluator: { type: "lt", params: [0.5] } }],
          },
        },
      ],
    });
  });

  test("every expression type, time ranges as durations, AlertQuery with a raw model or a typed query, and the rule's own settings", () => {
    const dash = new Dashboard({ title: "Checkout", uid: "checkout" });
    const r = alertRuleJson(
      new AlertRule({
        title: "All of it",
        uid: "all",
        relativeTimeRange: { from: "1h", to: "5m" },
        data: [
          new AlertQuery({ datasource: "sql-uid", model: { rawSql: "SELECT 1", format: "table" }, refId: "Q" }),
          new AlertQuery({ query: new LokiQuery({ datasource: loki, expr: "count_over_time({a=\"b\"}[5m])" }), queryType: "instant", relativeTimeRange: { from: 300 } }),
          new ResampleExpression({ expression: "Q", window: "1m", downsampler: "mean", upsampler: "fillna" }),
          new MathExpression({ expression: "$C * 2", refId: "M" }),
          new ClassicConditionsExpression({
            conditions: [{ evaluator: { type: "gt", params: [0] }, operator: { type: "and" }, query: { params: ["M"] }, reducer: { type: "last" } }],
          }),
          new SqlExpression({ expression: "SELECT * FROM Q", format: "table" }),
        ],
        condition: "E",
        for: "5m",
        keepFiringFor: "1m",
        noDataState: "OK",
        execErrState: "KeepLast",
        missing_series_evals_to_resolve: 2,
        isPaused: true,
        dashboardUid: dash,
        panelId: 3,
        labels: { team: "a" },
      }),
    );
    expect(r.data.map((q) => [q.refId, q.datasourceUid, q.relativeTimeRange, q.queryType, (q.model as Json).type])).toEqual([
      ["Q", "sql-uid", { from: 3600, to: 300 }, undefined, undefined],
      ["B", "loki", { from: 300, to: 0 }, "instant", undefined],
      ["C", "__expr__", undefined, undefined, "resample"],
      ["M", "__expr__", undefined, undefined, "math"],
      ["E", "__expr__", undefined, undefined, "classic_conditions"],
      ["F", "__expr__", undefined, undefined, "sql"],
    ]);
    expect(r.data[0].model).toEqual({ rawSql: "SELECT 1", format: "table" });
    expect(r.data[1].model).toMatchObject({ datasource: { type: "loki", uid: "loki" }, refId: "B", expr: 'count_over_time({a="b"}[5m])' });
    expect(r).toMatchObject({ condition: "E", for: "5m", keepFiringFor: "1m", noDataState: "OK", execErrState: "KeepLast", missing_series_evals_to_resolve: 2, isPaused: true, dashboardUid: "checkout", panelId: 3 });
  });

  test("a recording rule has no condition", () => {
    const r = alertRuleJson(new AlertRule({ title: "rps", data: [new PromQuery({ datasource: prometheus, expr: "sum(rate(x[5m]))" })], record: { metric: "x:rate5m", from: "A", targetDatasourceUid: "prom" } }));
    expect(r.condition).toBeUndefined();
    expect(r.record).toEqual({ metric: "x:rate5m", from: "A", targetDatasourceUid: "prom" });
  });

  test("refuses a query with no datasource, a datasource variable, and a duration it cannot read", () => {
    expect(() => alertRuleJson(new AlertRule({ title: "t", data: [new PromQuery({ expr: "up" })] }))).toThrow(/data\[0\] has no datasource/);
    const variable = new DatasourceVariable({ name: "ds", pluginType: "prometheus" });
    expect(() => alertRuleJson(new AlertRule({ title: "t", data: [new PromQuery({ datasource: variable, expr: "up" })] }))).toThrow(/without dashboard variables/);
    expect(() => alertRuleJson(new AlertRule({ title: "t", relativeTimeRange: { from: "ten minutes" }, data: [new PromQuery({ datasource: prometheus, expr: "up" })] }))).toThrow(/not a duration/);
    expect(durationSeconds("1h30m", "x")).toBe(5400);
    expect(() => durationSeconds(1.5, "x")).toThrow(/whole number/);
  });
});

describe("the alerting file", () => {
  const oncall = new ContactPoint({
    name: "oncall",
    receivers: [
      { type: "slack", settings: { url: "$__env{SLACK_URL}" } },
      { type: "slack", settings: { url: "$__env{SLACK_URL_2}" } },
      { uid: "mail", type: "email", settings: { addresses: "a@example.com" }, disableResolveMessage: true },
    ],
  });
  const weekends = new MuteTiming({ name: "weekends", time_intervals: [{ weekdays: ["saturday", "sunday"] }] });
  const template = new NotificationTemplate({ name: "t", template: '{{ define "t" }}x{{ end }}' });
  const policy = new NotificationPolicy({
    receiver: oncall,
    group_by: ["alertname"],
    routes: [{ receiver: "tickets", object_matchers: [["severity", "=", "ticket"]], mute_time_intervals: [weekends], routes: [{ matchers: ['team="a"'], active_time_intervals: ["nights"] }] }],
  });
  const rule = new AlertRule({ title: "r", data: [new PromQuery({ datasource: prometheus, expr: "up" })], notification_settings: { receiver: oncall, mute_time_intervals: [weekends] } });
  const b = new AlertRuleGroup({ name: "b", folder: "Z", rules: [rule] });
  const a = new AlertRuleGroup({ name: "a", folder: "Z", interval: "30s", orgId: 2, rules: [] });

  test("contact point receivers get uids from the name and type, numbered when two share them", () => {
    expect(contactPointJson(oncall).receivers.map((r) => r.uid)).toEqual(["oncall-slack", "oncall-slack-2", "mail"]);
  });

  test("entities referenced by variable are written by name, and lists are sorted", () => {
    const built = buildAlerting([policy, b, template, a, weekends, oncall, prometheus])!;
    const file = built.file;
    expect(Object.keys(file)).toEqual(["apiVersion", "groups", "contactPoints", "policies", "muteTimes", "templates"]);
    expect(file.groups!.map((g) => [g.name, g.interval, g.orgId])).toEqual([["a", "30s", 2], ["b", "1m", undefined]]);
    expect(file.groups![1].rules[0].notification_settings).toEqual({ receiver: "oncall", mute_time_intervals: ["weekends"] });
    expect(file.policies).toEqual([
      {
        receiver: "oncall",
        group_by: ["alertname"],
        routes: [{ receiver: "tickets", object_matchers: [["severity", "=", "ticket"]], mute_time_intervals: ["weekends"], routes: [{ matchers: ['team="a"'], active_time_intervals: ["nights"] }] }],
      },
    ]);
    expect(built.index).toEqual({ ruleGroups: [{ name: "a", folder: "Z", rules: 0 }, { name: "b", folder: "Z", rules: 1 }], contactPoints: ["oncall"], policies: 1, muteTimings: ["weekends"], templates: ["t"] });
  });

  test("buildGrafana writes the file beside the datasources, and nothing when there is no alerting", () => {
    const built = buildGrafana(new Map<string, never>([["prometheus", prometheus as never], ["b", b as never], ["oncall", oncall as never], ["weekends", weekends as never]]));
    expect(built.index.files).toEqual([ALERTING_FILE, "provisioning/datasources/chant.yaml"]);
    expect((load(built.files[ALERTING_FILE]) as AlertingFile).apiVersion).toBe(1);
    expect(built.files[ALERTING_FILE].startsWith("# Grafana alerting provisioning, generated by chant.\n")).toBe(true);
    expect(buildGrafana([prometheus]).files[ALERTING_FILE]).toBeUndefined();
    expect(buildGrafana([prometheus]).index.alerting).toBeUndefined();
  });
});

describe("detection", () => {
  const promRules = join(fixturesDir, "..", "..", "..", "prometheus", "src", "import", "testdata");
  const ruleFiles = [
    ...["rules-full.yml"].map((f) => join(promRules, f)),
    ...readdirSync(join(promRules, "upstream"))
      .filter((f) => f.startsWith("prometheus-"))
      .map((f) => join(promRules, "upstream", f)),
  ];

  test("every alerting fixture is an alerting file, and none is a Prometheus rule file or a dashboard", () => {
    for (const f of ALERTING) {
      const doc = load(read(f));
      expect(looksLikeAlertingProvisioning(doc), f).toBe(true);
      expect(looksLikeRuleFile(doc), f).toBe(false);
      expect(looksLikeDashboard(doc), f).toBe(false);
    }
  });

  test("a Prometheus rule file is not an alerting file", () => {
    expect(ruleFiles.length).toBeGreaterThan(1);
    for (const f of ruleFiles) {
      const doc = load(readFileSync(f, "utf-8"));
      expect(looksLikeRuleFile(doc), f).toBe(true);
      expect(looksLikeAlertingProvisioning(doc), f).toBe(false);
    }
    // A PrometheusRule's spec is a rule file too.
    expect(looksLikeAlertingProvisioning({ groups: [{ name: "g", rules: [{ alert: "A", expr: "up == 0" }] }] })).toBe(false);
  });

  test("other provisioning files and unrelated YAML are not alerting files", () => {
    expect(looksLikeAlertingProvisioning({ apiVersion: 1, datasources: [] })).toBe(false);
    expect(looksLikeAlertingProvisioning({ apiVersion: 1, providers: [] })).toBe(false);
    expect(looksLikeAlertingProvisioning({ apiVersion: 1, policies: [], datasources: [] })).toBe(false);
    expect(looksLikeAlertingProvisioning({ route: { receiver: "x" }, receivers: [] })).toBe(false);
    expect(looksLikeAlertingProvisioning({ policies: [{ receiver: "x" }] })).toBe(false);
    expect(looksLikeAlertingProvisioning({ apiVersion: 1, policies: [{ receiver: "x" }] })).toBe(true);
  });
});

describe("SloAlertRules", () => {
  const slo = Slo({
    name: "checkout-with-a-rather-long-service-name",
    objective: 0.999,
    window: "30d",
    sli: { errors: 'sum(rate(http_requests_total{code=~"5.."}[{{window}}]))', total: "sum(rate(http_requests_total[{{window}}]))" },
  });

  test("one rule per burn-rate pair, reading the Slo's recorded ratios, with its thresholds and labels", () => {
    const m = sloMetrics(slo);
    const oncall = new ContactPoint({ name: "oncall", receivers: [{ type: "email", settings: { addresses: "a@example.com" } }] });
    const { rules } = SloAlertRules({ slo, datasource: prometheus, folder: "SLOs", contactPoint: oncall, for: "2m", labels: { team: "a" } });
    expect(rules.props.name).toBe(m.group);
    expect(rules.props.interval).toBe("1m");
    const built = rules.props.rules.map(alertRuleJson);
    expect(built).toHaveLength(m.burnRates.length);
    const q = sloAlertQueries(m);
    built.forEach((r, i) => {
      const b = m.burnRates[i];
      expect(r.uid!.length).toBeLessThanOrEqual(40);
      expect(r.uid).toBe(q[i].uid);
      expect(r.uid!.endsWith(`-${b.long}-${b.short}`)).toBe(true);
      expect(r.data.map((d) => (d.model as Json).expr ?? (d.model as Json).expression)).toEqual([
        `${b.longRecord}{slo="${m.name}"}`,
        `${b.shortRecord}{slo="${m.name}"}`,
        `$A > ${b.threshold} && $B > ${b.threshold}`,
      ]);
      expect(r.data.every((d) => d.datasourceUid === "prom" || d.datasourceUid === "__expr__")).toBe(true);
      expect(r.condition).toBe("C");
      expect(r.for).toBe("2m");
      expect(r.labels).toEqual({ team: "a", ...b.labels });
      expect(r.notification_settings).toEqual({ receiver: "oncall" });
      expect(r.annotations!.description).toContain(b.exhaustsIn);
    });
    expect(new Set(built.map((r) => r.uid)).size).toBe(built.length);
  });

  test("reads sloMetrics() output too, and refuses an Slo without alerting, a missing folder or a non-Prometheus datasource", () => {
    expect(SloAlertRules({ slo: sloMetrics(slo), datasource: { type: "prometheus", uid: "p" }, folder: "F" }).rules.props.rules).toHaveLength(4);
    const quiet = Slo({ name: "quiet", objective: 0.99, window: "28d", sli: { errors: "sum(rate(e[{{window}}]))", total: "sum(rate(t[{{window}}]))" }, alerting: { page: false, ticket: false } });
    expect(() => SloAlertRules({ slo: quiet, datasource: prometheus, folder: "F" })).toThrow(/alerting turned off/);
    expect(() => SloAlertRules({ slo, datasource: prometheus, folder: "" })).toThrow(/folder is required/);
    expect(() => SloAlertRules({ slo, datasource: new ExternalDatasource({ type: "loki", uid: "l" }) as never, folder: "F" })).toThrow(/must be a Prometheus datasource/);
  });
});
