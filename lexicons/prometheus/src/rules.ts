/**
 * `RuleGroup`: one group of recording and alerting rules.
 *
 * A group is the unit Prometheus evaluates together, on one interval, and
 * the unit both destinations take: an entry under `groups:` in a rule file,
 * and an entry in a Prometheus Operator `PrometheusRule`'s `spec.groups`. The
 * same declaration renders to either; `ruleGroupConfig()` is the one
 * conversion both go through.
 *
 * Rules are plain objects in the rule file's own shape, so a composite (the
 * SLO declaration, say) can build them as data and hand a list to one or
 * more groups.
 */

import { createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import {
  isAlertingRuleConfig,
  isRecordingRuleConfig,
  type AlertingRuleConfig,
  type LabelSet,
  type RecordingRuleConfig,
  type RuleConfig,
  type RuleGroupConfig,
} from "./model";

export type RecordingRule = RecordingRuleConfig;
export type AlertingRule = AlertingRuleConfig;
export type Rule = RuleConfig;

/** What `new RuleGroup(...)` takes: the group exactly as it appears in a rule file. */
export type RuleGroupProps = RuleGroupConfig;

export interface RuleGroupEntity extends Declarable {
  readonly props: RuleGroupProps;
  /** The group's `name`. */
  readonly groupName: string;
}

export const RULE_GROUP_TYPE = "Prometheus::Rules::RuleGroup";

const RuleGroupBase = createResource(RULE_GROUP_TYPE, "prometheus", {}) as unknown as (
  this: object,
  props: Record<string, unknown>,
) => void;

/**
 * A group of recording and alerting rules.
 *
 * @example
 * ```ts
 * export const api = new RuleGroup({
 *   name: "api",
 *   interval: "30s",
 *   rules: [
 *     { record: "job:http_requests:rate5m", expr: "sum by (job) (rate(http_requests_total[5m]))" },
 *     {
 *       alert: "ApiHighErrorRate",
 *       expr: 'sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.05',
 *       for: "10m",
 *       labels: { severity: "page" },
 *       annotations: { summary: "API 5xx ratio above 5%" },
 *     },
 *   ],
 * });
 * ```
 */
export const RuleGroup = function (this: object, props: RuleGroupProps) {
  RuleGroupBase.call(this, props as unknown as Record<string, unknown>);
  Object.defineProperty(this, "groupName", { value: props?.name, enumerable: false });
} as unknown as new (props: RuleGroupProps) => RuleGroupEntity;
Object.defineProperty(RuleGroup, "name", { value: "RuleGroup" });

/** True when `value` is a declared `RuleGroup`. */
export function isRuleGroup(value: unknown): value is RuleGroupEntity {
  return typeof value === "object" && value !== null && (value as Declarable).entityType === RULE_GROUP_TYPE;
}

function labelSet(value: LabelSet | undefined): LabelSet | undefined {
  if (value === undefined || value === null) return undefined;
  const out: LabelSet = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = String(v);
  }
  return out;
}

function defined<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

/** A rule in canonical key order, `undefined` fields dropped. */
export function ruleConfig(rule: Rule): Rule {
  if (isRecordingRuleConfig(rule)) {
    return defined({ record: rule.record, expr: rule.expr, labels: labelSet(rule.labels) }) as RecordingRule;
  }
  if (isAlertingRuleConfig(rule)) {
    return defined({
      alert: rule.alert,
      expr: rule.expr,
      for: rule.for,
      keep_firing_for: rule.keep_firing_for,
      labels: labelSet(rule.labels),
      annotations: labelSet(rule.annotations),
    }) as AlertingRule;
  }
  // Neither `record` nor `alert`: keep it as written, and let PROM105 name it.
  return { ...(rule as object) } as Rule;
}

/**
 * The plain group a `RuleGroup` (or group props) renders to, in canonical key
 * order. This is what goes under `groups:` in a rule file and into a
 * `PrometheusRule`'s `spec.groups`.
 */
export function ruleGroupConfig(group: RuleGroupEntity | RuleGroupProps): RuleGroupConfig {
  const p = isRuleGroup(group) ? group.props : group;
  return defined({
    name: p.name,
    interval: p.interval,
    query_offset: p.query_offset,
    limit: p.limit,
    labels: labelSet(p.labels),
    rules: (p.rules ?? []).map(ruleConfig),
  }) as RuleGroupConfig;
}
