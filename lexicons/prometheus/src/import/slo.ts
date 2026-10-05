/**
 * Recognise a rule group that `Slo()` built, so the importer can write the
 * `Slo` declaration instead of its forty-odd lines of rules.
 *
 * The group's name, recorded series, objective and burn-rate alerts give
 * back candidate props; the candidate is accepted only when `Slo()` builds
 * it to the same group, rule for rule. Anything else (a hand-edited
 * threshold, an extra rule, a different description) fails that check and
 * the group is imported as a plain `RuleGroup`.
 */

import { Slo, DEFAULT_BURN_RATES, SLO_WINDOW_PLACEHOLDER, type SloAlertTier, type SloProps, type BurnRateWindow } from "../composites/slo";
import { ruleGroupConfig } from "../rules";
import { durationMs } from "../duration";
import { isAlertingRuleConfig, isRecordingRuleConfig, type AlertingRuleConfig, type LabelSet, type RuleGroupConfig } from "../model";

const RATIO_PREFIX = "slo:sli_error:ratio_rate";
const OBJECTIVE = "slo:objective:ratio";
const BUDGET = "slo:error_budget:remaining";
const DEFAULT_ALERT_NAME = "ErrorBudgetBurn";
const PAIR_LABELS = new Set(["slo", "severity", "long_window", "short_window"]);
const DESCRIPTION_TAIL = "The error ratio over both the last ";

/** Objects with their keys sorted, so two configs compare equal whatever order their keys were written in. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** The SLI expressions a recorded error ratio was built from, with the window put back as `{{window}}`. */
function sliFrom(expr: string, window: string): SloProps["sli"] | undefined {
  const unwindow = (s: string) => s.split(`[${window}]`).join(`[${SLO_WINDOW_PLACEHOLDER}]`);
  // Since #3548 a window with no events records nothing: `((E) or 0 * ((T) > 0)) / ((T) > 0)`, and the good/total form
  // as `1 - (((G) or 0 * ((T) > 0)) / ((T) > 0))`.
  const idle = (head: string, divide: string, tail: string, key: "errors" | "good"): SloProps["sli"] | undefined => {
    if (!expr.startsWith(head) || !expr.endsWith(tail)) return undefined;
    const body = expr.slice(head.length, expr.length - tail.length);
    const orAt = body.indexOf(") or 0 * ((");
    const divAt = body.indexOf(`) > 0))${divide}((`);
    if (orAt === -1 || divAt < orAt) return undefined;
    const total = body.slice(divAt + `) > 0))${divide}((`.length);
    return { [key]: unwindow(body.slice(0, orAt)), total: unwindow(total) } as SloProps["sli"];
  };
  const idleErrors = idle("((", "\n/\n", ") > 0)", "errors");
  if (idleErrors) return idleErrors;
  const idleGood = idle("1 - (\n  ((", "\n  /\n  ", ") > 0)\n)", "good");
  if (idleGood) return idleGood;
  const goodHead = "1 - (\n  (";
  const goodTail = ")\n)";
  if (expr.startsWith(goodHead) && expr.endsWith(goodTail)) {
    const inner = expr.slice(goodHead.length, -goodTail.length);
    const at = inner.indexOf(")\n  /\n  (");
    if (at === -1) return undefined;
    return { good: unwindow(inner.slice(0, at)), total: unwindow(inner.slice(at + ")\n  /\n  (".length)) };
  }
  if (expr.startsWith("(") && expr.endsWith(")")) {
    const inner = expr.slice(1, -1);
    const at = inner.indexOf(")\n/\n(");
    if (at === -1) return undefined;
    return { errors: unwindow(inner.slice(0, at)), total: unwindow(inner.slice(at + ")\n/\n(".length)) };
  }
  return undefined;
}

function extras(set: LabelSet | undefined, skip: (k: string) => boolean): LabelSet | undefined {
  const out: LabelSet = {};
  for (const [k, v] of Object.entries(set ?? {})) if (!skip(k)) out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}

function isDefaultPairs(tier: "page" | "ticket", pairs: BurnRateWindow[], factors: number[], windowMs: (w: string) => number, sloWindow: string): boolean {
  const defaults = DEFAULT_BURN_RATES[tier];
  if (defaults.length !== pairs.length) return false;
  return defaults.every((d, i) => {
    const p = pairs[i];
    const factor = Number(((d.budgetConsumed! * windowMs(sloWindow)) / windowMs(d.long)).toPrecision(6));
    return p.long === d.long && p.short === d.short && factor === factors[i];
  });
}

/** The `Slo` props that build exactly `group`, or `undefined` when no `Slo()` call does. */
export function recognizeSlo(group: RuleGroupConfig): SloProps | undefined {
  if (!group.name.startsWith("slo-") || group.query_offset !== undefined || group.limit !== undefined) return undefined;
  const name = group.name.slice("slo-".length);
  const records = group.rules.filter(isRecordingRuleConfig);
  const alerts = group.rules.filter(isAlertingRuleConfig) as AlertingRuleConfig[];
  if (records.length + alerts.length !== group.rules.length) return undefined;

  const objectiveAt = records.findIndex((r) => r.record === OBJECTIVE);
  if (objectiveAt < 1 || records[objectiveAt + 1]?.record !== BUDGET) return undefined;
  const objective = Number(/^vector\((.+)\)$/.exec(records[objectiveAt].expr)?.[1]);
  if (!Number.isFinite(objective)) return undefined;
  const windowRecord = records[objectiveAt - 1].record;
  if (!windowRecord.startsWith(RATIO_PREFIX)) return undefined;
  const window = windowRecord.slice(RATIO_PREFIX.length);

  // Candidate SLIs: from each alert window's ratio, or from the whole-window
  // ratio when there are no alerts.
  const ratioRecords = records.slice(0, objectiveAt - 1);
  const sources = ratioRecords.length > 0 ? ratioRecords : [records[objectiveAt - 1]];
  const slis = sources
    .map((r) => (r.record.startsWith(RATIO_PREFIX) ? sliFrom(r.expr, r.record.slice(RATIO_PREFIX.length)) : undefined))
    .filter((s): s is SloProps["sli"] => s !== undefined);
  if (slis.length === 0) return undefined;

  // Alert tiers: `page` and `ticket` by severity, or custom severities in the order they appear.
  const alertName = alerts[0]?.alert ?? DEFAULT_ALERT_NAME;
  const bySeverity = new Map<string, AlertingRuleConfig[]>();
  for (const a of alerts) {
    const severity = a.labels?.severity;
    if (severity === undefined || a.alert !== alertName) return undefined;
    bySeverity.set(severity, [...(bySeverity.get(severity) ?? []), a]);
  }
  if (bySeverity.size > 2) return undefined;
  const severities = [...bySeverity.keys()];
  const tierOf = new Map<string, "page" | "ticket">();
  for (const s of severities) if (s === "page" || s === "ticket") tierOf.set(s, s);
  for (const s of severities) {
    if (tierOf.has(s)) continue;
    const free = (["page", "ticket"] as const).find((t) => ![...tierOf.values()].includes(t));
    if (!free) return undefined;
    tierOf.set(s, free);
  }

  let description: string | undefined;
  const alerting: NonNullable<SloProps["alerting"]> = {};
  for (const tier of ["page", "ticket"] as const) {
    const severity = [...tierOf].find(([, t]) => t === tier)?.[0];
    if (severity === undefined) {
      alerting[tier] = false;
      continue;
    }
    const tierAlerts = bySeverity.get(severity)!;
    const first = tierAlerts[0];
    const pairs: BurnRateWindow[] = [];
    const factors: number[] = [];
    for (const a of tierAlerts) {
      const long = a.labels?.long_window;
      const short = a.labels?.short_window;
      const factor = Number(/> \(([^ ]+) \* /.exec(a.expr)?.[1]);
      if (long === undefined || short === undefined || !Number.isFinite(factor)) return undefined;
      pairs.push({ long, short, factor });
      factors.push(factor);
    }
    const t: SloAlertTier = {};
    t.burnRates = isDefaultPairs(tier, pairs, factors, (w) => durationMs(w) ?? 0, window) ? "default" : pairs;
    if (severity !== tier) t.severity = severity;
    if (first.for !== undefined) t.for = first.for;
    const labels = extras(first.labels, (k) => PAIR_LABELS.has(k));
    if (labels) t.labels = labels;
    const annotations = extras(first.annotations, (k) => k === "summary" || k === "description");
    if (annotations) t.annotations = annotations;
    const desc = first.annotations?.description ?? "";
    const at = desc.indexOf(DESCRIPTION_TAIL);
    if (at > 0 && description === undefined) description = desc.slice(0, at).trimEnd();
    const onlyDefault = t.burnRates === "default" && Object.keys(t).length === 1;
    if (!onlyDefault) alerting[tier] = t;
  }
  if (alertName !== DEFAULT_ALERT_NAME) alerting.alertName = alertName;

  for (const sli of slis) {
    const props: SloProps = {
      name,
      objective,
      window,
      ...(description ? { description } : {}),
      sli,
      ...(Object.keys(alerting).length > 0 ? { alerting } : {}),
      ...(group.labels ? { labels: group.labels } : {}),
      ...(group.interval !== undefined ? { interval: group.interval } : {}),
    };
    try {
      if (same(ruleGroupConfig(Slo(props).rules), ruleGroupConfig(group))) return props;
    } catch {
      // Not buildable from these props; try the next candidate.
    }
  }
  return undefined;
}
