/**
 * Rule file and Alertmanager config checks, as plain functions over the
 * parsed files.
 *
 * The post-synth checks in `lint/post-synth/` are thin wrappers around these,
 * so the same rules run anywhere the files exist: on a build's output, on a
 * `PrometheusRule`'s groups, or on a file parsed by some other tool.
 */

import { durationMs, formatDuration, isValidDuration } from "./duration";
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
import {
  hasCondition,
  histogramProblems,
  isMultiWindow,
  keepsLabel,
  nonCounterRates,
  parsePromql,
  readsOnlyOverTime,
  regexProblems,
  resultLabels,
  selectors,
} from "./promql-analysis";
import { validateGlobalSettings, validateReceiverIntegrations } from "./validate-integrations";
import { validateGlobalSecurity, validateReceiverSecurity } from "./validate-security";

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
  | "PROM210"
  | "PROM211"
  | "PROM212"
  | "PROM213"
  | "PROM214"
  | "PROM215"
  | "PROM216"
  | "PROM217"
  | "PROM218"
  | "PROM219"
  | "PROM220"
  | "PROM221"
  | "PROM222"
  | "PROM223"
  | "PROM224";

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

/** The `$labels.x`, `.Labels.x` and `index $labels "x"` references in a template. */
function templateLabels(template: string): string[] {
  const out = new Set<string>();
  for (const re of [/\$labels\.([A-Za-z_][A-Za-z0-9_]*)/g, /\.Labels\.([A-Za-z_][A-Za-z0-9_]*)/g, /index\s+\$labels\s+"([^"]+)"/g]) {
    for (const m of template.matchAll(re)) out.add(m[1]);
  }
  return [...out];
}

/** `level:metric:operations`: three or more non-empty parts separated by colons. */
const RECORD_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z0-9_]+){2,}$/;

/** PROM215, PROM216 and PROM218: what any rule's expression can get wrong. */
function exprIssues(expr: string, subject: string): PrometheusIssue[] {
  const issues: PrometheusIssue[] = [];
  for (const { fn, name } of nonCounterRates(expr)) {
    issues.push({
      code: "PROM215",
      severity: "warning",
      subject,
      message: `rule ${subject} takes ${fn}() of ${name}, whose name does not end in _total, _count, _sum or _bucket; ${fn}() reads only counters, so use delta() or deriv() for a gauge`,
    });
  }
  for (const { call, problem } of histogramProblems(expr)) {
    issues.push({
      code: "PROM216",
      severity: "warning",
      subject,
      message:
        problem === "no-bucket"
          ? `rule ${subject} ${call} reads a series without _bucket in its name; a classic histogram's quantile needs its _bucket series`
          : `rule ${subject} ${call} aggregates away the le label; keep le in by (...), or out of without (...)`,
    });
  }
  for (const { matcher, problem } of regexProblems(expr)) {
    issues.push({
      code: "PROM218",
      severity: "warning",
      subject,
      message:
        problem === "literal"
          ? `rule ${subject} matcher ${matcher} has no regex metacharacters; use = or != instead`
          : `rule ${subject} matcher ${matcher} is anchored; Prometheus anchors every regex, so drop the ^ and $`,
    });
  }
  return issues;
}

/** PROM211, PROM213, PROM214 and PROM219: alerting rules. */
function alertIssues(group: RuleGroupConfig, rule: AlertingRuleConfig, subject: string): PrometheusIssue[] {
  const issues: PrometheusIssue[] = [];
  const expr = typeof rule.expr === "string" ? rule.expr : "";
  // An expression that reads no series (`vector(1)`) is a deliberate always-firing
  // alert, a dead man's switch; PROM211 and PROM213 leave it alone.
  const heartbeat = parsePromql(expr) !== undefined && selectors(expr).length === 0;

  // PROM211: no for, or for: 0s. An expression that already spans a window
  // (every selector read through *_over_time, or the multi-window `and` of two
  // conditions, where the short window does what for would) is left alone. A
  // for that is not a duration is PROM103's.
  const forMs = rule.for === undefined ? 0 : durationMs(str(rule.for));
  if (forMs === 0 && !heartbeat && !readsOnlyOverTime(expr) && !isMultiWindow(expr)) {
    issues.push({
      code: "PROM211",
      severity: "warning",
      subject,
      message: `alert ${subject} has ${rule.for === undefined ? "no for" : `for: ${str(rule.for)}`}, so one evaluation that matches fires it; set for to how long the condition must hold`,
    });
  }

  // PROM213: no condition
  if (!heartbeat && hasCondition(expr) === false) {
    issues.push({
      code: "PROM213",
      severity: "warning",
      subject,
      message: `alert ${subject} expression has no comparison, so it fires for every series it returns; add a condition such as > 0`,
    });
  }

  // PROM214: a template reads a label the expression aggregates away. A label
  // the rule or its group sets is left alone.
  const scope = resultLabels(expr);
  if (scope) {
    const fixed = alertLabels(group, rule);
    const reported = new Set<string>();
    for (const [key, value] of [...Object.entries(rule.annotations ?? {}), ...Object.entries(rule.labels ?? {})]) {
      for (const label of templateLabels(str(value))) {
        if (keepsLabel(scope, label) || label in fixed || reported.has(label)) continue;
        reported.add(label);
        issues.push({
          code: "PROM214",
          severity: "warning",
          subject,
          message: `alert ${subject} ${key} reads $labels.${label}, which the expression's by or without drops, so it renders empty`,
        });
      }
    }
  }

  // PROM219: alertname set by hand
  for (const [where, labels] of [
    ["labels", rule.labels],
    ["group labels", group.labels],
  ] as const) {
    if (labels && Object.prototype.hasOwnProperty.call(labels, "alertname")) {
      issues.push({
        code: "PROM219",
        severity: "warning",
        subject,
        message: `alert ${subject} ${where} set alertname; Prometheus sets alertname to the rule's name and overwrites it`,
      });
    }
  }
  return issues;
}

/** Check a rule file (PROM101-PROM107, PROM211 and PROM213-PROM219). PROM212 is opt-in; see {@link validateRunbookUrls}. */
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
        issues.push(...alertIssues(group, rule as AlertingRuleConfig, subject));
      }

      // PROM217: recording rule name
      if (recording && !alerting && rule.record.trim() !== "" && !RECORD_NAME.test(rule.record)) {
        issues.push({
          code: "PROM217",
          severity: "warning",
          subject,
          message: `recording rule ${subject} is not named level:metric:operations (e.g. job:http_requests:rate5m)`,
        });
      }

      if (checked.ok) issues.push(...exprIssues(expr as string, subject));
    });
  }
  return issues;
}

/**
 * PROM212: alerts without a `runbook_url` annotation. Not part of
 * {@link validateRuleFile}, because the check is opt-in: the lint preset
 * `all`, or a `lint.rules` entry for PROM212, turns it on.
 */
export function validateRunbookUrls(file: RuleFileConfig): PrometheusIssue[] {
  const issues: PrometheusIssue[] = [];
  for (const group of Array.isArray(file?.groups) ? file.groups : []) {
    (Array.isArray(group?.rules) ? group.rules : []).forEach((rule, i) => {
      if (!isAlertingRuleConfig(rule) || rule.annotations?.runbook_url) return;
      const subject = ruleLabel(group, i, rule);
      issues.push({ code: "PROM212", severity: "warning", subject, message: `alert ${subject} has no runbook_url annotation` });
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

/** Alertmanager's defaults for a root route that sets neither (config/config.go). */
const DEFAULT_GROUP_INTERVAL_MS = 5 * 60_000;
const DEFAULT_REPEAT_INTERVAL_MS = 4 * 3_600_000;

/**
 * PROM223: routes whose repeat_interval, as set or inherited, is shorter
 * than their group_interval. Alertmanager only resends when a group is
 * flushed, every group_interval, so the shorter repeat_interval never takes
 * effect. Reported on the route that sets one of the two.
 */
function repeatIntervalIssues(root: RouteConfig | undefined): PrometheusIssue[] {
  const issues: PrometheusIssue[] = [];
  const walk = (route: RouteConfig, path: string, groupMs: number, repeatMs: number) => {
    const ownGroup = route.group_interval !== undefined ? durationMs(str(route.group_interval)) : groupMs;
    const ownRepeat = route.repeat_interval !== undefined ? durationMs(str(route.repeat_interval)) : repeatMs;
    if (ownGroup === undefined || ownRepeat === undefined) return; // PROM208
    if ((route.group_interval !== undefined || route.repeat_interval !== undefined) && ownRepeat < ownGroup) {
      issues.push({
        code: "PROM223",
        severity: "warning",
        subject: path,
        message: `${path} repeat_interval (${formatDuration(ownRepeat)}) is shorter than its group_interval (${formatDuration(ownGroup)}); notifications repeat no faster than group_interval`,
      });
    }
    (Array.isArray(route.routes) ? route.routes : []).forEach((child, i) => walk(child, `${path}.routes[${i}]`, ownGroup, ownRepeat));
  };
  if (root && typeof root === "object") walk(root, "route", DEFAULT_GROUP_INTERVAL_MS, DEFAULT_REPEAT_INTERVAL_MS);
  return issues;
}

function parsedList(entries: unknown): Matcher[] | undefined {
  const out: Matcher[] = [];
  for (const m of Array.isArray(entries) ? entries : []) {
    const parsed = parseMatchers(str(m));
    if (!parsed.ok) return undefined; // PROM206
    out.push(...parsed.matchers);
  }
  return out;
}

/** A regex's alternatives when every one is a plain string, e.g. `a|b` gives `["a", "b"]`. */
function literalAlternatives(regex: string): string[] | undefined {
  const parts = regex.split("|");
  return parts.every((p) => !/[.+*?()[\]{}\\^$]/.test(p)) ? parts : undefined;
}

/**
 * Whether some label set matches every matcher. A label whose matchers
 * name values (`=`, or a regex of plain alternatives) is tried with those
 * values; one with only negative or open-ended matchers is taken to have a
 * value that passes.
 */
function satisfiable(matchers: Matcher[]): boolean {
  const byLabel = new Map<string, Matcher[]>();
  for (const m of matchers) byLabel.set(m.name, [...(byLabel.get(m.name) ?? []), m]);
  for (const [name, ms] of byLabel) {
    const candidates = new Set<string>();
    let bounded = false;
    for (const m of ms) {
      if (m.op === "=") {
        candidates.add(m.value);
        bounded = true;
      } else if (m.op === "=~") {
        const alts = literalAlternatives(m.value);
        if (alts) {
          alts.forEach((a) => candidates.add(a));
          bounded = true;
        }
      }
    }
    if (!bounded) continue;
    if (![...candidates].some((v) => ms.every((m) => matcherMatches(m, { [name]: v })))) return false;
  }
  return true;
}

/** Check an `alertmanager.yml` on its own (PROM201, PROM203-PROM210, PROM220-PROM224). */
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

  // PROM223: repeat_interval under group_interval
  issues.push(...repeatIntervalIssues(root));

  // PROM224: an inhibit rule an alert can be both source and target of, with no equal
  (Array.isArray(config?.inhibit_rules) ? config.inhibit_rules : []).forEach((rule, i) => {
    if (Array.isArray(rule?.equal) && rule.equal.length > 0) return;
    const source = parsedList(rule?.source_matchers);
    const target = parsedList(rule?.target_matchers);
    if (!source || !target || !satisfiable([...source, ...target])) return;
    issues.push({
      code: "PROM224",
      severity: "warning",
      subject: `inhibit_rules[${i}]`,
      message: `inhibit_rules[${i}]: one alert can match both source_matchers and target_matchers, and there is no equal, so any such alert firing mutes every other; list the labels the two must share under equal`,
    });
  });

  // PROM208, PROM210: global settings; PROM220: global TLS
  issues.push(...validateGlobalSettings(global));
  issues.push(...validateGlobalSecurity(global));

  // PROM207: unused receivers; PROM208-PROM210: integrations (./validate-integrations.ts)
  for (const r of receivers) {
    const name = str(r?.name ?? "");
    if (!usedReceivers.has(name)) {
      issues.push({ code: "PROM207", severity: "warning", subject: name, message: `receiver "${name}" is declared but no route sends to it` });
    }
    issues.push(...validateReceiverIntegrations(r, global));
    issues.push(...validateReceiverSecurity(r, global));
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
