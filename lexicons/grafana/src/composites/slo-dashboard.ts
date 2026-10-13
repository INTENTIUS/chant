/**
 * `SloDashboard`: one SLO's SLI, error budget and burn rates, from an `Slo`
 * declaration.
 *
 * Every series name, the objective, the window and the burn-rate pairs come
 * from the prometheus lexicon's `sloMetrics()`, which reads the same
 * declaration the rules are built from. Renaming the SLO, changing its
 * objective or its windows moves the panels and their threshold lines with
 * it.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import { sloMetrics, type SloInstance, type SloMetrics } from "@intentius/chant-lexicon-prometheus/composites/slo";
import type { RuleGroupEntity } from "@intentius/chant-lexicon-prometheus/rules";
import { Dashboard, type DashboardEntity } from "../dashboard";
import { Row, StatPanel, TimeSeriesPanel } from "../panels";
import { PromQuery } from "../query";
import { slugUid } from "../util";
import { dashboardProps, num, requireDatasource, selector, thresholds, type DashboardOptions } from "./shared";

export interface SloDashboardProps extends DashboardOptions {
  /** The `Slo(...)` the dashboard reads, its rule group, or what `sloMetrics()` returned for it. */
  slo: SloInstance | RuleGroupEntity | SloMetrics;
}

export type SloDashboardMembers = { dashboard: DashboardEntity };

/** What `SloDashboard(...)` returns: its dashboard, as `dashboard`. */
export type SloDashboardInstance = CompositeInstance<SloDashboardMembers> & SloDashboardMembers;

function isMetrics(x: unknown): x is SloMetrics {
  return typeof x === "object" && x !== null && "errorBudgetRemaining" in x && "burnRates" in x && "selector" in x;
}

/** The PromQL the SLO dashboard runs, from `sloMetrics()`. Exposed for tests and for panels of your own. */
export function sloQueries(m: SloMetrics) {
  const s = (series: string) => `${series}${m.selector}`;
  const budget = num(m.errorBudget);
  return {
    sli: `1 - ${s(m.windowErrorRatio)}`,
    objective: s(m.objectiveRatio),
    errorBudgetRemaining: s(m.errorBudgetRemaining),
    alertsFiring: `sum(${selector("ALERTS", [
      ["alertname", "=", m.alertName],
      ["slo", "=", m.name],
      ["alertstate", "=", "firing"],
    ])}) or vector(0)`,
    burnRates: m.burnRates.map((b) => ({
      ...b,
      longExpr: `${s(b.longRecord)} / ${budget}`,
      shortExpr: `${s(b.shortRecord)} / ${budget}`,
    })),
  };
}

const PERCENT = { unit: "percentunit", decimals: 3 };

/**
 * A dashboard for one SLO: the SLI over its window against the objective,
 * the error budget left, and each burn-rate alert's two windows with the
 * rate it fires at drawn as a threshold line.
 *
 * @example
 * ```ts
 * import { Slo } from "@intentius/chant-lexicon-prometheus";
 * import { SloDashboard } from "@intentius/chant-lexicon-grafana";
 *
 * export const checkout = Slo({ name: "checkout", objective: 0.999, window: "30d", sli: { ... } });
 * export const checkoutSlo = SloDashboard({ slo: checkout, datasource: prometheus });
 * ```
 */
export const SloDashboard = Composite<SloDashboardProps, SloDashboardMembers>((props) => {
  requireDatasource("SloDashboard", props.datasource);
  if (!props.slo) throw new Error("SloDashboard: slo is required (an Slo(...) declaration)");
  const m = isMetrics(props.slo) ? props.slo : sloMetrics(props.slo);
  const q = sloQueries(m);
  const ds = props.datasource;
  const objective = num(m.objective * 100);

  const sli = new StatPanel({
    title: `SLI over ${m.window}`,
    description: `Share of good events over the last ${m.window}. Green at or above the ${objective}% objective.`,
    datasource: ds,
    gridPos: { w: 6, h: 5 },
    targets: [new PromQuery({ expr: q.sli, legendFormat: "SLI" })],
    options: { colorMode: "background", graphMode: "none", reduceOptions: { calcs: ["lastNotNull"] } },
    fieldConfig: { defaults: { ...PERCENT, thresholds: thresholds("red", [[m.objective, "green"]]) } },
  });
  const target = new StatPanel({
    title: "Objective",
    datasource: ds,
    gridPos: { w: 6, h: 5 },
    targets: [new PromQuery({ expr: q.objective, legendFormat: "objective" })],
    options: { colorMode: "none", graphMode: "none", reduceOptions: { calcs: ["lastNotNull"] } },
    fieldConfig: { defaults: PERCENT },
  });
  const remaining = new StatPanel({
    title: "Error budget remaining",
    description: `Share of the ${m.window} error budget (${num(m.errorBudget * 100)}% of events) not yet spent. Below 0 the objective is missed.`,
    datasource: ds,
    gridPos: { w: 6, h: 5 },
    targets: [new PromQuery({ expr: q.errorBudgetRemaining, legendFormat: "remaining" })],
    options: { colorMode: "background", graphMode: "area", reduceOptions: { calcs: ["lastNotNull"] } },
    fieldConfig: { defaults: { unit: "percentunit", decimals: 1, thresholds: thresholds("red", [[0, "orange"], [0.25, "green"]]) } },
  });
  const firing = new StatPanel({
    title: "Burn-rate alerts firing",
    description: `${m.alertName} alerts for this SLO, any tier.`,
    datasource: ds,
    gridPos: { w: 6, h: 5 },
    targets: [new PromQuery({ expr: q.alertsFiring, legendFormat: "firing" })],
    options: { colorMode: "background", graphMode: "none", reduceOptions: { calcs: ["lastNotNull"] } },
    fieldConfig: { defaults: { unit: "none", decimals: 0, thresholds: thresholds("green", [[1, "red"]]) } },
  });

  const sliOverTime = new TimeSeriesPanel({
    title: `SLI over ${m.window}`,
    description: `The dashed line is the ${objective}% objective.`,
    datasource: ds,
    gridPos: { w: 12, h: 8 },
    targets: [new PromQuery({ expr: q.sli, legendFormat: "SLI" })],
    fieldConfig: {
      defaults: { ...PERCENT, thresholds: thresholds("red", [[m.objective, "green"]]), custom: { thresholdsStyle: { mode: "dashed" } } },
    },
  });
  const budgetOverTime = new TimeSeriesPanel({
    title: "Error budget remaining",
    datasource: ds,
    gridPos: { w: 12, h: 8 },
    targets: [new PromQuery({ expr: q.errorBudgetRemaining, legendFormat: "remaining" })],
    fieldConfig: {
      defaults: { unit: "percentunit", decimals: 1, thresholds: thresholds("red", [[0, "green"]]), custom: { thresholdsStyle: { mode: "dashed" } } },
    },
  });

  const rows = [new Row({ title: "Objective", panels: [sli, target, remaining, firing, sliOverTime, budgetOverTime] })];

  if (q.burnRates.length > 0) {
    const panels = q.burnRates.map(
      (b) =>
        new TimeSeriesPanel({
          title: `Burn rate ${b.long} / ${b.short} (${b.severity})`,
          description:
            `Error ratio over the budget: 1 spends the ${m.window} budget exactly over ${m.window}. ` +
            `${b.alert} fires with severity ${b.severity} while both windows are above ${num(b.factor)}, which spends the budget in ${b.exhaustsIn}.`,
          datasource: ds,
          gridPos: { w: 12, h: 8 },
          targets: [
            new PromQuery({ expr: b.longExpr, legendFormat: b.long }),
            new PromQuery({ expr: b.shortExpr, legendFormat: b.short }),
          ],
          fieldConfig: {
            defaults: {
              unit: "suffix:x",
              decimals: 2,
              min: 0,
              thresholds: thresholds("green", [[b.factor, "red"]]),
              custom: { thresholdsStyle: { mode: "dashed" } },
            },
          },
        }),
    );
    rows.push(new Row({ title: "Burn rate by alert window", panels }));
  }

  const dashboard = new Dashboard({
    ...dashboardProps(props, {
      title: `SLO: ${m.name}`,
      uid: slugUid(`slo-${m.name}`),
      description: `${objective}% over ${m.window}: SLI, error budget and burn rates for the ${m.name} SLO.`,
      tags: ["slo", m.name],
    }),
    time: props.time ?? { from: "now-7d", to: "now" },
    panels: rows,
  });
  return { dashboard };
}, "SloDashboard");
