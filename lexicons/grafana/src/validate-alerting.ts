/**
 * The checks behind GRAF111-GRAF114, and the alert-rule half of GRAF108 and GRAF116, as
 * plain functions over alerting provisioning files (parsed). The
 * post-synth checks run them over a build's output; a test or another
 * lexicon holding the same YAML can call them directly.
 *
 * - GRAF111: a rule's queries and expressions fit together: its condition,
 *   each expression's inputs and a recording rule's `record.from` name a
 *   refId of the rule, refIds are unique, and each expression model is
 *   valid for the pinned `expr` schema.
 * - GRAF112: each query's datasource is one the build knows (provisioned or
 *   `ExternalDatasource`), and of the type the query model says.
 * - GRAF113: the policy tree and rules route to contact points and mute
 *   timings the build declares, and their matchers parse.
 * - GRAF114: uids, names, titles and intervals Grafana accepts, and nothing
 *   declared twice (a duplicate stops Grafana provisioning every alerting
 *   file at startup).
 *
 * Like GRAF101, a reference check only reports an error when the build
 * declares things of that kind; with none declared it warns once that it
 * cannot check, since the thing may already exist in Grafana.
 */

import { durationMs, isValidDuration } from "@intentius/chant-lexicon-prometheus/duration";
import { parseMatchers } from "@intentius/chant-lexicon-prometheus/matchers";
import { EXPRESSION_DATASOURCE_UID } from "./alerting";
import type { KnownDatasource } from "./datasource-refs";
import { isValidUid } from "./util";
import { schemaValidationUnavailable, validateExpressionSchema } from "./schema-validate";
import { checkGrafanaPromql } from "./promql-check";
import { checkGrafanaLogql } from "./query-syntax";

type Json = Record<string, unknown>;

/** One alerting provisioning file, parsed, and where it came from. */
export interface AlertingDoc {
  source?: string;
  json: Json;
}

export type AlertingIssueCode = "GRAF108" | "GRAF111" | "GRAF112" | "GRAF113" | "GRAF114" | "GRAF116";

export interface AlertingIssue {
  code: AlertingIssueCode;
  severity: "error" | "warning";
  message: string;
  /** The rule uid, contact point or group the issue is about. */
  entity?: string;
}

/** Contact point names Grafana has without provisioning: the default email contact point. */
export const BUILTIN_CONTACT_POINTS: ReadonlySet<string> = new Set(["grafana-default-email"]);

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function listOf(doc: Json, key: string): Json[] {
  const v = doc[key];
  return Array.isArray(v) ? v.filter(isObject) : [];
}

function orgOf(o: Json): number {
  return typeof o.orgId === "number" && o.orgId >= 1 ? o.orgId : 1;
}

export interface RuleInfo {
  rule: Json;
  group: Json;
  /** `rule "<title>" (uid <uid>)`. */
  where: string;
}

/** Every rule of every group across the files. */
export function alertRules(docs: readonly AlertingDoc[]): RuleInfo[] {
  const out: RuleInfo[] = [];
  for (const { json } of docs) {
    for (const group of listOf(json, "groups")) {
      for (const rule of Array.isArray(group.rules) ? group.rules.filter(isObject) : []) {
        out.push({ rule, group, where: `alert rule "${String(rule.title ?? "?")}" (uid ${String(rule.uid ?? "?")})` });
      }
    }
  }
  return out;
}

function queriesOf(rule: Json): Json[] {
  return Array.isArray(rule.data) ? rule.data.filter(isObject) : [];
}

function modelOf(q: Json): Json {
  return isObject(q.model) ? q.model : {};
}

// ── GRAF111: queries and expressions ────────────────────────────

/** The refIds an expression reads. */
export function expressionInputs(model: Json): string[] {
  const refs = new Set<string>();
  const one = (v: unknown) => {
    if (typeof v === "string" && v.trim() !== "") refs.add(v.trim().replace(/^\$\{?([^}]*)\}?$/, "$1"));
  };
  switch (model.type) {
    case "reduce":
    case "threshold":
    case "resample":
      one(model.expression);
      break;
    case "math":
      if (typeof model.expression === "string") {
        for (const m of model.expression.matchAll(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) refs.add(m[1] ?? m[2]);
      }
      break;
    case "classic_conditions":
      for (const c of Array.isArray(model.conditions) ? model.conditions : []) {
        const params = isObject(c) && isObject(c.query) && Array.isArray(c.query.params) ? c.query.params : [];
        one(params[0]);
      }
      break;
  }
  return [...refs];
}

export function checkRuleQueries(docs: readonly AlertingDoc[]): AlertingIssue[] {
  const issues: AlertingIssue[] = [];
  for (const { rule, where } of alertRules(docs)) {
    const push = (message: string, severity: AlertingIssue["severity"] = "error") =>
      issues.push({ code: "GRAF111", severity, message: `${where} ${message}`, entity: String(rule.uid ?? rule.title ?? "") });
    const data = queriesOf(rule);
    if (data.length === 0) {
      push("has no queries; Grafana refuses to provision it.");
      continue;
    }
    const refIds = data.map((q) => q.refId);
    const seen = new Set<unknown>();
    for (const r of refIds) {
      if (typeof r !== "string" || r === "") push("has a query with no refId.");
      else if (seen.has(r)) push(`has two queries with refId "${r}".`);
      seen.add(r);
    }
    const known = new Set(refIds.filter((r): r is string => typeof r === "string"));
    const list = [...known].join(", ");
    const record = isObject(rule.record) ? rule.record : undefined;
    if (record) {
      if (typeof record.metric !== "string" || record.metric === "") push("is a recording rule with no record.metric.");
      if (typeof record.from !== "string" || !known.has(record.from)) push(`records from "${String(record.from)}", which is not one of its refIds (${list}).`);
    } else if (typeof rule.condition !== "string" || rule.condition === "") {
      push("has no condition; an alert rule needs the refId whose result fires it.");
    } else if (!known.has(rule.condition)) {
      push(`has condition "${rule.condition}", which is not one of its refIds (${list}).`);
    }
    for (const q of data) {
      if (q.datasourceUid !== EXPRESSION_DATASOURCE_UID) continue;
      const model = modelOf(q);
      const at = `expression ${String(q.refId ?? "?")}`;
      const unavailable = schemaValidationUnavailable();
      if (unavailable) push(`${at} was not checked against the Grafana expression schema: ${unavailable}.`, "warning");
      for (const p of unavailable ? [] : validateExpressionSchema(model)) {
        if (p.severity === "error") push(`${at} ${p.path === "/" ? "" : `${p.path.slice(1)} `}${p.message} (Grafana expression schema).`);
      }
      for (const input of expressionInputs(model)) {
        if (input === q.refId) push(`${at} reads its own result.`);
        else if (!known.has(input)) push(`${at} reads "${input}", which is not one of the rule's refIds (${list}).`);
      }
    }
  }
  return issues;
}

// ── GRAF112 and GRAF108: datasources ────────────────────────────

/** Where one query goes: the known datasource, or the type its model states. */
function resolveQuery(q: Json, known: ReadonlyMap<string, KnownDatasource>): { uid: string; declared?: KnownDatasource; statedType?: string } | undefined {
  const uid = q.datasourceUid;
  if (typeof uid !== "string" || uid === EXPRESSION_DATASOURCE_UID) return undefined;
  const ds = modelOf(q).datasource;
  const statedType = isObject(ds) && typeof ds.type === "string" && ds.type !== "" ? ds.type : undefined;
  return { uid, declared: known.get(uid), ...(statedType ? { statedType } : {}) };
}

export function checkRuleDatasources(docs: readonly AlertingDoc[], known: ReadonlyMap<string, KnownDatasource>): AlertingIssue[] {
  const issues: AlertingIssue[] = [];
  const unchecked = new Set<string>();
  for (const { rule, where } of alertRules(docs)) {
    const entity = String(rule.uid ?? rule.title ?? "");
    for (const q of queriesOf(rule)) {
      const r = resolveQuery(q, known);
      if (!r) continue;
      const at = `${where} query ${String(q.refId ?? "?")}`;
      if (!r.declared) {
        if (known.size === 0) unchecked.add(r.uid);
        else {
          issues.push({
            code: "GRAF112",
            severity: "error",
            message: `${at} uses datasource uid "${r.uid}", which no declared Datasource or ExternalDatasource has. Declared: ${[...known.keys()].map((k) => `"${k}"`).join(", ")}.`,
            entity,
          });
        }
      } else if (r.statedType && r.statedType !== r.declared.type) {
        issues.push({
          code: "GRAF112",
          severity: "error",
          message: `${at} has a ${r.statedType} query model, but datasource "${r.declared.name ?? r.uid}" is ${r.declared.type}.`,
          entity,
        });
      }
    }
    const record = isObject(rule.record) ? rule.record : undefined;
    const target = record?.targetDatasourceUid;
    if (typeof target === "string" && target !== "" && known.size > 0) {
      const ds = known.get(target);
      if (!ds) issues.push({ code: "GRAF112", severity: "error", message: `${where} writes to datasource uid "${target}", which no declared Datasource or ExternalDatasource has.`, entity });
      else if (ds.type !== "prometheus") issues.push({ code: "GRAF112", severity: "error", message: `${where} writes its metric to datasource "${ds.name ?? target}", which is ${ds.type}; Grafana writes recorded metrics to Prometheus.`, entity });
    }
  }
  if (unchecked.size > 0) {
    const uids = [...unchecked].map((u) => `"${u}"`).join(", ");
    issues.push({
      code: "GRAF112",
      severity: "warning",
      message: `Alert rules query datasource uid${unchecked.size > 1 ? "s" : ""} ${uids}, but the build declares no datasource, so GRAF112 cannot check ${unchecked.size > 1 ? "them" : "it"}. Declare a Datasource, or an ExternalDatasource for one that already exists in Grafana.`,
    });
  }
  return issues;
}

/** Every `expr` an alert rule sends to a datasource of one plugin type (PromQL to `prometheus`, LogQL to `loki`), and where it is written. */
export function alertRuleExprs(
  docs: readonly AlertingDoc[],
  known: ReadonlyMap<string, KnownDatasource>,
  pluginType: string,
): Array<{ where: string; expr: string; entity: string }> {
  const out: Array<{ where: string; expr: string; entity: string }> = [];
  for (const { rule, where } of alertRules(docs)) {
    for (const q of queriesOf(rule)) {
      const r = resolveQuery(q, known);
      if (!r) continue;
      const type = r.declared?.type ?? r.statedType;
      const expr = modelOf(q).expr;
      if (type !== pluginType || typeof expr !== "string" || expr.trim() === "") continue;
      out.push({ where: `${where} query ${String(q.refId ?? "?")}`, expr, entity: String(rule.uid ?? rule.title ?? "") });
    }
  }
  return out;
}

/** Every PromQL expression an alert rule sends to Prometheus, and where it is written. */
export function alertRulePromql(docs: readonly AlertingDoc[], known: ReadonlyMap<string, KnownDatasource>): Array<{ where: string; expr: string; entity: string }> {
  return alertRuleExprs(docs, known, "prometheus");
}

/** GRAF108 over alert rules: the PromQL of each query that reaches Prometheus parses. */
export function checkRulePromql(docs: readonly AlertingDoc[], known: ReadonlyMap<string, KnownDatasource>): AlertingIssue[] {
  const issues: AlertingIssue[] = [];
  for (const { where, expr, entity } of alertRulePromql(docs, known)) {
    const checked = checkGrafanaPromql(expr);
    if (!checked.ok) issues.push({ code: "GRAF108", severity: "error", message: `${where} is not valid PromQL: ${checked.message}.`, entity });
  }
  return issues;
}

/** GRAF116 over alert rules: the LogQL of each query that reaches Loki parses. */
export function checkRuleLogql(docs: readonly AlertingDoc[], known: ReadonlyMap<string, KnownDatasource>): AlertingIssue[] {
  const issues: AlertingIssue[] = [];
  for (const { where, expr, entity } of alertRuleExprs(docs, known, "loki")) {
    const checked = checkGrafanaLogql(expr);
    if (!checked.ok) issues.push({ code: "GRAF116", severity: "error", message: `${where} is not valid LogQL: ${checked.message}.`, entity });
  }
  return issues;
}

// ── GRAF113: notification references ────────────────────────────

interface Named {
  contactPoints: Set<string>;
  timings: Set<string>;
}

function declaredNames(docs: readonly AlertingDoc[]): Named {
  const contactPoints = new Set<string>();
  const timings = new Set<string>();
  for (const { json } of docs) {
    for (const c of listOf(json, "contactPoints")) if (typeof c.name === "string") contactPoints.add(c.name);
    for (const t of listOf(json, "muteTimes")) if (typeof t.name === "string") timings.add(t.name);
  }
  return { contactPoints, timings };
}

const OPS = new Set(["=", "!=", "=~", "!~"]);

export function checkNotificationRefs(docs: readonly AlertingDoc[]): AlertingIssue[] {
  const issues: AlertingIssue[] = [];
  const named = declaredNames(docs);
  const uncheckedReceivers = new Set<string>();
  const uncheckedTimings = new Set<string>();

  const receiver = (name: unknown, where: string, entity: string) => {
    if (typeof name !== "string" || name === "" || BUILTIN_CONTACT_POINTS.has(name) || named.contactPoints.has(name)) return;
    if (named.contactPoints.size === 0) uncheckedReceivers.add(name);
    else issues.push({ code: "GRAF113", severity: "error", message: `${where} sends to contact point "${name}", which the build does not declare. Declared: ${[...named.contactPoints].map((n) => `"${n}"`).join(", ")}.`, entity });
  };
  const timings = (list: unknown, key: string, where: string, entity: string) => {
    for (const name of Array.isArray(list) ? list : []) {
      if (typeof name !== "string" || named.timings.has(name)) continue;
      if (named.timings.size === 0) uncheckedTimings.add(name);
      else issues.push({ code: "GRAF113", severity: "error", message: `${where} ${key} names "${name}", which is not a declared mute timing. Declared: ${[...named.timings].map((n) => `"${n}"`).join(", ")}.`, entity });
    }
  };
  const route = (r: Json, where: string, entity: string, root: boolean) => {
    receiver(r.receiver, where, entity);
    if (root && (typeof r.receiver !== "string" || r.receiver === "")) {
      issues.push({ code: "GRAF113", severity: "error", message: `${where} has no receiver; the root policy must name the contact point every unmatched alert goes to.`, entity });
    }
    timings(r.mute_time_intervals, "mute_time_intervals", where, entity);
    timings(r.active_time_intervals, "active_time_intervals", where, entity);
    for (const m of Array.isArray(r.object_matchers) ? r.object_matchers : []) {
      if (!Array.isArray(m) || m.length !== 3 || typeof m[0] !== "string" || !OPS.has(m[1] as string) || typeof m[2] !== "string") {
        issues.push({ code: "GRAF113", severity: "error", message: `${where} has object matcher ${JSON.stringify(m)}; each is [label, op, value] with op one of =, !=, =~, !~.`, entity });
      } else if ((m[1] === "=~" || m[1] === "!~") && !validRegex(m[2])) {
        issues.push({ code: "GRAF113", severity: "error", message: `${where} matches ${m[0]} against "${m[2]}", which is not a valid regular expression.`, entity });
      }
    }
    for (const m of Array.isArray(r.matchers) ? r.matchers : []) {
      const parsed = typeof m === "string" ? parseMatchers(m) : { ok: false as const, error: `${JSON.stringify(m)} is not a string` };
      if (!parsed.ok) issues.push({ code: "GRAF113", severity: "error", message: `${where} has matcher ${JSON.stringify(m)}: ${parsed.error}.`, entity });
    }
    (Array.isArray(r.routes) ? r.routes.filter(isObject) : []).forEach((c, i) => route(c, `${where} > route ${i + 1}`, entity, false));
  };

  for (const { json } of docs) {
    for (const p of listOf(json, "policies")) route(p, `The notification policy tree of org ${orgOf(p)}`, `policies:${orgOf(p)}`, true);
  }
  for (const { rule, where } of alertRules(docs)) {
    const ns = isObject(rule.notification_settings) ? rule.notification_settings : undefined;
    if (!ns) continue;
    const entity = String(rule.uid ?? rule.title ?? "");
    receiver(ns.receiver, where, entity);
    timings(ns.mute_time_intervals, "notification_settings.mute_time_intervals", where, entity);
    timings(ns.active_time_intervals, "notification_settings.active_time_intervals", where, entity);
  }
  if (uncheckedReceivers.size > 0) {
    issues.push({
      code: "GRAF113",
      severity: "warning",
      message: `Alerting routes to contact point${uncheckedReceivers.size > 1 ? "s" : ""} ${[...uncheckedReceivers].map((n) => `"${n}"`).join(", ")}, but the build declares no ContactPoint, so GRAF113 cannot check that ${uncheckedReceivers.size > 1 ? "they exist" : "it exists"} in Grafana.`,
    });
  }
  if (uncheckedTimings.size > 0) {
    issues.push({
      code: "GRAF113",
      severity: "warning",
      message: `Alerting names mute timing${uncheckedTimings.size > 1 ? "s" : ""} ${[...uncheckedTimings].map((n) => `"${n}"`).join(", ")}, but the build declares no MuteTiming, so GRAF113 cannot check that ${uncheckedTimings.size > 1 ? "they exist" : "it exists"} in Grafana.`,
    });
  }
  return issues;
}

function validRegex(re: string): boolean {
  try {
    new RegExp(`^(?:${re})$`);
    return true;
  } catch {
    return false;
  }
}

// ── GRAF114: identity, duplicates and intervals ─────────────────

/** Grafana's scheduler ticks every 10 seconds; a group's interval must be a positive multiple of it. */
export const BASE_INTERVAL_SECONDS = 10;

const DURATION_FIELDS = ["for", "keepFiringFor"] as const;

export function checkAlertingIdentity(docs: readonly AlertingDoc[]): AlertingIssue[] {
  const issues: AlertingIssue[] = [];
  const push = (message: string, entity?: string, severity: AlertingIssue["severity"] = "error") => issues.push({ code: "GRAF114", severity, message, ...(entity ? { entity } : {}) });
  const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

  const ruleUids = new Map<string, number>();
  const groups = new Map<string, number>();
  const cpNames = new Map<string, number>();
  const receiverUids = new Map<string, number>();
  const policyOrgs = new Map<string, number>();
  const timingNames = new Map<string, number>();
  const templateNames = new Map<string, number>();

  for (const { json } of docs) {
    for (const g of listOf(json, "groups")) {
      const name = typeof g.name === "string" ? g.name : "";
      const where = `Rule group "${name}"`;
      if (name.trim() === "") push(`A rule group has no name; Grafana refuses the file.`);
      if (typeof g.folder !== "string" || g.folder.trim() === "") push(`${where} has no folder; Grafana refuses the file.`, name);
      count(groups, `${orgOf(g)}\u0000${String(g.folder)}\u0000${name}`);
      const interval = g.interval;
      if (typeof interval !== "string" || !isValidDuration(interval)) push(`${where} has interval ${JSON.stringify(interval)}, not a duration like 1m.`, name);
      else {
        const ms = durationMs(interval)!;
        if (ms <= 0 || ms % (BASE_INTERVAL_SECONDS * 1000) !== 0) push(`${where} has interval ${interval}; Grafana evaluates rules every ${BASE_INTERVAL_SECONDS}s, so it must be a positive multiple of ${BASE_INTERVAL_SECONDS}s.`, name);
      }
    }
    for (const c of listOf(json, "contactPoints")) {
      const name = typeof c.name === "string" ? c.name : "";
      if (name.trim() === "") push("A contact point has no name; Grafana refuses the file.");
      count(cpNames, `${orgOf(c)}\u0000${name}`);
      const receivers = Array.isArray(c.receivers) ? c.receivers.filter(isObject) : [];
      if (receivers.length === 0) push(`Contact point "${name}" has no receivers.`, name, "warning");
      for (const r of receivers) {
        const uid = r.uid;
        if (typeof uid !== "string" || !isValidUid(uid)) push(`Contact point "${name}" has a ${String(r.type)} receiver with uid ${JSON.stringify(uid)}; Grafana needs 1-40 letters, digits, "-" and "_".`, name);
        else count(receiverUids, `${orgOf(c)}\u0000${uid}`);
        if (!isObject(r.settings) || Object.keys(r.settings).length === 0) push(`Contact point "${name}" has a ${String(r.type)} receiver with no settings; Grafana refuses the file.`, name);
      }
    }
    for (const p of listOf(json, "policies")) count(policyOrgs, String(orgOf(p)));
    for (const t of listOf(json, "muteTimes")) count(timingNames, `${orgOf(t)}\u0000${String(t.name)}`);
    for (const t of listOf(json, "templates")) count(templateNames, `${orgOf(t)}\u0000${String(t.name)}`);
  }

  for (const { rule, group, where } of alertRules(docs)) {
    const uid = rule.uid;
    const entity = String(uid ?? rule.title ?? "");
    if (typeof uid !== "string" || !isValidUid(uid)) {
      push(`${where} has uid ${JSON.stringify(uid)}; Grafana needs 1-40 letters, digits, "-" and "_", and one bad rule stops it provisioning every alerting file.`, entity);
    } else count(ruleUids, `${orgOf(group)}\u0000${uid}`);
    if (typeof rule.title !== "string" || rule.title.trim() === "") push(`${where} has no title; Grafana refuses the file.`, entity);
    else if (rule.title.length > 190) push(`${where} has a title of ${rule.title.length} characters; Grafana allows 190.`, entity);
    for (const key of DURATION_FIELDS) {
      const v = rule[key];
      if (v !== undefined && (typeof v !== "string" || !isValidDuration(v))) push(`${where} has ${key} ${JSON.stringify(v)}, not a duration like 5m.`, entity);
    }
    for (const s of ["noDataState", "execErrState"] as const) {
      const allowed = s === "noDataState" ? ["NoData", "Alerting", "OK", "KeepLast"] : ["Error", "Alerting", "OK", "KeepLast"];
      const v = rule[s];
      if (v !== undefined && v !== "" && !allowed.includes(v as string)) push(`${where} has ${s} ${JSON.stringify(v)}; Grafana accepts ${allowed.join(", ")}.`, entity);
    }
  }

  const report = (map: Map<string, number>, what: (key: string[]) => string) => {
    for (const [key, n] of map) if (n > 1) push(`${n} ${what(key.split("\u0000"))}`, key.split("\u0000").slice(-1)[0]);
  };
  report(ruleUids, ([org, uid]) => `alert rules share the uid "${uid}" in org ${org}; Grafana stops provisioning.`);
  report(groups, ([org, folder, name]) => `rule groups are named "${name}" in folder "${folder}" (org ${org}); Grafana keeps one.`);
  report(cpNames, ([org, name]) => `contact points are named "${name}" in org ${org}; put the integrations in one contact point's receivers.`);
  report(receiverUids, ([org, uid]) => `contact point receivers share the uid "${uid}" in org ${org}.`);
  report(policyOrgs, ([org]) => `notification policy trees are declared for org ${org}; each replaces the whole tree, so only the last one would stand.`);
  report(timingNames, ([org, name]) => `mute timings are named "${name}" in org ${org}.`);
  report(templateNames, ([org, name]) => `notification templates are named "${name}" in org ${org}.`);
  return issues;
}
