/**
 * `GenAiRules` over the otel preset's metrics, for both the preset's own
 * `genai.*` names and the conventions' client metrics (#3041).
 *
 * The cost, ratio and latency rules are evaluated over fixed series with the
 * small evaluator in `rule-eval.ts`. `promtool check rules` runs over the
 * built file when promtool is on PATH (or named by $PROMTOOL).
 */
import { describe, expect, test } from "vitest";
import { genAiMetrics, type GenAiMetrics } from "@intentius/chant-lexicon-otel/genai";
import { GenAiRules, genAiRuleMetrics, type GenAiPrice, type GenAiRulesProps } from "./genai";
import { ruleGroupConfig } from "../rules";
import { emitYaml } from "../build";
import { RuleEvaluator, type Labels, type FiringAlert } from "../rule-eval";
import { validateRuleFile } from "../validate-config";
import { hasTool, promtoolCheckRules } from "../tools";
import { isAlertingRuleConfig, isRecordingRuleConfig, type RuleGroupConfig } from "../model";

const PROMTOOL = process.env.PROMTOOL ?? "promtool";
const hasPromtool = hasTool(PROMTOOL);
const MIN = 60_000;

const PRICES: GenAiPrice[] = [
  { provider: "anthropic", model: "m1", inputPerMTok: 3, outputPerMTok: 15, currency: "USD", source: "https://example.com/pricing", asOf: "2026-09-29" },
];

const SOURCES = {
  spans: genAiMetrics(),
  client: genAiMetrics({ clientMetrics: "derive" }),
} as const satisfies Record<string, GenAiMetrics>;

function build(genAi: GenAiMetrics, extra: Partial<GenAiRulesProps> = {}) {
  const rules = GenAiRules({ genAi, prices: PRICES, ...extra });
  return { rules, m: genAiRuleMetrics(rules), group: ruleGroupConfig(rules.rules) };
}

function exprs(group: RuleGroupConfig): string {
  return group.rules.map((r) => r.expr).join("\n");
}

/**
 * Per-minute increments of every source series. m1 (anthropic) takes 100
 * requests a minute, 10 of them failing with `timeout`; m2 (openai, not in
 * the price table) takes 60 and never fails. A tool, `search`, is called 10
 * times a minute and fails twice. m1's latency: half its requests under 1s,
 * the rest under 2s.
 */
function feed(genAi: GenAiMetrics, source: "spans" | "client"): (ev: RuleEvaluator, minute: number) => void {
  const series: Array<{ labels: Labels; perMin: number }> = [];
  const add = (labels: Labels, perMin: number) => series.push({ labels, perMin });
  const calls = genAi.calls.prometheus;
  const spanBuckets = `${genAi.duration.prometheus}_bucket`;

  const span = (model: string, provider: string, extra: Labels = {}) => ({
    service_name: "agent",
    span_name: "chat",
    span_kind: "SPAN_KIND_CLIENT",
    status_code: "STATUS_CODE_UNSET",
    gen_ai_operation_name: "chat",
    gen_ai_request_model: model,
    ...(provider ? { gen_ai_provider_name: provider } : {}),
    ...extra,
  });
  const err = { status_code: "STATUS_CODE_ERROR", error_type: "timeout" };
  // Tool spans come from the span metrics in both modes.
  const tool = { service_name: "agent", span_name: "execute_tool search", span_kind: "SPAN_KIND_INTERNAL", gen_ai_operation_name: "execute_tool", gen_ai_tool_name: "search" };
  add({ __name__: calls, ...tool, status_code: "STATUS_CODE_UNSET" }, 8);
  add({ __name__: calls, ...tool, status_code: "STATUS_CODE_ERROR", error_type: "tool_error" }, 2);
  for (const [le, n] of [["1", 0], ["+Inf", 10]] as const) add({ __name__: spanBuckets, ...tool, status_code: "STATUS_CODE_UNSET", le }, n);

  if (source === "spans") {
    add({ __name__: calls, ...span("m1", "") }, 90);
    add({ __name__: calls, ...span("m1", "", err) }, 10);
    add({ __name__: calls, ...span("m2", "") }, 60);
    for (const [le, n] of [["1", 50], ["2", 100], ["+Inf", 100]] as const) add({ __name__: spanBuckets, ...span("m1", ""), le }, n);
    add({ __name__: genAi.inputTokens.prometheus, gen_ai_request_model: "m1" }, 6000);
    add({ __name__: genAi.outputTokens.prometheus, gen_ai_request_model: "m1" }, 1200);
    add({ __name__: genAi.inputTokens.prometheus, gen_ai_request_model: "m2" }, 3000);
    add({ __name__: genAi.outputTokens.prometheus, gen_ai_request_model: "m2" }, 600);
  } else {
    const c = genAi.client!;
    const op = (model: string, provider: string, extra: Labels = {}) => ({ gen_ai_operation_name: "chat", gen_ai_provider_name: provider, gen_ai_request_model: model, ...extra });
    add({ __name__: `${c.operationDuration.prometheus}_count`, ...op("m1", "anthropic") }, 90);
    add({ __name__: `${c.operationDuration.prometheus}_count`, ...op("m1", "anthropic", { error_type: "timeout" }) }, 10);
    add({ __name__: `${c.operationDuration.prometheus}_count`, ...op("m2", "openai") }, 60);
    for (const [le, n] of [["1", 50], ["2", 100], ["+Inf", 100]] as const) {
      add({ __name__: `${c.operationDuration.prometheus}_bucket`, ...op("m1", "anthropic"), le }, n);
    }
    const tokens = `${c.tokenUsage.prometheus}_sum`;
    add({ __name__: tokens, ...op("m1", "anthropic"), gen_ai_token_type: "input" }, 6000);
    add({ __name__: tokens, ...op("m1", "anthropic"), gen_ai_token_type: "output" }, 1200);
    add({ __name__: tokens, ...op("m2", "openai"), gen_ai_token_type: "input" }, 3000);
    add({ __name__: tokens, ...op("m2", "openai"), gen_ai_token_type: "output" }, 600);
  }
  return (ev, minute) => {
    for (const s of series) ev.add(s.labels, minute * MIN, s.perMin * minute);
  };
}

function run(group: RuleGroupConfig, genAi: GenAiMetrics, source: "spans" | "client", minutes = 10) {
  const ev = new RuleEvaluator([group]);
  const push = feed(genAi, source);
  const firing = new Map<number, FiringAlert[]>();
  for (let minute = 0; minute <= minutes; minute++) {
    push(ev, minute);
    firing.set(minute, ev.step(minute * MIN));
  }
  const at = minutes * MIN;
  const one = (expr: string) => {
    const r = ev.query(expr, at);
    expect(r, expr).toHaveLength(1);
    return r[0].value;
  };
  return { ev, at, one, firing };
}

describe.each(["spans", "client"] as const)("GenAiRules from the %s metrics", (source) => {
  const genAi = SOURCES[source];
  const { m, group } = build(genAi);

  test("reads every metric name from GenAiMetrics", () => {
    expect(m.source).toBe(source);
    const all = exprs(group);
    if (source === "client") {
      expect(all).toContain(`${genAi.client!.operationDuration.prometheus}_count`);
      expect(all).toContain(`${genAi.client!.operationDuration.prometheus}_bucket`);
      expect(all).toContain(`${genAi.client!.tokenUsage.prometheus}_sum`);
      expect(all).not.toContain(genAi.inputTokens.prometheus);
    } else {
      expect(all).toContain(genAi.calls.prometheus);
      expect(all).toContain(`${genAi.duration.prometheus}_bucket`);
      expect(all).toContain(genAi.inputTokens.prometheus);
      expect(all).toContain(genAi.outputTokens.prometheus);
    }
    // The tool rules read the span metrics either way.
    expect(all).toContain(`rate(${genAi.calls.prometheus}{gen_ai_tool_name!=""}`);
  });

  test("a collector namespace moves the span-metric names", () => {
    const other = genAiMetrics({ namespace: "agents", ...(source === "client" ? { clientMetrics: "derive" as const } : {}) });
    const all = exprs(build(other).group);
    expect(all).toContain("agents_calls_total");
    expect(all).not.toContain("genai_calls_total");
  });

  test("builds no alerts unless asked", () => {
    expect(group.rules.every((r) => isRecordingRuleConfig(r))).toBe(true);
    expect(m.alerts).toEqual([]);
  });

  test("the rule file passes the lexicon's own checks", () => {
    const { group: withAlerts } = build(genAi, {
      alerts: { errorRatio: true, latency: true, toolErrorRatio: true, budgets: [{ amount: 10, currency: "USD", per: "hour" }, { amount: 100, currency: "USD", per: "day" }] },
      prices: [...PRICES, { provider: "anthropic", model: "m3", inputPerMTok: 1, outputPerMTok: 5, currency: "USD", source: "https://example.com/pricing" }],
    });
    expect(validateRuleFile({ groups: [withAlerts] })).toEqual([]);
  });

  test.skipIf(!hasPromtool)("promtool check rules passes", () => {
    const { group: withAlerts } = build(genAi, { alerts: { errorRatio: true, latency: true, toolErrorRatio: true, budgets: [{ amount: 10, currency: "USD", per: "day" }] } });
    const r = promtoolCheckRules(emitYaml({ groups: [withAlerts] }), PROMTOOL);
    expect(r.ran).toBe(true);
    expect(r.ok, r.output).toBe(true);
  });

  test("ratio, latency, token and cost rules over fixed series (rule-eval)", () => {
    const { one, ev, at } = run(group, genAi, source);
    const p = source === "client" ? 'gen_ai_provider_name="anthropic", ' : "";
    expect(one(`${m.requests}{${p}gen_ai_request_model="m1"}`)).toBeCloseTo(100 / 60, 9);
    expect(one(`${m.errorRatio}{gen_ai_request_model="m1"}`)).toBeCloseTo(0.1, 9);
    // No errors is a ratio of 0, not a missing series.
    expect(one(`${m.errorRatio}{gen_ai_request_model="m2"}`)).toBe(0);
    expect(one(`${m.errorRatioByType}{gen_ai_request_model="m1", error_type="timeout"}`)).toBeCloseTo(0.1, 9);
    expect(one(`${m.latency.record}{gen_ai_request_model="m1", quantile="0.5"}`)).toBeCloseTo(1, 9);
    expect(one(`${m.latency.record}{gen_ai_request_model="m1", quantile="0.95"}`)).toBeCloseTo(1.9, 9);
    // Tool spans have no model, so they are not model requests.
    expect(ev.query(`${m.requests}{gen_ai_operation_name="execute_tool"}`, at)).toEqual([]);
    expect(one(`${m.tokens}{gen_ai_request_model="m1", gen_ai_token_type="input"}`)).toBeCloseTo(100, 9);
    expect(one(`${m.tokens}{gen_ai_request_model="m1", gen_ai_token_type="output"}`)).toBeCloseTo(20, 9);
    // 100 input tokens/s at 3 per million, 20 output tokens/s at 15 per million.
    expect(one(`${m.cost}{gen_ai_token_type="input"}`)).toBeCloseTo(0.0003, 12);
    expect(one(`${m.cost}{gen_ai_token_type="output"}`)).toBeCloseTo(0.0003, 12);
    const cost = ev.query(m.cost!, at);
    expect(cost.map((e) => e.labels)).toEqual([
      expect.objectContaining({ gen_ai_provider_name: "anthropic", gen_ai_request_model: "m1", currency: "USD", gen_ai_token_type: "input" }),
      expect.objectContaining({ gen_ai_provider_name: "anthropic", gen_ai_request_model: "m1", currency: "USD", gen_ai_token_type: "output" }),
    ]);
    expect(one(`${m.tool!.calls}{gen_ai_tool_name="search"}`)).toBeCloseTo(10 / 60, 9);
    expect(one(`${m.tool!.errorRatio}{gen_ai_tool_name="search"}`)).toBeCloseTo(0.2, 9);
  });

  test("a model missing from the price table gets no cost series, not a cost of zero", () => {
    const { ev, at } = run(group, genAi, source);
    // m2 has tokens...
    expect(ev.query(`${m.tokens}{gen_ai_request_model="m2"}`, at)).toHaveLength(2);
    // ...and no cost.
    expect(ev.query(`${m.cost}{gen_ai_request_model="m2"}`, at)).toEqual([]);
    expect(group.rules.filter((r) => isRecordingRuleConfig(r) && r.record === m.cost)).toHaveLength(1);
    // No prices at all: no cost rule.
    const bare = build(genAi, { prices: [] });
    expect(bare.m.cost).toBeUndefined();
    expect(exprs(bare.group)).not.toContain(":cost:");
  });

  test("alerts fire over their thresholds and not under them (rule-eval)", () => {
    const { group: g } = build(genAi, {
      alerts: {
        errorRatio: { threshold: 0.05, for: "2m" },
        latency: { thresholdSeconds: 1.5, for: "2m" },
        toolErrorRatio: { threshold: 0.25 },
        // m1 costs 0.0006 a second: 2.16 an hour, 51.84 a day at that rate.
        budgets: [
          { amount: 2, currency: "USD", per: "hour", severity: "page" },
          { amount: 60, currency: "USD", per: "day" },
        ],
      },
    });
    const { firing } = run(g, genAi, source);
    const last = firing.get(10)!;
    const names = (xs: FiringAlert[]) => xs.map((a) => `${a.labels.alertname}${a.labels.budget ? `/${a.labels.budget}` : ""}${a.labels.gen_ai_request_model ? `/${a.labels.gen_ai_request_model}` : ""}`).sort();
    expect(names(last)).toEqual(["GenAiErrorRatioHigh/m1", "GenAiLatencyHigh/m1", "GenAiSpendOverBudget/hour"]);
    const spend = last.find((a) => a.labels.alertname === "GenAiSpendOverBudget")!;
    expect(spend.value).toBeCloseTo(2.16, 9);
    expect(spend.labels).toMatchObject({ severity: "page", currency: "USD", budget: "hour" });
    // Not before `for` has passed.
    expect(names(firing.get(2)!)).not.toContain("GenAiErrorRatioHigh/m1");
  });
});

describe("GenAiRules options", () => {
  test("source defaults to client when the metrics have it, and spans can be chosen", () => {
    expect(build(SOURCES.client).m.source).toBe("client");
    expect(build(SOURCES.client, { source: "spans" }).m.source).toBe("spans");
    expect(() => build(SOURCES.spans, { source: "client" })).toThrow(/clientMetrics/);
  });

  test("span metrics without provider: cost series take the provider from the price", () => {
    const { m, group } = build(SOURCES.spans);
    expect(m.labels.provider).toBeUndefined();
    const cost = group.rules.find((r) => isRecordingRuleConfig(r) && r.record === m.cost)!;
    expect(cost.labels).toEqual({ gen_ai_provider_name: "anthropic", gen_ai_request_model: "m1", currency: "USD" });
    expect(cost.expr).not.toContain("gen_ai_provider_name");
  });

  test("providerDimensions puts the provider on the model series", () => {
    const { m } = build(genAiMetrics({ providerDimensions: true }));
    expect(m.modelLabels).toEqual(["gen_ai_provider_name", "gen_ai_request_model", "gen_ai_operation_name"]);
    // The token sums still carry the model alone.
    expect(m.tokenLabels).toEqual(["gen_ai_request_model"]);
  });

  test("prefix, window, groupBy, name, labels and interval", () => {
    const { m, group } = build(SOURCES.client, { prefix: "llm", rateWindow: "2m", groupBy: ["job"], name: "llm-rules", labels: { team: "ai" }, interval: "1m" });
    expect(m.requests).toBe("llm:requests:rate2m");
    expect(m.modelLabels.at(-1)).toBe("job");
    expect(group.name).toBe("llm-rules");
    expect(group.labels).toEqual({ team: "ai" });
    expect(group.interval).toBe("1m");
    expect(exprs(group)).toContain("[2m]");
    expect(exprs(group)).toContain("sum by (gen_ai_tool_name, job)");
  });

  test("genAiRuleMetrics reads the instance, its group or the props alike", () => {
    const props: GenAiRulesProps = { genAi: SOURCES.client, prices: PRICES, alerts: { errorRatio: true } };
    const inst = GenAiRules(props);
    expect(genAiRuleMetrics(inst.rules)).toEqual(genAiRuleMetrics(inst));
    expect(genAiRuleMetrics(props)).toEqual(genAiRuleMetrics(inst));
    expect(genAiRuleMetrics(inst).alerts).toEqual([{ alert: "GenAiErrorRatioHigh", kind: "errorRatio", severity: "warning", threshold: 0.05 }]);
    expect(genAiRuleMetrics(inst).prices).toEqual([{ provider: "anthropic", model: "m1", currency: "USD", source: "https://example.com/pricing", asOf: "2026-09-29" }]);
  });

  test("genAiComponents()-style input ({ metrics }) is accepted", () => {
    expect(build({ metrics: SOURCES.spans } as unknown as GenAiMetrics).m.source).toBe("spans");
  });

  test.each<[string, Partial<GenAiRulesProps>, RegExp]>([
    ["currency missing", { prices: [{ ...PRICES[0], currency: "" }] }, /prices\[0\]\.currency is required/],
    ["source missing", { prices: [{ ...PRICES[0], source: undefined as unknown as string }] }, /prices\[0\]\.source is required/],
    ["negative price", { prices: [{ ...PRICES[0], inputPerMTok: -1 }] }, /inputPerMTok/],
    ["bad asOf", { prices: [{ ...PRICES[0], asOf: "Sept 29" }] }, /asOf/],
    ["same model twice", { prices: [PRICES[0], { ...PRICES[0] }] }, /again/],
    ["budget in a currency nothing is priced in", { alerts: { budgets: [{ amount: 1, currency: "EUR", per: "day" }] } }, /currency of no price/],
    ["two budgets for one window and currency", { alerts: { budgets: [{ amount: 1, currency: "USD", per: "day" }, { amount: 2, currency: "USD", per: "day" }] } }, /second budget/],
    ["ratio threshold of 1", { alerts: { errorRatio: { threshold: 1 } } }, /threshold/],
    ["bad for", { alerts: { latency: { for: "ten minutes" } } }, /for/],
    ["bad prefix", { prefix: "gen-ai" }, /prefix/],
    ["bad window", { rateWindow: "5 minutes" }, /rateWindow/],
  ])("throws on %s", (_, extra, message) => {
    expect(() => build(SOURCES.client, extra)).toThrow(message);
  });

  test("span metrics price one model per provider only when they carry no provider", () => {
    const twice: GenAiPrice[] = [PRICES[0], { ...PRICES[0], provider: "bedrock" }];
    expect(() => build(SOURCES.spans, { prices: twice })).toThrow(/no provider to tell them apart/);
    expect(() => build(SOURCES.client, { prices: twice })).not.toThrow();
  });

  test("every alert carries a severity and a summary", () => {
    const { group } = build(SOURCES.client, { alerts: { errorRatio: true, latency: true, toolErrorRatio: true, budgets: [{ amount: 1, currency: "USD", per: "day" }] } });
    const alerts = group.rules.filter(isAlertingRuleConfig);
    expect(alerts).toHaveLength(4);
    for (const a of alerts) {
      expect(a.labels?.severity).toBeTruthy();
      expect(a.annotations?.summary).toBeTruthy();
    }
  });
});
