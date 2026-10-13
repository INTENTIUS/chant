/**
 * PROM211-PROM224 (#3363): one failing and one passing case each, and the
 * lexicon's own composites, init templates and examples reporting none.
 */
import { describe, expect, test } from "vitest";
import { join } from "path";
import { readdirSync } from "fs";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import { build } from "@intentius/chant/build";
import { runPostSynthChecks } from "@intentius/chant/lint/post-synth";
import { genAiMetrics } from "@intentius/chant-lexicon-otel/genai";
import { postSynthChecks } from "./index";
import { prom225 } from "./prom225";
import { OPT_IN_CHECKS } from "../audit-catalog";
import { prometheusSerializer } from "../../serializer";
import { emitYaml } from "../../build";
import { ruleGroupConfig } from "../../rules";
import { GenAiRules, type GenAiAlerting } from "../../composites/genai";
import { Slo } from "../../composites/slo";
import type { RuleGroupConfig } from "../../model";

const NEW_CHECKS = postSynthChecks.filter((c) => c.id >= "PROM211" && c.id <= "PROM224");

/** The PROM211-PROM224 findings on a document, by check id. */
function found(text: string, ids?: string[]): string[] {
  const ctx = makePostSynthCtx("prometheus", text);
  return NEW_CHECKS.filter((c) => !ids || ids.includes(c.id))
    .flatMap((c) => c.check(ctx))
    .map((d) => d.checkId);
}

/** A rule file of one group holding `rule`, as YAML. */
function rules(rule: Record<string, unknown>, groupLabels?: Record<string, string>): string {
  return JSON.stringify({ groups: [{ name: "g", ...(groupLabels ? { labels: groupLabels } : {}), rules: [rule] }] });
}

/** An alert that passes every check but the one a case varies. */
function alert(over: Record<string, unknown> = {}): string {
  return rules({
    alert: "A",
    expr: "sum by (job) (rate(errors_total[5m])) > 1",
    for: "5m",
    labels: { severity: "page" },
    annotations: { summary: "errors on {{ $labels.job }}", runbook_url: "https://runbooks/a" },
    ...over,
  });
}

const record = (name: string, expr: string) => rules({ record: name, expr });

const am = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ route: { receiver: "r" }, receivers: [{ name: "r", webhook_configs: [{ url: "https://hook" }] }], ...over });

describe("the rule-file checks", () => {
  test("the baseline alert and recording rule report nothing", () => {
    expect(found(alert())).toEqual([]);
    expect(found(record("job:errors:rate5m", "sum by (job) (rate(errors_total[5m]))"))).toEqual([]);
  });

  test("PROM211 no for, or for: 0s", () => {
    expect(found(alert({ for: undefined }))).toEqual(["PROM211"]);
    expect(found(alert({ for: "0s" }))).toEqual(["PROM211"]);
    expect(found(alert({ for: "1m" }))).toEqual([]);
  });

  test("PROM211 leaves alone an expression over a window, a multi-window and, and a heartbeat", () => {
    expect(found(alert({ for: undefined, expr: "avg_over_time(job:errors:rate5m[1h]) > 1" }))).toEqual([]);
    expect(found(alert({ for: undefined, expr: "(job:errors:rate1h > 1) and (job:errors:rate5m > 1)" }))).toEqual([]);
    expect(found(alert({ for: undefined, expr: "vector(1)" }), ["PROM211", "PROM213"])).toEqual([]);
    // A for that is not a duration is PROM103's alone.
    expect(found(alert({ for: "1.5h" }))).toEqual([]);
  });

  test("PROM212 is the only finding on an alert with no runbook_url", () => {
    expect(found(alert({ annotations: { summary: "x" } }))).toEqual(["PROM212"]);
    expect(found(record("job:errors:rate5m", "sum by (job) (rate(errors_total[5m]))"), ["PROM212"])).toEqual([]);
  });

  test("PROM213 no comparison", () => {
    expect(found(alert({ expr: "sum by (job) (rate(errors_total[5m]))" }))).toEqual(["PROM213"]);
    expect(found(alert({ expr: "sum by (job) (rate(errors_total[5m])) > bool 1" }))).toEqual(["PROM213"]);
    expect(found(alert({ expr: "job:errors:rate5m > 1 or job:errors:rate1h" }))).toEqual(["PROM213"]);
    expect(found(alert({ expr: "absent(up{job=\"api\"})" }))).toEqual([]);
    expect(found(alert({ expr: "up{job=\"api\"} unless on (instance) maintenance" }))).toEqual([]);
    expect(found(alert({ expr: "sum by (job) (up == 0)" }))).toEqual([]);
  });

  test("PROM214 a template label the aggregation drops", () => {
    const reads = (expr: string) => alert({ expr, annotations: { summary: "{{ $labels.instance }} on {{ .Labels.job }}", runbook_url: "u" } });
    expect(found(reads("sum by (job) (up) == 0"))).toEqual(["PROM214"]);
    expect(found(reads("sum without (instance) (up) == 0"))).toEqual(["PROM214"]);
    expect(found(reads("sum by (job, instance) (up) == 0"))).toEqual([]);
    expect(found(reads("up == 0"))).toEqual([]);
    expect(found(reads("sum without (pod) (up) == 0"))).toEqual([]);
    // One-to-one matching on (job) keeps only job.
    expect(found(reads("sum by (job, instance) (up) / on (job) sum by (job) (up) < 0.5"))).toEqual(["PROM214"]);
    // A label the rule sets itself is left alone.
    expect(found(alert({ expr: "sum(up) == 0", labels: { severity: "page", instance: "all" }, annotations: { summary: "{{ $labels.instance }}", runbook_url: "u" } }))).toEqual([]);
  });

  test("PROM215 rate over a name that is not a counter's", () => {
    expect(found(record("job:mem:rate5m", "sum by (job) (rate(process_resident_memory_bytes[5m]))"))).toEqual(["PROM215"]);
    expect(found(record("job:mem:rate5m", "sum by (job) (increase(queue_depth[5m]))"))).toEqual(["PROM215"]);
    for (const name of ["errors_total", "req_seconds_count", "req_seconds_sum", "req_seconds_bucket"]) {
      expect(found(record("job:x:rate5m", `sum by (job) (rate(${name}[5m]))`))).toEqual([]);
    }
    expect(found(record("job:mem:deriv5m", "sum by (job) (deriv(process_resident_memory_bytes[5m]))"))).toEqual([]);
  });

  test("PROM216 histogram_quantile without _bucket or without le", () => {
    expect(found(record("job:lat:p95", "histogram_quantile(0.95, sum by (job) (rate(req_seconds_bucket[5m])))"))).toEqual(["PROM216"]);
    expect(found(record("job:lat:p95", "histogram_quantile(0.95, sum without (le) (rate(req_seconds_bucket[5m])))"))).toEqual(["PROM216"]);
    expect(found(record("job:lat:p95", "histogram_quantile(0.95, sum by (job, le) (rate(req_seconds_count[5m])))"))).toEqual(["PROM216"]);
    expect(found(record("job:lat:p95", "histogram_quantile(0.95, sum by (job, le) (rate(req_seconds_bucket[5m])))"))).toEqual([]);
    expect(found(record("job:lat:p95", "histogram_quantile(0.95, rate(req_seconds_bucket[5m]))"))).toEqual([]);
  });

  test("PROM217 recording rule names", () => {
    expect(found(record("errors_rate", "sum(rate(errors_total[5m]))"))).toEqual(["PROM217"]);
    expect(found(record("job:errors", "sum by (job) (rate(errors_total[5m]))"))).toEqual(["PROM217"]);
    expect(found(record("job::rate5m", "sum by (job) (rate(errors_total[5m]))"))).toEqual(["PROM217"]);
    expect(found(record("instance_path:requests:rate5m", "sum by (instance, path) (rate(requests_total[5m]))"))).toEqual([]);
  });

  test("PROM218 a regex that needs none, or is anchored", () => {
    expect(found(record("job:e:rate5m", 'sum by (job) (rate(errors_total{job=~"api"}[5m]))'))).toEqual(["PROM218"]);
    expect(found(record("job:e:rate5m", 'sum by (job) (rate(errors_total{job!~"api"}[5m]))'))).toEqual(["PROM218"]);
    expect(found(record("job:e:rate5m", 'sum by (job) (rate(errors_total{job=~"^api.*"}[5m]))'))).toEqual(["PROM218"]);
    expect(found(record("job:e:rate5m", 'sum by (job) (rate(errors_total{job=~"api.*$"}[5m]))'))).toEqual(["PROM218"]);
    expect(found(record("job:e:rate5m", 'sum by (job) (rate(errors_total{job=~"api|web", code=~"5.."}[5m]))'))).toEqual([]);
  });

  test("PROM219 alertname set on the rule or the group", () => {
    expect(found(alert({ labels: { severity: "page", alertname: "B" } }))).toEqual(["PROM219"]);
    expect(found(rules(JSON.parse(alert()).groups[0].rules[0], { alertname: "B" }))).toEqual(["PROM219"]);
  });

  test("an expression that does not parse is PROM104's alone", () => {
    expect(found(alert({ expr: "sum by (job) (rate(x[5m]) >" }))).toEqual([]);
  });
});

describe("the alertmanager.yml checks", () => {
  test("the baseline config reports nothing", () => {
    expect(found(am())).toEqual([]);
  });

  test("PROM220 insecure_skip_verify on a receiver or in global", () => {
    const insecure = { url: "https://hook", http_config: { tls_config: { insecure_skip_verify: true } } };
    expect(found(am({ receivers: [{ name: "r", webhook_configs: [insecure] }] }))).toEqual(["PROM220"]);
    expect(found(am({ global: { http_config: { tls_config: { insecure_skip_verify: true } } } }))).toEqual(["PROM220"]);
    expect(found(am({ receivers: [{ name: "r", email_configs: [{ to: "a@b.c", smarthost: "s:25", from: "x@b.c", tls_config: { insecure_skip_verify: true } }] }] }))).toEqual(["PROM220"]);
    expect(found(am({ receivers: [{ name: "r", webhook_configs: [{ url: "https://hook", http_config: { tls_config: { insecure_skip_verify: false } } }] }] }))).toEqual([]);
  });

  test("PROM221 SMTP auth with require_tls false", () => {
    const email = (entry: Record<string, unknown>, global: Record<string, unknown> = {}) =>
      am({ global, receivers: [{ name: "r", email_configs: [{ to: "a@b.c", smarthost: "s:25", from: "x@b.c", ...entry }] }] });
    expect(found(email({ require_tls: false, auth_username: "u", auth_password_file: "/p" }))).toEqual(["PROM221"]);
    expect(found(email({ auth_username: "u" }, { smtp_require_tls: false, smtp_auth_password_file: "/p" }))).toEqual(["PROM221"]);
    expect(found(email({ require_tls: false }))).toEqual([]);
    expect(found(email({ auth_password_file: "/p" }))).toEqual([]);
    expect(found(email({ require_tls: false, auth_password_file: "/p", force_implicit_tls: true }))).toEqual([]);
  });

  test("PROM222 credentials sent to an http:// URL", () => {
    const hook = (entry: Record<string, unknown>, global: Record<string, unknown> = {}) => am({ global, receivers: [{ name: "r", webhook_configs: [entry] }] });
    expect(found(hook({ url: "http://user:pass@hook/" }))).toEqual(["PROM222"]);
    expect(found(hook({ url: "http://hook/", http_config: { bearer_token_file: "/t" } }))).toEqual(["PROM222"]);
    expect(found(hook({ url: "http://hook/" }, { http_config: { basic_auth: { username: "u", password_file: "/p" } } }))).toEqual(["PROM222"]);
    expect(found(hook({ url: "http://hook/" }))).toEqual([]);
    expect(found(hook({ url: "https://hook/", http_config: { bearer_token_file: "/t" } }))).toEqual([]);
    const opsgenie = (global: Record<string, unknown>) => am({ global, receivers: [{ name: "r", opsgenie_configs: [{ api_key_file: "/k" }] }] });
    expect(found(opsgenie({ opsgenie_api_url: "http://opsgenie.internal/" }))).toEqual(["PROM222"]);
    expect(found(opsgenie({}))).toEqual([]);
  });

  test("PROM223 repeat_interval under group_interval, inherited down the tree", () => {
    expect(found(am({ route: { receiver: "r", group_interval: "10m", repeat_interval: "5m" } }))).toEqual(["PROM223"]);
    expect(found(am({ route: { receiver: "r", repeat_interval: "1m" } }))).toEqual(["PROM223"]);
    expect(found(am({ route: { receiver: "r", group_interval: "1h", routes: [{ receiver: "r", repeat_interval: "30m" }] } }))).toEqual(["PROM223"]);
    expect(found(am({ route: { receiver: "r", group_interval: "5m", repeat_interval: "1h" } }))).toEqual([]);
  });

  test("PROM224 an inhibit rule whose sides can match one alert, with no equal", () => {
    const inhibit = (rule: Record<string, unknown>) => am({ inhibit_rules: [rule] });
    expect(found(inhibit({ source_matchers: ['severity="page"'], target_matchers: ['team="db"'] }))).toEqual(["PROM224"]);
    expect(found(inhibit({ source_matchers: ['severity=~"page|ticket"'], target_matchers: ['severity="ticket"'] }))).toEqual(["PROM224"]);
    expect(found(inhibit({ source_matchers: ['severity="page"'], target_matchers: ['team="db"'], equal: ["alertname"] }))).toEqual([]);
    expect(found(inhibit({ source_matchers: ['severity="page"'], target_matchers: ['severity="ticket"'] }))).toEqual([]);
    expect(found(inhibit({ source_matchers: ['severity=~"critical"'], target_matchers: ['severity=~"warning|info"'] }))).toEqual([]);
    expect(found(inhibit({ source_matchers: ['severity="page"'], target_matchers: ['severity!="page"'] }))).toEqual([]);
  });
});

/** Every finding the `recommended` preset reports (PROM212, opt-in, is left out). */
function recommended(text: string): string[] {
  const ctx = makePostSynthCtx("prometheus", text);
  return postSynthChecks
    .filter((c) => !OPT_IN_CHECKS.has(c.id))
    .flatMap((c) => c.check(ctx))
    .map((d) => `${d.checkId} ${d.message}`);
}

const groupYaml = (group: RuleGroupConfig) => emitYaml({ groups: [group] });

describe("the lexicon's own rules report none of the checks", () => {
  const prices = [{ provider: "anthropic", model: "m1", inputPerMTok: 3, outputPerMTok: 15, currency: "USD", source: "https://example.com", asOf: "2026-09-29" }];
  const alerts: GenAiAlerting = {
    errorRatio: true,
    latency: true,
    toolErrorRatio: true,
    budgets: [
      { amount: 5, currency: "USD", per: "hour" },
      { amount: 50, currency: "USD", per: "day" },
    ],
  };

  test.each([
    ["spans", genAiMetrics()],
    ["client", genAiMetrics({ clientMetrics: "derive" })],
  ] as const)("GenAiRules over the %s metrics, with and without its alerts", (_label, genAi) => {
    expect(recommended(groupYaml(ruleGroupConfig(GenAiRules({ genAi, prices }).rules)))).toEqual([]);
    expect(recommended(groupYaml(ruleGroupConfig(GenAiRules({ genAi, prices, alerts }).rules)))).toEqual([]);
  });

  test("Slo, with each SLI form and with tickets off", () => {
    const calls = "traces_span_metrics_calls_total";
    const slos = [
      Slo({
        name: "a",
        objective: 0.995,
        window: "28d",
        sli: { good: `sum(rate(${calls}{status_code!="STATUS_CODE_ERROR"}[{{window}}]))`, total: `sum(rate(${calls}[{{window}}]))` },
      }),
      Slo({
        name: "b",
        objective: 0.999,
        window: "30d",
        sli: { errors: `sum(rate(${calls}{status_code="STATUS_CODE_ERROR"}[{{window}}]))`, total: `sum(rate(${calls}[{{window}}]))` },
        alerting: { ticket: false },
      }),
    ];
    for (const slo of slos) expect(recommended(groupYaml(ruleGroupConfig(slo.rules)))).toEqual([]);
  });

  const examplesDir = join(import.meta.dirname, "..", "..", "..", "examples");
  const examples = readdirSync(examplesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  test.each(examples)("the %s example", async (name) => {
    const result = await build(join(examplesDir, name, "src"), [prometheusSerializer]);
    expect(result.errors).toEqual([]);
    const diags = runPostSynthChecks(postSynthChecks, result).filter((d) => !OPT_IN_CHECKS.has(d.checkId));
    expect(diags).toEqual([]);
  });
});

describe("PROM225 labeldrop and labelkeep fields", () => {
  const prom = (step: Record<string, unknown>) =>
    JSON.stringify({ scrape_configs: [{ job_name: "j", static_configs: [{ targets: ["a:1"] }], metric_relabel_configs: [step] }] });
  const run = (text: string) => prom225.check(makePostSynthCtx("prometheus", text));

  test("a labeldrop with only regex reports nothing", () => {
    expect(run(prom({ action: "labeldrop", regex: "tmp_.*" }))).toEqual([]);
    expect(run(prom({ action: "replace", source_labels: ["a"], target_label: "b" }))).toEqual([]);
  });

  test("each foreign field on labeldrop or labelkeep is reported once per step", () => {
    for (const action of ["labeldrop", "labelkeep"]) {
      for (const field of ["source_labels", "separator", "target_label", "modulus", "replacement"]) {
        const diags = run(prom({ action, regex: "x", [field]: field === "modulus" ? 2 : field === "source_labels" ? ["a"] : "v" }));
        expect(diags.map((d) => d.checkId), `${action} ${field}`).toEqual(["PROM225"]);
        expect(diags[0].entity).toBe("scrape_configs[0].metric_relabel_configs[0]");
        expect(diags[0].message).toContain(field);
      }
    }
  });

  test("steps under remote_write and alerting are read too", () => {
    const text = JSON.stringify({
      alerting: { alert_relabel_configs: [{ action: "labelkeep", regex: "a", replacement: "$1" }] },
      remote_write: [{ url: "http://r", write_relabel_configs: [{ action: "labeldrop", regex: "a", separator: ";" }] }],
    });
    expect(run(text).map((d) => d.entity)).toEqual([
      "alerting.alert_relabel_configs[0]",
      "remote_write[0].write_relabel_configs[0]",
    ]);
  });
});
