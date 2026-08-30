import { describe, test, expect } from "vitest";
import { expandComposite } from "@intentius/chant";
import { MonitoringStack, type MonitoringMetricSpec } from "./monitoring-stack";

const errors: MonitoringMetricSpec = {
  title: "OrdersFn Errors",
  namespace: "AWS/Lambda",
  metricName: "Errors",
  dimension: { name: "FunctionName", value: "orders-fn" },
  alarm: { threshold: 5 },
};

const duration: MonitoringMetricSpec = {
  title: "OrdersFn Duration p99",
  namespace: "AWS/Lambda",
  metricName: "Duration",
  dimension: { name: "FunctionName", value: "orders-fn" },
  statistic: "p99",
  period: 60,
};

// The composite's return is a union (which alarmN slots are present), and the
// repo-wide typecheck rightly refuses to narrow it structurally — tests go
// through a member map, the same access the expander itself uses.
type Members = Record<string, { props?: Record<string, any> } | undefined>;

describe("MonitoringStack", () => {
  test("dashboard-only metric: no alarm slot, widget carries namespace/metric/dimension", () => {
    const m = MonitoringStack({ metric1: duration }) as unknown as Members;
    expect(m.dashboard).toBeDefined();
    expect(m.alarm1).toBeUndefined();
    const body = JSON.parse(m.dashboard!.props!.DashboardBody);
    expect(body.widgets).toHaveLength(1);
    expect(body.widgets[0].properties.metrics).toEqual([["AWS/Lambda", "Duration", "FunctionName", "orders-fn"]]);
    expect(body.widgets[0].properties.stat).toBe("p99");
    expect(body.widgets[0].properties.period).toBe(60);
  });

  test("alarmed metric: alarm1 wired from the same spec, defaults filled in", () => {
    const m = MonitoringStack({ metric1: errors }) as unknown as Members;
    expect(m.alarm1).toBeDefined();
    const p = m.alarm1!.props!;
    expect(p.AlarmName).toBe("OrdersFn Errors");
    expect(p.Namespace).toBe("AWS/Lambda");
    expect(p.MetricName).toBe("Errors");
    expect(p.Dimensions).toEqual([{ Name: "FunctionName", Value: "orders-fn" }]);
    expect(p.Statistic).toBe("Sum");
    expect(p.Period).toBe(300);
    expect(p.Threshold).toBe(5);
    expect(p.ComparisonOperator).toBe("GreaterThanThreshold");
    expect(p.EvaluationPeriods).toBe(1);
  });

  test("three metrics: two alarmed (1, 3), one dashboard-only (2) — slots line up positionally", () => {
    const m = MonitoringStack({
      metric1: errors,
      metric2: duration,
      metric3: { ...errors, title: "OrdersFn Throttles", metricName: "Throttles", alarm: { threshold: 1 } },
    }) as unknown as Members;
    expect(m.alarm1).toBeDefined();
    expect(m.alarm2).toBeUndefined();
    expect(m.alarm3).toBeDefined();
    expect(m.alarm3!.props!.MetricName).toBe("Throttles");
    const body = JSON.parse(m.dashboard!.props!.DashboardBody);
    expect(body.widgets).toHaveLength(3);
    // stacked full-width, one below the last
    expect(body.widgets.map((w: any) => w.y)).toEqual([0, 6, 12]);
  });

  test("alarm.dimensionValue overrides the dashboard's literal dimension value (Ref/GetAtt escape hatch)", () => {
    const m = MonitoringStack({
      metric1: { ...errors, alarm: { threshold: 5, dimensionValue: { Ref: "OrdersFn" } as any } },
    }) as unknown as Members;
    expect(m.alarm1!.props!.Dimensions).toEqual([{ Name: "FunctionName", Value: { Ref: "OrdersFn" } }]);
    const body = JSON.parse(m.dashboard!.props!.DashboardBody);
    expect(body.widgets[0].properties.metrics[0]).toEqual(["AWS/Lambda", "Errors", "FunctionName", "orders-fn"]);
  });

  test("no dimension: metric tuple is just [namespace, metricName], alarm Dimensions is undefined", () => {
    const m = MonitoringStack({
      metric1: { title: "5xx", namespace: "AWS/ApiGateway", metricName: "5XXError", alarm: { threshold: 1 } },
    }) as unknown as Members;
    const body = JSON.parse(m.dashboard!.props!.DashboardBody);
    expect(body.widgets[0].properties.metrics).toEqual([["AWS/ApiGateway", "5XXError"]]);
    expect(m.alarm1!.props!.Dimensions).toBeUndefined();
  });

  test("alarmActions reach AlarmActions, comparisonOperator/evaluationPeriods/treatMissingData are honored", () => {
    const m = MonitoringStack({
      metric1: {
        ...errors,
        alarm: {
          threshold: 100,
          comparisonOperator: "LessThanThreshold",
          evaluationPeriods: 3,
          treatMissingData: "notBreaching",
          alarmActions: ["arn:aws:sns:us-east-1:123456789012:pages"],
        },
      },
    }) as unknown as Members;
    const p = m.alarm1!.props!;
    expect(p.ComparisonOperator).toBe("LessThanThreshold");
    expect(p.EvaluationPeriods).toBe(3);
    expect(p.TreatMissingData).toBe("notBreaching");
    expect(p.AlarmActions).toEqual(["arn:aws:sns:us-east-1:123456789012:pages"]);
  });

  test("defaults escape hatch reaches the dashboard and a named alarm slot", () => {
    const m = MonitoringStack({
      metric1: errors,
      dashboardName: "orders-dash",
      defaults: {
        dashboard: { Tags: [{ Key: "team", Value: "orders" }] },
        alarm1: { DatapointsToAlarm: 2 },
      },
    }) as unknown as Members;
    expect(m.dashboard!.props!.DashboardName).toBe("orders-dash");
    expect(m.dashboard!.props!.Tags).toEqual([{ Key: "team", Value: "orders" }]);
    expect(m.alarm1!.props!.DatapointsToAlarm).toBe(2);
  });

  test("expandComposite produces stable logical names for dashboard + alarm slots", () => {
    const instance = MonitoringStack({ metric1: errors, metric2: duration });
    const expanded = expandComposite("orders", instance);
    expect(expanded.has("ordersDashboard")).toBe(true);
    expect(expanded.has("ordersAlarm1")).toBe(true);
    expect(expanded.has("ordersAlarm2")).toBe(false);
    expect(expanded.size).toBe(2);
  });
});
