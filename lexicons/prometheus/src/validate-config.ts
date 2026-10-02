/**
 * Rule file and Alertmanager config checks, as plain functions over the
 * parsed files.
 *
 * The post-synth checks in `lint/post-synth/` are thin wrappers around these,
 * so the same rules run anywhere the files exist: on a build's output, on a
 * `PrometheusRule`'s groups, or on a file parsed by some other tool.
 */

import { isValidDuration } from "./duration";
import { matcherMatches, parseMatchers, type Matcher } from "./matchers";
import {
  isAlertingRuleConfig,
  isRecordingRuleConfig,
  type AlertmanagerConfig,
  type AlertingRuleConfig,
  type LabelSet,
  type RouteConfig,
  type RuleFileConfig,
  type RuleGroupConfig,
} from "./model";
import { checkPromql } from "./promql";
import { validateGlobalSettings, validateReceiverIntegrations } from "./validate-integrations";

export type PrometheusIssueCode =
  | "PROM101"
  | "PROM102"
  | "PROM103"
  | "PROM104"
  | "PROM105"
  | "PROM106"
  | "PROM107"
  | "PROM201"
  | "PROM202"
  | "PROM203"
  | "PROM204"
  | "PROM205"
  | "PROM206"
  | "PROM207"
  | "PROM208"
  | "PROM209"
  | "PROM210";

export interface PrometheusIssue {
  code: PrometheusIssueCode;
  severity: "error" | "warning";
  message: string;
  /** What the issue is about: a group, a rule (`group/rule`), a receiver or a route. */
  subject?: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}

// ── Rule files ──────────────────────────────────────────────────────

function ruleLabel(group: RuleGroupConfig, index: number, rule: unknown): string {
  const r = rule as Record<string, unknown>;
  const name = typeof r?.record === "string" ? r.record : typeof r?.alert === "string" ? r.alert : `rule ${index + 1}`;
  return `${group.name}/${name}`;
}

/** The static labels an alert carries: the group's labels under its own. */
function alertLabels(group: RuleGroupConfig, rule: AlertingRuleConfig): LabelSet {
  return { ...(group.labels ?? {}), ...(rule.labels ?? {}) };
}

/** Check a rule file (PROM101-PROM107). */
export function validateRuleFile(file: RuleFileConfig): PrometheusIssue[] {
  const issues: PrometheusIssue[] = [];
  const groups = Array.isArray(file?.groups) ? file.groups : [];
  const groupNames = new Map<string, number>();
  const ruleKeys = new Map<string, string>();

  for (const group of groups) {
    const gname = str(group?.name ?? "");
    groupNames.set(gname, (groupNames.get(gname) ?? 0) + 1);
    if (groupNames.get(gname) === 2) {
      issues.push({
        code: "PROM101",
        severity: "error",
        subject: gname,
        message: `rule group "${gname}" is declared more than once; Prometheus requires group names to be unique within a rule file`,
      });
    }
    if (gname.trim() === "") {
      issues.push({ code: "PROM105", severity: "error", subject: gname, message: "a rule group has no name" });
    }

    for (const field of ["interval", "query_offset"] as const) {
      const v = group?.[field];
      if (v !== undefined && !isValidDuration(v)) {
        issues.push({
          code: "PROM103",
          severity: "error",
          subject: gname,
          message: `group "${gname}" ${field} "${str(v)}" is not a Prometheus duration (e.g. 30s, 1m, 1h30m)`,
        });
      }
    }

    const rules = Array.isArray(group?.rules) ? group.rules : [];
    rules.forEach((rule, i) => {
      const subject = ruleLabel(group, i, rule);
      const r = rule as unknown as Record<string, unknown>;
      const recording = isRecordingRuleConfig(rule);
      const alerting = isAlertingRuleConfig(rule);

      // PROM105: shape
      if (recording && alerting) {
        issues.push({ code: "PROM105", severity: "error", subject, message: `rule ${subject} sets both record and alert; a rule is one or the other` });
      } else if (!recording && !alerting) {
        issues.push({ code: "PROM105", severity: "error", subject, message: `rule ${subject} sets neither record nor alert` });
      } else if (recording) {
        if (rule.record.trim() === "") issues.push({ code: "PROM105", severity: "error", subject, message: `a recording rule in group "${gname}" has an empty record name` });
        for (const bad of ["for", "keep_firing_for", "annotations"]) {
          if (r[bad] !== undefined) {
            issues.push({ code: "PROM105", severity: "error", subject, message: `recording rule ${subject} sets ${bad}, which only alerting rules take` });
          }
        }
      } else if (alerting && (rule as AlertingRuleConfig).alert.trim() === "") {
        issues.push({ code: "PROM105", severity: "error", subject, message: `an alerting rule in group "${gname}" has an empty alert name` });
      }

      // PROM103: durations
      for (const field of ["for", "keep_firing_for"]) {
        const v = r[field];
        if (v !== undefined && !isValidDuration(v)) {
          issues.push({
            code: "PROM103",
            severity: "error",
            subject,
            message: `rule ${subject} ${field} "${str(v)}" is not a Prometheus duration (e.g. 5m, 1h)`,
          });
        }
      }

      // PROM104: PromQL
      const expr = r.expr;
      const checked = checkPromql(typeof expr === "string" ? expr : "");
      if (!checked.ok) {
        issues.push({ code: "PROM104", severity: "error", subject, message: `rule ${subject} expr: ${checked.message}` });
      }

      // PROM102: duplicates (same kind, name and labels anywhere in the file)
      if (recording || alerting) {
        const labels = recording ? { ...(group.labels ?? {}), ...(rule.labels ?? {}) } : alertLabels(group, rule as AlertingRuleConfig);
        const key = JSON.stringify([recording ? "record" : "alert", recording ? rule.record : (rule as AlertingRuleConfig).alert, Object.entries(labels).sort()]);
        const first = ruleKeys.get(key);
        if (first !== undefined) {
          issues.push({
            code: "PROM102",
            severity: "warning",
            subject,
            message: `rule ${subject} has the same name and labels as ${first}; the two produce the same series and overwrite each other`,
          });
        } else {
          ruleKeys.set(key, subject);
        }
      }

      if (alerting) {
        const labels = alertLabels(group, rule as AlertingRuleConfig);
        // PROM106: severity
        if (!labels.severity) {
          issues.push({
            code: "PROM106",
            severity: "warning",
            subject,
            message: `alert ${subject} has no severity label, so Alertmanager can only route it by name`,
          });
        }
        // PROM107: summary/description
        const ann = (rule as AlertingRuleConfig).annotations ?? {};
        if (!ann.summary && !ann.description) {
          issues.push({
            code: "PROM107",
            severity: "warning",
            subject,
            message: `alert ${subject} has no summary or description annotation; a notification carries only its labels`,
          });
        }
      }
    });
  }
  return issues;
}

/** Every severity value an alert in these rule files carries, with the alerts carrying it. */
export function alertSeverities(files: RuleFileConfig[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of files) {
    for (const group of Array.isArray(file?.groups) ? file.groups : []) {
      for (const rule of Array.isArray(group?.rules) ? group.rules : []) {
        if (!isAlertingRuleConfig(rule)) continue;
        const sev = alertLabels(group, rule).severity;
        if (!sev) continue;
        out.set(sev, [...(out.get(sev) ?? []), `${group.name}/${rule.alert}`]);
      }
    }
  }
  return out;
}

// ── Alertmanager ────────────────────────────────────────────────────

interface RouteVisit {
  route: RouteConfig;
  path: string;
  depth: number;
}

function visitRoutes(root: RouteConfig | undefined): RouteVisit[] {
  const out: RouteVisit[] = [];
  const walk = (route: RouteConfig, path: string, depth: number) => {
    out.push({ route, path, depth });
    (Array.isArray(route?.routes) ? route.routes : []).forEach((child, i) => walk(child, `${path}.routes[${i}]`, depth + 1));
  };
  if (root && typeof root === "object") walk(root, "route", 0);
  return out;
}

const AM_DURATIONS = ["group_wait", "group_interval", "repeat_interval"] as const;

/** Check an `alertmanager.yml` on its own (PROM201, PROM203-PROM210). */
export function validateAlertmanagerConfig(config: AlertmanagerConfig): PrometheusIssue[] {
  const issues: PrometheusIssue[] = [];
  const receivers = Array.isArray(config?.receivers) ? config.receivers : [];
  const intervals = Array.isArray(config?.time_intervals) ? config.time_intervals : [];
  const global = config?.global ?? {};

  // PROM203: duplicate names
  const seenReceivers = new Set<string>();
  for (const r of receivers) {
    const name = str(r?.name ?? "");
    if (seenReceivers.has(name)) {
      issues.push({ code: "PROM203", severity: "error", subject: name, message: `receiver "${name}" is declared more than once; receiver names must be unique` });
    }
    seenReceivers.add(name);
  }
  const seenIntervals = new Set<string>();
  for (const t of intervals) {
    const name = str(t?.name ?? "");
    if (seenIntervals.has(name)) {
      issues.push({ code: "PROM203", severity: "error", subject: name, message: `time interval "${name}" is declared more than once; time interval names must be unique` });
    }
    seenIntervals.add(name);
  }

  // PROM205: root route shape
  const root = config?.route;
  if (!root || typeof root !== "object") {
    issues.push({
      code: "PROM205",
      severity: "error",
      subject: "route",
      message: "alertmanager.yml has no root route; declare one Route with a receiver and nest the others under it",
    });
  } else {
    if (!root.receiver) {
      issues.push({ code: "PROM205", severity: "error", subject: "route", message: "the root route has no receiver; it is the default for every alert no child route takes" });
    }
    if (Array.isArray(root.matchers) && root.matchers.length > 0) {
      issues.push({ code: "PROM205", severity: "error", subject: "route", message: "the root route has matchers; it must match every alert, so put matchers on child routes" });
    }
  }

  const usedReceivers = new Set<string>();
  for (const { route, path } of visitRoutes(root)) {
    // PROM201: receiver exists
    if (route.receiver !== undefined) {
      const name = str(route.receiver);
      usedReceivers.add(name);
      if (!seenReceivers.has(name)) {
        issues.push({ code: "PROM201", severity: "error", subject: path, message: `${path} sends to receiver "${name}", which is not declared` });
      }
    }
    // PROM204: time intervals exist
    for (const field of ["mute_time_intervals", "active_time_intervals"] as const) {
      for (const t of route[field] ?? []) {
        if (!seenIntervals.has(str(t))) {
          issues.push({ code: "PROM204", severity: "error", subject: path, message: `${path} ${field} names time interval "${str(t)}", which is not declared` });
        }
      }
    }
    // PROM206: matchers parse
    for (const m of route.matchers ?? []) {
      const parsed = parseMatchers(str(m));
      if (!parsed.ok) issues.push({ code: "PROM206", severity: "error", subject: path, message: `${path} matcher ${parsed.error}` });
    }
    // PROM208: durations
    for (const field of AM_DURATIONS) {
      const v = route[field];
      if (v !== undefined && !isValidDuration(v)) {
        issues.push({ code: "PROM208", severity: "error", subject: path, message: `${path} ${field} "${str(v)}" is not a duration (e.g. 30s, 5m, 4h)` });
      }
    }
  }

  (Array.isArray(config?.inhibit_rules) ? config.inhibit_rules : []).forEach((rule, i) => {
    for (const field of ["source_matchers", "target_matchers"] as const) {
      for (const m of rule?.[field] ?? []) {
        const parsed = parseMatchers(str(m));
        if (!parsed.ok) {
          issues.push({ code: "PROM206", severity: "error", subject: `inhibit_rules[${i}]`, message: `inhibit_rules[${i}].${field} matcher ${parsed.error}` });
        }
      }
    }
  });

  // PROM208, PROM210: global settings
  issues.push(...validateGlobalSettings(global));

  // PROM207: unused receivers; PROM208-PROM210: integrations (./validate-integrations.ts)
  for (const r of receivers) {
    const name = str(r?.name ?? "");
    if (!usedReceivers.has(name)) {
      issues.push({ code: "PROM207", severity: "warning", subject: name, message: `receiver "${name}" is declared but no route sends to it` });
    }
    issues.push(...validateReceiverIntegrations(r, global));
    // A receiver with no integrations at all is valid: it is how Alertmanager drops alerts.
  }

  return issues;
}

function severityMatchers(route: RouteConfig): Matcher[] | undefined {
  const out: Matcher[] = [];
  for (const m of route.matchers ?? []) {
    const parsed = parseMatchers(str(m));
    if (!parsed.ok) return undefined;
    out.push(...parsed.matchers.filter((x) => x.name === "severity"));
  }
  return out;
}

/**
 * PROM202: every severity an alert carries is taken by some route below the
 * root that matches on `severity`. An alert whose severity no route names
 * falls through to the root route's default receiver.
 *
 * Only matchers on `severity` are read, since other labels (team, service)
 * come from the series and are not known at build time. A route counts when
 * it, or a route above it, matches on `severity`, and every severity matcher
 * on its path accepts the value.
 */
export function validateSeverityRouting(ruleFiles: RuleFileConfig[], config: AlertmanagerConfig): PrometheusIssue[] {
  const severities = alertSeverities(ruleFiles);
  if (severities.size === 0 || !config?.route) return [];

  const paths: Matcher[][] = [];
  const walk = (route: RouteConfig, inherited: Matcher[], depth: number) => {
    const own = severityMatchers(route);
    if (own === undefined) return; // PROM206 reports the unparseable matcher
    const path = [...inherited, ...own];
    if (depth > 0 && path.length > 0) paths.push(path);
    for (const child of Array.isArray(route.routes) ? route.routes : []) walk(child, path, depth + 1);
  };
  walk(config.route, [], 0);

  const issues: PrometheusIssue[] = [];
  for (const [severity, alerts] of severities) {
    const labels = { severity };
    const routed = paths.some((path) => path.every((m) => matcherMatches(m, labels)));
    if (!routed) {
      const shown = alerts.slice(0, 3).join(", ") + (alerts.length > 3 ? `, and ${alerts.length - 3} more` : "");
      issues.push({
        code: "PROM202",
        severity: "warning",
        subject: severity,
        message: `no route matches severity="${severity}" (${shown}); those alerts fall through to the root route's default receiver`,
      });
    }
  }
  return issues;
}
