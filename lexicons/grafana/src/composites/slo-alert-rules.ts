/**
 * `SloAlertRules`: an `Slo`'s multiwindow, multi-burn-rate alerts as
 * Grafana-managed alert rules, for teams that page from Grafana rather
 * than from Prometheus and Alertmanager.
 *
 * The windows, factors, thresholds and labels come from the prometheus
 * lexicon's `sloMetrics()`, the same numbers the `Slo`'s own Prometheus
 * alerts use. Each burn-rate pair becomes one rule that reads the two
 * error ratios the `Slo` records (`slo:sli_error:ratio_rate<window>`) as
 * instant Prometheus queries, and a math expression that holds while both
 * are above the pair's threshold:
 *
 *     A = slo:sli_error:ratio_rate1h{slo="checkout"}
 *     B = slo:sli_error:ratio_rate5m{slo="checkout"}
 *     C = $A > 0.0144 && $B > 0.0144        (condition)
 *
 * So the `Slo`'s rule group must be loaded into the Prometheus the rules
 * query: the recording rules are what make a 3-day window cheap to
 * evaluate every minute.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import { sloMetrics, type SloInstance, type SloMetrics } from "@intentius/chant-lexicon-prometheus/composites/slo";
import type { RuleGroupEntity } from "@intentius/chant-lexicon-prometheus/rules";
import {
  AlertRule,
  AlertRuleGroup,
  MathExpression,
  type AlertRuleGroupEntity,
  type ContactPointEntity,
  type ExecErrState,
  type NoDataState,
} from "../alerting";
import { PromQuery, type DatasourceInput } from "../query";
import { slugUid } from "../util";
import { num, requireDatasource } from "./shared";

export interface SloAlertRulesProps {
  /** The `Slo(...)` the rules alert on, its rule group, or what `sloMetrics()` returned for it. It must have alerting on. */
  slo: SloInstance | RuleGroupEntity | SloMetrics;
  /** The Prometheus holding the `Slo`'s recorded series: a declared `Datasource`, an `ExternalDatasource`, or `{ type: "prometheus", uid }`. */
  datasource: DatasourceInput<"prometheus">;
  /** The Grafana folder the rules are stored in, by title. */
  folder: string;
  /** The rule group's name. Defaults to the `Slo`'s group name, `slo-<name>`. */
  group?: string;
  /** How often the rules are evaluated, a multiple of 10s. Defaults to `1m`. */
  interval?: string;
  /**
   * Send the alerts straight to this contact point. Left out, they go
   * through the notification policy tree, which can route on the
   * `severity` label (`page` or `ticket` by default).
   */
  contactPoint?: ContactPointEntity | string;
  /** How long a pair must hold before its alert fires. Default: none; the short window already filters blips. */
  for?: string;
  /** More labels on every rule, e.g. `team`. */
  labels?: Record<string, string>;
  /** More annotations on every rule, e.g. `runbook_url`. */
  annotations?: Record<string, string>;
  /** What no data does. Defaults to `OK`: no recorded ratio means no traffic, so no budget is burning. */
  noDataState?: NoDataState;
  /** What a query error does. Defaults to `Error`. */
  execErrState?: ExecErrState;
}

export type SloAlertRulesMembers = {
  /** One rule per burn-rate pair, page tier first. */
  rules: AlertRuleGroupEntity;
};

/** What `SloAlertRules(...)` returns: its rule group, as `rules`. */
export type SloAlertRulesInstance = CompositeInstance<SloAlertRulesMembers> & SloAlertRulesMembers;

function isMetrics(x: unknown): x is SloMetrics {
  return typeof x === "object" && x !== null && "errorBudgetRemaining" in x && "burnRates" in x && "selector" in x;
}

/** A rule uid for one pair: the SLO's name cut to fit, then the windows, at most 40 characters. */
function pairUid(name: string, long: string, short: string): string {
  const suffix = `-${long}-${short}`.toLowerCase();
  return `${slugUid(`slo ${name}`).slice(0, 40 - suffix.length).replace(/-$/, "")}${suffix}`;
}

/** The queries and condition of each burn-rate rule, from `sloMetrics()`. Exposed for tests and for rules of your own. */
export function sloAlertQueries(m: SloMetrics) {
  return m.burnRates.map((b) => ({
    ...b,
    uid: pairUid(m.name, b.long, b.short),
    longExpr: `${b.longRecord}${m.selector}`,
    shortExpr: `${b.shortRecord}${m.selector}`,
    condition: `$A > ${num(b.threshold)} && $B > ${num(b.threshold)}`,
  }));
}

/**
 * Grafana-managed burn-rate alerts for an `Slo`: one rule per window pair,
 * with the labels and annotations the `Slo`'s Prometheus alerts carry.
 *
 * @example
 * ```ts
 * import { Slo } from "@intentius/chant-lexicon-prometheus";
 * import { SloAlertRules } from "@intentius/chant-lexicon-grafana";
 *
 * export const checkout = Slo({ name: "checkout", objective: 0.999, window: "30d", sli: { ... } });
 * export const checkoutAlerts = SloAlertRules({ slo: checkout, datasource: prometheus, folder: "SLOs" });
 * ```
 */
export const SloAlertRules = Composite<SloAlertRulesProps, SloAlertRulesMembers>((props) => {
  requireDatasource("SloAlertRules", props.datasource);
  if (!props.slo) throw new Error("SloAlertRules: slo is required (an Slo(...) declaration)");
  if (typeof props.folder !== "string" || props.folder.trim() === "") throw new Error("SloAlertRules: folder is required (the Grafana folder title)");
  const m = isMetrics(props.slo) ? props.slo : sloMetrics(props.slo);
  const pairs = sloAlertQueries(m);
  if (pairs.length === 0) {
    throw new Error(`SloAlertRules: the Slo "${m.name}" has alerting turned off, so it has no burn-rate windows to alert on`);
  }
  const ds = props.datasource;
  const budget = num(m.errorBudget);
  const rules = pairs.map(
    (p) =>
      new AlertRule({
        title: `SLO ${m.name} error budget burn ${p.long}/${p.short} (${p.severity})`,
        uid: p.uid,
        data: [
          new PromQuery({ datasource: ds, expr: p.longExpr, instant: true, range: false }),
          new PromQuery({ datasource: ds, expr: p.shortExpr, instant: true, range: false }),
          new MathExpression({ expression: p.condition }),
        ],
        condition: "C",
        noDataState: props.noDataState ?? "OK",
        execErrState: props.execErrState ?? "Error",
        ...(props.for !== undefined ? { for: props.for } : {}),
        labels: { ...(props.labels ?? {}), ...p.labels },
        annotations: {
          summary: `SLO ${m.name} is burning its error budget more than ${num(p.factor)}x too fast (${p.long} and ${p.short} windows)`,
          description:
            `The error ratio over both the last ${p.long} and the last ${p.short} is above ${num(p.threshold)} ` +
            `(${num(p.factor)} times the ${budget} budget of a ${num(m.objective)} objective). ` +
            `At that rate the ${m.window} error budget is gone in ${p.exhaustsIn}.`,
          ...(props.annotations ?? {}),
        },
        ...(props.contactPoint !== undefined ? { notification_settings: { receiver: props.contactPoint } } : {}),
      }),
  );
  return {
    rules: new AlertRuleGroup({ name: props.group ?? m.group, folder: props.folder, interval: props.interval ?? "1m", rules }),
  };
}, "SloAlertRules");
