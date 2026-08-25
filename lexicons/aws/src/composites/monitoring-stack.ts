/**
 * MonitoringStack — a CloudWatch dashboard wired to up to three named
 * metrics, with an optional alarm per metric.
 *
 * The recurring hand-rolled shape the aws-bench corpus surfaced: a team
 * stands up a `cloudwatch.Dashboard`, a `cloudwatch.Metric` per resource it
 * cares about, and a near-identical `cloudwatch.Alarm` next to each one — 44
 * combined dashboard+alarm+metric instantiations across the corpus' 8 real
 * CDK apps, nothing equivalent shipped in chant (epic #1139).
 *
 * Fixed `metric1..metric3` slots, not a `metrics: MetricSpec[]` array — a
 * loop building `Alarm` resources from an array is exactly the control-flow-
 * over-resources shape EVL002/EVL003 rule out for reference composites (see
 * `EksCluster`'s `addon1..addon3`, this directory). A fourth metric is a bare
 * `Alarm` + a hand-edited `CwDashboard.DashboardBody` the estate declares
 * directly.
 *
 * What is deliberately NOT here:
 *  - Notification wiring. `alarm.alarmActions` on each metric takes ARNs the
 *    caller already has (an SNS topic from `LambdaSns`, or hand-declared);
 *    this composite does not create a `Topic`/`Subscription` itself — who
 *    gets paged and on what channel is a real per-estate decision, not a
 *    default worth guessing. `defaults.alarm1..3` is the escape hatch for
 *    anything else on the alarm (e.g. `OKActions`, `DatapointsToAlarm`).
 *  - Math-expression / composite / anomaly-detection alarms (`Alarm.Metrics`,
 *    `AlarmModel`) — single-metric threshold alarms only.
 *  - Dynamic (`Ref`/`GetAtt`/`Sub`) values inside the dashboard body.
 *    `CwDashboard.DashboardBody` is one flat JSON string CloudFormation does
 *    not template, so each metric's `namespace`/`metricName`/`dimension.value`
 *    must be a literal the caller already knows — the physical name they set
 *    on the monitored resource, not one CloudFormation generates. The `Alarm`
 *    resources carry no such limit: `Dimensions` is a real structured
 *    property, so `alarm.dimensionValue` accepts `Value<string>` and can
 *    reference a sibling resource by `Ref`/`GetAtt`.
 */
import { Composite, mergeDefaults, type Value } from "@intentius/chant";
import { Alarm, CwDashboard } from "../generated";

export interface MonitoringMetricSpec {
  /** Dashboard widget title, and the alarm's default `AlarmName`. */
  title: string;
  /** CloudWatch namespace, e.g. `"AWS/Lambda"`, `"AWS/DynamoDB"`. */
  namespace: string;
  /** Metric name within the namespace, e.g. `"Errors"`, `"ConsumedReadCapacityUnits"`. */
  metricName: string;
  /**
   * Dimension identifying which resource emits the metric, e.g.
   * `{ name: "FunctionName", value: "my-fn" }`. Omit for an account/region-
   * wide metric. `value` must be a literal — see the dashboard-body note above.
   */
  dimension?: { name: string; value: string };
  /** Statistic for both the widget and (if alarmed) the alarm. Default `"Sum"`. */
  statistic?: string;
  /** Period in seconds, for both the widget and the alarm. Default `300`. */
  period?: number;
  /** Alarm this metric when set; omit for a dashboard-only metric. */
  alarm?: {
    threshold: number;
    /** Default `"GreaterThanThreshold"`. */
    comparisonOperator?: string;
    /** Default `1`. */
    evaluationPeriods?: number;
    treatMissingData?: "breaching" | "ignore" | "missing" | "notBreaching";
    /** ARNs to notify on ALARM — an existing SNS topic, typically. */
    alarmActions?: Value<string>[];
    /**
     * Dimension value for the alarm. Defaults to `dimension.value`; set this
     * instead when the alarm needs to track a `Ref`/`GetAtt` the dashboard
     * widget cannot (see the dashboard-body note above).
     */
    dimensionValue?: Value<string>;
  };
}

export interface MonitoringStackProps {
  /** `Value<string>`: a name is routinely built with `Sub`/`Ref` (#1366). */
  dashboardName?: Value<string>;
  metric1: MonitoringMetricSpec;
  metric2?: MonitoringMetricSpec;
  metric3?: MonitoringMetricSpec;
  tags?: Array<{ Key: string; Value: string }>;
  defaults?: {
    dashboard?: Partial<ConstructorParameters<typeof CwDashboard>[0]>;
    alarm1?: Partial<ConstructorParameters<typeof Alarm>[0]>;
    alarm2?: Partial<ConstructorParameters<typeof Alarm>[0]>;
    alarm3?: Partial<ConstructorParameters<typeof Alarm>[0]>;
  };
}

/** A CloudWatch dashboard "metric" widget, stacked full-width below the last. */
function widget(spec: MonitoringMetricSpec, index: number) {
  const dims = spec.dimension ? [spec.dimension.name, spec.dimension.value] : [];
  return {
    type: "metric",
    x: 0,
    y: index * 6,
    width: 24,
    height: 6,
    properties: {
      title: spec.title,
      metrics: [[spec.namespace, spec.metricName, ...dims]],
      period: spec.period ?? 300,
      stat: spec.statistic ?? "Sum",
      view: "timeSeries",
    },
  };
}

function alarmProps(spec: MonitoringMetricSpec) {
  const a = spec.alarm!;
  return {
    AlarmName: spec.title,
    AlarmDescription: `${spec.title} breached its threshold`,
    Namespace: spec.namespace,
    MetricName: spec.metricName,
    Dimensions: spec.dimension
      ? [{ Name: spec.dimension.name, Value: a.dimensionValue ?? spec.dimension.value }]
      : undefined,
    Statistic: spec.statistic ?? "Sum",
    Period: spec.period ?? 300,
    Threshold: a.threshold,
    ComparisonOperator: a.comparisonOperator ?? "GreaterThanThreshold",
    EvaluationPeriods: a.evaluationPeriods ?? 1,
    TreatMissingData: a.treatMissingData,
    AlarmActions: a.alarmActions,
  };
}

export const MonitoringStack = Composite((props: MonitoringStackProps) => {
  const { defaults } = props;
  const specs = [props.metric1, props.metric2, props.metric3].filter(
    (s): s is MonitoringMetricSpec => s !== undefined,
  );

  const dashboard = new CwDashboard(mergeDefaults({
    DashboardName: props.dashboardName,
    DashboardBody: JSON.stringify({ widgets: specs.map(widget) }),
  }, defaults?.dashboard));

  const alarm1 = props.metric1.alarm
    ? new Alarm(mergeDefaults(alarmProps(props.metric1), defaults?.alarm1))
    : undefined;
  const alarm2 = props.metric2?.alarm
    ? new Alarm(mergeDefaults(alarmProps(props.metric2), defaults?.alarm2))
    : undefined;
  const alarm3 = props.metric3?.alarm
    ? new Alarm(mergeDefaults(alarmProps(props.metric3), defaults?.alarm3))
    : undefined;

  return {
    dashboard,
    ...(alarm1 ? { alarm1 } : {}),
    ...(alarm2 ? { alarm2 } : {}),
    ...(alarm3 ? { alarm3 } : {}),
  };
}, "MonitoringStack");
