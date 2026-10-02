/**
 * From alerting entities to Grafana's alerting provisioning file,
 * `provisioning/alerting/chant.yaml`.
 *
 * The file is what Grafana's file provisioner reads
 * (`pkg/services/provisioning/alerting`, the same at v12.4.11 and v13.2.2)
 * and what `GET /api/v1/provisioning/*\/export` writes: `apiVersion: 1`
 * and the lists `groups`, `contactPoints`, `policies`, `muteTimes` and
 * `templates`. Mount `provisioning/` at `/etc/grafana/provisioning`, as for
 * datasources and dashboards.
 *
 * Plain functions, so a test or another lexicon can render the same file
 * with `alertingYaml()` without a build.
 */

import { dump } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { durationMs, isValidDuration } from "@intentius/chant-lexicon-prometheus/duration";
import {
  EXPRESSION_DATASOURCE_UID,
  isAlertQueryEntity,
  isAlertRuleGroupEntity,
  isContactPointEntity,
  isExpressionEntity,
  isMuteTimingEntity,
  isNotificationPolicyEntity,
  isNotificationTemplateEntity,
  type AlertDuration,
  type AlertRuleData,
  type AlertRuleEntity,
  type AlertRuleGroupEntity,
  type ContactPointEntity,
  type MuteTimingEntity,
  type NotificationPolicyEntity,
  type NotificationTemplateEntity,
  type PolicyRoute,
  type RelativeTimeRange,
} from "./alerting";
import { isDashboardEntity } from "./dashboard";
import { isQueryEntity, type QueryEntity } from "./query";
import { isDatasourceVariable } from "./variables";
import { compact, slugUid } from "./util";
// build.ts imports this module too; only functions cross the cycle, and only at call time.
import { datasourceRef, targetJson } from "./build";

/** Where the alerting provisioning file goes, relative to the build output directory. */
export const ALERTING_FILE = "provisioning/alerting/chant.yaml";

/** The time range a query reads when neither it nor its rule sets one: the last 10 minutes, Grafana's editor default. */
export const DEFAULT_RELATIVE_TIME_RANGE = { from: 600, to: 0 } as const;

/** A rule group's evaluation interval when it sets none. */
export const DEFAULT_GROUP_INTERVAL = "1m";

type Json = Record<string, unknown>;

/** One entry of a rule's `data` in the file. */
export interface ProvisionedAlertQuery {
  refId: string;
  queryType?: string;
  relativeTimeRange?: { from: number; to: number };
  datasourceUid: string;
  model: Json;
}

export interface ProvisionedAlertRule {
  uid: string;
  title: string;
  condition?: string;
  data: ProvisionedAlertQuery[];
  dashboardUid?: string;
  panelId?: number;
  noDataState?: string;
  execErrState?: string;
  for?: string;
  keepFiringFor?: string;
  missing_series_evals_to_resolve?: number;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  isPaused?: boolean;
  notification_settings?: Json;
  record?: Json;
}

export interface ProvisionedRuleGroup {
  orgId?: number;
  name: string;
  folder: string;
  interval: string;
  rules: ProvisionedAlertRule[];
}

export interface ProvisionedContactPoint {
  orgId?: number;
  name: string;
  receivers: Array<{ uid: string; type: string; settings: Json; disableResolveMessage?: boolean }>;
}

export interface ProvisionedMuteTiming {
  orgId?: number;
  name: string;
  time_intervals: Json[];
}

export interface ProvisionedTemplate {
  orgId?: number;
  name: string;
  template: string;
}

/** The alerting provisioning file, parsed. */
export interface AlertingFile {
  apiVersion: 1;
  groups?: ProvisionedRuleGroup[];
  contactPoints?: ProvisionedContactPoint[];
  policies?: Json[];
  muteTimes?: ProvisionedMuteTiming[];
  templates?: ProvisionedTemplate[];
}

/** The keys an alerting provisioning file can hold, from `AlertingFileV1`. */
export const ALERTING_FILE_KEYS = [
  "apiVersion",
  "groups",
  "deleteRules",
  "contactPoints",
  "deleteContactPoints",
  "policies",
  "resetPolicies",
  "muteTimes",
  "deleteMuteTimes",
  "templates",
  "deleteTemplates",
] as const;

// ── Durations ───────────────────────────────────────────────────

/** A duration as whole seconds: a number is taken as seconds, a string as a Prometheus duration. */
export function durationSeconds(value: AlertDuration, what: string): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) throw new Error(`grafana: ${what} must be a whole number of seconds, got ${value}`);
    return value;
  }
  if (!isValidDuration(value)) throw new Error(`grafana: ${what} "${value}" is not a duration like 10m or 1h`);
  return Math.floor(durationMs(value)! / 1000);
}

function timeRange(range: RelativeTimeRange, what: string): { from: number; to: number } {
  return { from: durationSeconds(range.from, `${what} from`), to: durationSeconds(range.to ?? 0, `${what} to`) };
}

// ── References ──────────────────────────────────────────────────

function receiverName(receiver: ContactPointEntity | string): string {
  return typeof receiver === "string" ? receiver : receiver.props.name;
}

function timingNames(list: Array<MuteTimingEntity | string> | undefined): string[] | undefined {
  return list?.map((t) => (typeof t === "string" ? t : t.props.name));
}

// ── Rules ───────────────────────────────────────────────────────

const REF_IDS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function refIdAt(i: number): string {
  return i < REF_IDS.length ? REF_IDS[i] : `${REF_IDS[Math.floor(i / REF_IDS.length) - 1]}${REF_IDS[i % REF_IDS.length]}`;
}

/** The uid a query's datasource resolves to, and its type when known. */
function datasourceOf(input: unknown, where: string): { uid: string; type?: string } {
  if (input === undefined || input === null) throw new Error(`grafana: ${where} has no datasource; an alert query must name one`);
  if (typeof input === "string") return { uid: input };
  if (isDatasourceVariable(input)) {
    throw new Error(`grafana: ${where} uses a DatasourceVariable; alert rules are evaluated without dashboard variables, so name the datasource itself`);
  }
  const ref = datasourceRef(input as Parameters<typeof datasourceRef>[0])!;
  return { uid: ref.uid!, ...(ref.type ? { type: ref.type } : {}) };
}

function typedQueryModel(query: QueryEntity, refId: string, where: string): { uid: string; model: Json } {
  const ds = datasourceOf((query.props as Json).datasource, where);
  const model = targetJson(query, 0, ds.type ? { type: ds.type, uid: ds.uid } : undefined);
  return { uid: ds.uid, model: { ...model, refId } };
}

/** One entry of `data`, as the file holds it. */
export function alertQueryJson(item: AlertRuleData, index: number, ruleRange: RelativeTimeRange | undefined, rule: string): ProvisionedAlertQuery {
  const where = `alert rule "${rule}" data[${index}]`;
  const fallbackRange = ruleRange ? timeRange(ruleRange, `${where} relativeTimeRange`) : { ...DEFAULT_RELATIVE_TIME_RANGE };
  if (isExpressionEntity(item)) {
    const { refId: ownRefId, relativeTimeRange, ...rest } = item.props as Json & { refId?: string; relativeTimeRange?: RelativeTimeRange };
    const refId = ownRefId ?? refIdAt(index);
    return compact({
      refId,
      relativeTimeRange: relativeTimeRange ? timeRange(relativeTimeRange, `${where} relativeTimeRange`) : undefined,
      datasourceUid: EXPRESSION_DATASOURCE_UID,
      model: { datasource: { type: EXPRESSION_DATASOURCE_UID, uid: EXPRESSION_DATASOURCE_UID }, refId, type: item.expressionKind, ...rest },
    });
  }
  if (isAlertQueryEntity(item)) {
    const p = item.props;
    const refId = p.refId ?? refIdAt(index);
    const range = p.relativeTimeRange ? timeRange(p.relativeTimeRange, `${where} relativeTimeRange`) : fallbackRange;
    let uid: string;
    let model: Json;
    if (p.query) {
      const typed = typedQueryModel(p.query, refId, where);
      const own = p.datasource !== undefined ? datasourceOf(p.datasource, where) : undefined;
      uid = own?.uid ?? typed.uid;
      model = { ...typed.model, ...(p.model ?? {}) };
    } else {
      uid = datasourceOf(p.datasource, where).uid;
      model = p.model ?? {};
    }
    return compact({ refId, queryType: p.queryType, relativeTimeRange: range, datasourceUid: uid, model });
  }
  if (isQueryEntity(item)) {
    const refId = ((item.props as Json).refId as string | undefined) ?? refIdAt(index);
    const typed = typedQueryModel(item, refId, where);
    return { refId, relativeTimeRange: fallbackRange, datasourceUid: typed.uid, model: typed.model };
  }
  throw new Error(`grafana: ${where} must be a query (PromQuery, AlertQuery, ...) or an expression (ReduceExpression, ...)`);
}

/** One rule as the file holds it. */
export function alertRuleJson(rule: AlertRuleEntity): ProvisionedAlertRule {
  const p = rule.props;
  const data = (p.data ?? []).map((d, i) => alertQueryJson(d, i, p.relativeTimeRange, p.title));
  const condition = p.condition ?? (p.record ? undefined : data[data.length - 1]?.refId);
  const dashboardUid = p.dashboardUid === undefined ? undefined : isDashboardEntity(p.dashboardUid) ? (p.dashboardUid.props.uid ?? slugUid(p.dashboardUid.props.title)) : p.dashboardUid;
  const ns = p.notification_settings;
  return compact({
    uid: p.uid ?? slugUid(p.title),
    title: p.title,
    condition,
    data,
    dashboardUid,
    panelId: p.panelId,
    noDataState: p.noDataState,
    execErrState: p.execErrState,
    for: p.for,
    keepFiringFor: p.keepFiringFor,
    missing_series_evals_to_resolve: p.missing_series_evals_to_resolve,
    annotations: p.annotations,
    labels: p.labels,
    isPaused: p.isPaused,
    notification_settings: ns
      ? {
          receiver: receiverName(ns.receiver),
          group_by: ns.group_by,
          group_wait: ns.group_wait,
          group_interval: ns.group_interval,
          repeat_interval: ns.repeat_interval,
          mute_time_intervals: timingNames(ns.mute_time_intervals),
          active_time_intervals: timingNames(ns.active_time_intervals),
        }
      : undefined,
    record: p.record ? { ...p.record } : undefined,
  });
}

/** One rule group as the file holds it. */
export function ruleGroupJson(group: AlertRuleGroupEntity): ProvisionedRuleGroup {
  const p = group.props;
  return compact({
    orgId: p.orgId,
    name: p.name,
    folder: p.folder,
    interval: p.interval ?? DEFAULT_GROUP_INTERVAL,
    rules: (p.rules ?? []).map(alertRuleJson),
  });
}

// ── Notifications ───────────────────────────────────────────────

/** One contact point as the file holds it. A receiver without a uid gets one from the name and the integration type. */
export function contactPointJson(cp: ContactPointEntity): ProvisionedContactPoint {
  const p = cp.props;
  const taken = new Set<string>();
  const receivers = (p.receivers ?? []).map((r) => {
    let uid = r.uid ?? slugUid(`${p.name} ${r.type}`);
    if (r.uid === undefined) for (let n = 2; taken.has(uid); n++) uid = slugUid(`${p.name} ${r.type} ${n}`);
    taken.add(uid);
    return compact({ uid, type: r.type, settings: (r.settings ?? {}) as Json, disableResolveMessage: r.disableResolveMessage });
  });
  return compact({ orgId: p.orgId, name: p.name, receivers });
}

function routeJson(route: PolicyRoute): Json {
  return compact({
    receiver: route.receiver === undefined ? undefined : receiverName(route.receiver),
    group_by: route.group_by,
    object_matchers: route.object_matchers?.map((m) => [...m]),
    matchers: route.matchers,
    match: route.match,
    match_re: route.match_re,
    continue: route.continue,
    group_wait: route.group_wait,
    group_interval: route.group_interval,
    repeat_interval: route.repeat_interval,
    mute_time_intervals: timingNames(route.mute_time_intervals),
    active_time_intervals: timingNames(route.active_time_intervals),
    routes: route.routes?.map(routeJson),
  });
}

/** One organisation's policy tree as the file holds it. */
export function notificationPolicyJson(policy: NotificationPolicyEntity): Json {
  const p = policy.props;
  return compact({
    orgId: p.orgId,
    receiver: receiverName(p.receiver),
    group_by: p.group_by,
    group_wait: p.group_wait,
    group_interval: p.group_interval,
    repeat_interval: p.repeat_interval,
    mute_time_intervals: timingNames(p.mute_time_intervals),
    active_time_intervals: timingNames(p.active_time_intervals),
    routes: p.routes?.map(routeJson),
  });
}

export function muteTimingJson(t: MuteTimingEntity): ProvisionedMuteTiming {
  return compact({ orgId: t.props.orgId, name: t.props.name, time_intervals: (t.props.time_intervals ?? []) as unknown as Json[] });
}

export function notificationTemplateJson(t: NotificationTemplateEntity): ProvisionedTemplate {
  return compact({ orgId: t.props.orgId, name: t.props.name, template: t.props.template });
}

// ── The file ────────────────────────────────────────────────────

/** The alerting provisioning file as YAML text. */
export function alertingYaml(file: AlertingFile): string {
  return `# Grafana alerting provisioning, generated by chant.\n${dump(file, { lineWidth: -1, noRefs: true, quotingType: '"' })}`;
}

/** Summary of the alerting a build provisions, for the build index. */
export interface AlertingIndex {
  ruleGroups: Array<{ name: string; folder: string; rules: number }>;
  contactPoints: string[];
  policies: number;
  muteTimings: string[];
  templates: string[];
}

/** The alerting provisioning file for the alerting entities among these, or undefined when there are none. */
export function buildAlerting(entities: Iterable<Declarable>): { file: AlertingFile; index: AlertingIndex } | undefined {
  const all = [...entities];
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
  const groups = all
    .filter(isAlertRuleGroupEntity)
    .map(ruleGroupJson)
    .sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
  const contactPoints = all.filter(isContactPointEntity).map(contactPointJson).sort(byName);
  const policies = all.filter(isNotificationPolicyEntity).map(notificationPolicyJson);
  const muteTimes = all.filter(isMuteTimingEntity).map(muteTimingJson).sort(byName);
  const templates = all.filter(isNotificationTemplateEntity).map(notificationTemplateJson).sort(byName);
  if (groups.length + contactPoints.length + policies.length + muteTimes.length + templates.length === 0) return undefined;
  const file: AlertingFile = compact({
    apiVersion: 1 as const,
    groups: groups.length > 0 ? groups : undefined,
    contactPoints: contactPoints.length > 0 ? contactPoints : undefined,
    policies: policies.length > 0 ? policies : undefined,
    muteTimes: muteTimes.length > 0 ? muteTimes : undefined,
    templates: templates.length > 0 ? templates : undefined,
  });
  const index: AlertingIndex = {
    ruleGroups: groups.map((g) => ({ name: g.name, folder: g.folder, rules: g.rules.length })),
    contactPoints: contactPoints.map((c) => c.name),
    policies: policies.length,
    muteTimings: muteTimes.map((m) => m.name),
    templates: templates.map((t) => t.name),
  };
  return { file, index };
}
