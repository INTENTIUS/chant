/**
 * `RuleAuditOp`: what a live Prometheus says about its rules, as an Op with
 * an optional schedule (#3369). One `ruleAudit` step reports groups with
 * health errors, alerts pending or firing past a threshold, and selectors
 * no live target emits (one query per selector, within a budget).
 * `onFinding` is `report` (the default) or `issue`, which keeps one open
 * issue current.
 *
 * @example
 * ```typescript
 * export const { op } = RuleAuditOp({ name: "rule-audit", url: "http://prometheus:9090", schedule: "0 * * * *" });
 * ```
 */

import { Op, phase, type OpResource } from "@intentius/chant/op";
import { ruleAudit } from "./builders";
import type { RuleAuditMode } from "./activities/rule-audit";

export interface RuleAuditOpConfig {
  /** Op name (kebab-case). */
  name: string;
  /** Prometheus's base URL. Default `$PROMETHEUS_URL`, else `http://localhost:9090`. */
  url?: string;
  /** Cron expression; omit for one-shot `chant run`. */
  schedule?: string;
  /** @default "report" */
  onFinding?: RuleAuditMode;
  /** @default "1h" */
  pendingFor?: string;
  /** @default "24h" */
  firingFor?: string;
  /** @default 50 */
  selectorBudget?: number;
  /** @default "1h" */
  lookback?: string;
}

export interface RuleAuditOpResources {
  op: InstanceType<typeof OpResource>;
}

export function RuleAuditOp(config: RuleAuditOpConfig): RuleAuditOpResources {
  const { name, schedule, onFinding, ...rest } = config;
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Omit<RuleAuditOpConfig, "name" | "schedule" | "onFinding">;
  const step = ruleAudit({ mode: onFinding ?? "report", ...defined });
  const op = Op({
    name,
    overview: "Audit a live Prometheus: rule health, alerts pending or firing too long, and selectors nothing emits",
    labels: { Audit: "true", Surface: "prometheus-rules" },
    ...(schedule ? { schedule: { cron: schedule, overlap: "skip" as const } } : {}),
    phases: [phase("Audit", [{ ...step, outcomeAttribute: { name: "Findings", from: "findings" } }])],
  });
  return { op };
}
