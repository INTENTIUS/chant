/**
 * What `/api/v1/rules` says about a group, mapped two ways (#3371): to the
 * group's health for `describeResources`, and, for a plain Prometheus,
 * which has no rule group API, back to the rule-file shape for import.
 *
 * The second mapping is lossy, and says so. `/api/v1/rules` reports rules
 * as Prometheus evaluates them, not as the file wrote them: `query` is the
 * expression as PromQL prints it, durations are seconds, and a group's
 * `interval` is the one it runs on, the global `evaluation_interval` when
 * the group set none. A group's `labels` and `query_offset` are not
 * reported at all.
 */

import { formatDuration } from "../duration";
import type { RuleConfig, RuleGroupConfig } from "../model";
import type { EvaluatedGroup } from "./ruler";

/** A duration in seconds as Prometheus writes one; undefined for zero or a value that is not a number. */
function seconds(v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return formatDuration(Math.round(v * 1000));
}

function labelsOf(v: unknown): Record<string, string> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const entries = Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** What the import of evaluated groups leaves out, said once per export. */
export const EVALUATED_IMPORT_WARNING =
  "rule groups were read from /api/v1/rules, which reports them as Prometheus evaluates them: expressions are as PromQL prints them, " +
  "a group's interval is the one it runs on (the global evaluation_interval when the group sets none), and group labels and query_offset are not reported";

/** A group from `/api/v1/rules` in the rule-file shape. */
export function evaluatedToRuleGroup(group: EvaluatedGroup): RuleGroupConfig {
  const rules: RuleConfig[] = group.rules.map((r) => {
    if (r.type === "recording") {
      const labels = labelsOf(r.labels);
      return { record: r.name, expr: r.query, ...(labels ? { labels } : {}) };
    }
    const labels = labelsOf(r.labels);
    const annotations = labelsOf(r.annotations);
    const forDuration = seconds(r.duration);
    const keep = seconds(r.keepFiringFor);
    return {
      alert: r.name,
      expr: r.query,
      ...(forDuration ? { for: forDuration } : {}),
      ...(keep ? { keep_firing_for: keep } : {}),
      ...(labels ? { labels } : {}),
      ...(annotations ? { annotations } : {}),
    };
  });
  const interval = seconds(group.interval);
  return {
    name: group.name,
    ...(interval ? { interval } : {}),
    ...(typeof group.limit === "number" && group.limit > 0 ? { limit: group.limit } : {}),
    rules,
  };
}

/** A group's health, from its rules: `err` when any rule failed its last evaluation, `ok` when every rule passed, else `unknown`. */
export interface GroupHealth {
  health: "ok" | "err" | "unknown";
  /** The first rule error, as `<rule>: <error>`. */
  lastError?: string;
  /** How many rules failed their last evaluation. */
  failing: number;
  /** Alerting rules by state. */
  firing: number;
  pending: number;
  lastEvaluation?: string;
  /** Seconds the last evaluation took. */
  evaluationTime?: number;
  /** Seconds. */
  interval?: number;
}

export function groupHealth(group: EvaluatedGroup): GroupHealth {
  let failing = 0;
  let unknown = 0;
  let firing = 0;
  let pending = 0;
  let lastError: string | undefined;
  for (const r of group.rules) {
    if (r.health === "err") {
      failing++;
      lastError ??= `${r.name}: ${r.lastError ?? "evaluation failed"}`;
    } else if (r.health !== "ok") unknown++;
    if (r.state === "firing") firing++;
    else if (r.state === "pending") pending++;
  }
  const health = failing > 0 ? "err" : unknown > 0 || group.rules.length === 0 ? "unknown" : "ok";
  return {
    health,
    ...(lastError ? { lastError } : {}),
    failing,
    firing,
    pending,
    ...(group.lastEvaluation ? { lastEvaluation: group.lastEvaluation } : {}),
    ...(typeof group.evaluationTime === "number" ? { evaluationTime: group.evaluationTime } : {}),
    ...(typeof group.interval === "number" ? { interval: group.interval } : {}),
  };
}
