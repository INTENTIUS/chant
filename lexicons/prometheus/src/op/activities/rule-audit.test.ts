import { describe, expect, test } from "vitest";
import type { CommandRunner } from "@intentius/chant-lexicon-otel/op/activities/github";
import { auditedSelectors, ruleAudit } from "./rule-audit";
import type { ApiRuleGroup } from "./rules-loaded";

const GROUPS: ApiRuleGroup[] = [
  {
    name: "slo-checkout",
    rules: [
      { name: "slo:sli_error:ratio_rate5m", type: "recording", health: "ok", query: 'sum(rate(requests_total{code=~"5.."}[5m])) / sum(rate(requests_total[5m]))' },
      { name: "SloBurn", type: "alerting", health: "ok", query: 'slo:sli_error:ratio_rate5m{slo="checkout"} > 0.01' },
    ],
  },
  {
    name: "broken",
    rules: [{ name: "Gone", type: "alerting", health: "err", lastError: "many-to-many matching not allowed", query: "absent(up{job=\"gone\"}) and ALERTS" }],
  },
];

const NOW = new Date("2026-10-06T12:00:00Z");

/** A Prometheus API stand-in. `empty` lists the selectors whose count query returns nothing. */
function fakePrometheus(alerts: unknown[], empty: string[] = []) {
  const queries: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/rules") return Response.json({ status: "success", data: { groups: GROUPS } });
    if (url.pathname === "/api/v1/alerts") return Response.json({ status: "success", data: { alerts } });
    if (url.pathname === "/api/v1/query") {
      const q = url.searchParams.get("query")!;
      queries.push(q);
      const isEmpty = empty.some((s) => q === `count(last_over_time(${s}[1h]))`);
      return Response.json({ status: "success", data: { resultType: "vector", result: isEmpty ? [] : [{ metric: {}, value: [0, "3"] }] } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { f, queries };
}

describe("ruleAudit", () => {
  test("the selectors audited: distinct, without recorded series and ALERTS", () => {
    expect(auditedSelectors(GROUPS)).toEqual(['requests_total', 'requests_total{code=~"5.."}', 'up{job="gone"}']);
  });

  test("rule errors, alerts past their thresholds, and selectors nothing emits", async () => {
    const alerts = [
      { labels: { alertname: "SloBurn", slo: "checkout" }, state: "pending", activeAt: "2026-10-06T09:00:00Z" },
      { labels: { alertname: "SloBurn", slo: "search" }, state: "pending", activeAt: "2026-10-06T11:50:00Z" },
      { labels: { alertname: "Gone" }, state: "firing", activeAt: "2026-10-04T12:00:00Z" },
    ];
    const { f, queries } = fakePrometheus(alerts, ['up{job="gone"}']);
    const r = await ruleAudit({ url: "http://prom:9090", _fetch: f, _now: () => NOW });
    expect(r.findings).toEqual([
      { kind: "rule-error", subject: "broken", detail: "Gone: many-to-many matching not allowed" },
      { kind: "pending-too-long", subject: 'SloBurn{slo="checkout"}', detail: "pending for 3.0h" },
      { kind: "firing-too-long", subject: "Gone{}", detail: "firing for 48.0h" },
      { kind: "selector-no-series", subject: 'up{job="gone"}', detail: "no series in the last 1h" },
    ]);
    expect(queries).toHaveLength(3);
    expect(r.queried).toBe(3);
    expect(r.summary).toContain("| selector-no-series |");
  });

  test("the selector budget caps the queries; the rest are counted unchecked", async () => {
    const { f, queries } = fakePrometheus([]);
    const r = await ruleAudit({ _fetch: f, selectorBudget: 1, _now: () => NOW });
    expect(queries).toHaveLength(1);
    expect(r.unchecked).toBe(2);
    expect(r.summary).toContain("2 left unchecked by the budget");
  });

  test("issue mode keeps one issue current, and only when there are findings", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (bin, args) => {
      calls.push([bin, ...args]);
      if (args[1] === "list") return JSON.stringify([{ number: 7, title: "prometheus: rule audit findings", url: "https://x/issues/7" }]);
      return "";
    };
    const { f } = fakePrometheus([]);
    const r = await ruleAudit({ _fetch: f, mode: "issue", _run: run, _now: () => NOW });
    expect(r.issueUrl).toBe("https://x/issues/7");
    expect(calls[1].slice(0, 4)).toEqual(["gh", "issue", "edit", "7"]);
  });

  test("an unreadable rules API fails the audit rather than reporting nothing", async () => {
    const down = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    await expect(ruleAudit({ _fetch: down })).rejects.toThrow(/HTTP 502/);
  });
});
