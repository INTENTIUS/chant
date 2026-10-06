/** `/api/v1/rules` groups mapped to the rule-file shape and to a health summary (#3371). */

import { describe, expect, test } from "vitest";
import { evaluatedToRuleGroup, groupHealth } from "./evaluated";
import type { EvaluatedGroup } from "./ruler";

// The shape Prometheus 3.x answers `/api/v1/rules` with, one group.
const api: EvaluatedGroup = {
  name: "api",
  file: "/etc/prometheus/rules/api.yml",
  interval: 30,
  limit: 0,
  evaluationTime: 0.0012,
  lastEvaluation: "2026-10-06T08:00:00Z",
  rules: [
    { type: "recording", name: "job:http_requests:rate5m", query: "sum by (job) (rate(http_requests_total[5m]))", labels: {}, health: "ok" },
    {
      type: "alerting",
      name: "ApiHighErrorRate",
      query: 'sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.05',
      duration: 600,
      keepFiringFor: 0,
      labels: { severity: "page" },
      annotations: { summary: "API 5xx ratio above 5%" },
      health: "ok",
      state: "firing",
    },
  ],
};

describe("evaluatedToRuleGroup", () => {
  test("maps names, queries and second durations back to rule fields", () => {
    expect(evaluatedToRuleGroup(api)).toEqual({
      name: "api",
      interval: "30s",
      rules: [
        { record: "job:http_requests:rate5m", expr: "sum by (job) (rate(http_requests_total[5m]))" },
        {
          alert: "ApiHighErrorRate",
          expr: 'sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.05',
          for: "10m",
          labels: { severity: "page" },
          annotations: { summary: "API 5xx ratio above 5%" },
        },
      ],
    });
  });

  test("a mixed duration and a keep_firing_for are written the way Prometheus writes them", () => {
    const g = evaluatedToRuleGroup({ ...api, interval: 90, rules: [{ type: "alerting", name: "A", query: "up == 0", duration: 3600, keepFiringFor: 300 }] });
    expect(g.interval).toBe("1m30s");
    expect(g.rules[0]).toEqual({ alert: "A", expr: "up == 0", for: "1h", keep_firing_for: "5m" });
  });

  test("a positive limit is kept", () => {
    expect(evaluatedToRuleGroup({ ...api, limit: 10 }).limit).toBe(10);
  });
});

describe("groupHealth", () => {
  test("every rule ok is ok, with firing and pending counted", () => {
    expect(groupHealth(api)).toMatchObject({ health: "ok", failing: 0, firing: 1, pending: 0 });
  });

  test("one failing rule makes the group err and names the first error", () => {
    const g = { ...api, rules: [{ ...api.rules[0], health: "err", lastError: "vector contains metrics with the same labelset" }, api.rules[1]] };
    expect(groupHealth(g)).toMatchObject({
      health: "err",
      failing: 1,
      lastError: "job:http_requests:rate5m: vector contains metrics with the same labelset",
    });
  });

  test("a rule not yet evaluated, or an empty group, is unknown", () => {
    expect(groupHealth({ ...api, rules: [{ ...api.rules[0], health: "unknown" }] }).health).toBe("unknown");
    expect(groupHealth({ ...api, rules: [] }).health).toBe("unknown");
  });
});
