/**
 * Grafana-managed alerting: rule groups, their rules, queries and
 * server-side expressions, contact points, the notification policy tree,
 * mute timings and notification templates.
 *
 * Everything here is written to Grafana's alerting file provisioning
 * format, `provisioning/alerting/chant.yaml` (see `alerting-build.ts`). The
 * shapes follow the file format as Grafana reads it
 * (`pkg/services/provisioning/alerting/*_types.go`, identical at v12.4.11
 * and v13.2.2), so a key here is the key in the file. Server-side
 * expressions are typed from the vendored `expr` schema (see `src/pin.ts`).
 *
 * Resources: `AlertRuleGroup`, `ContactPoint`, `NotificationPolicy`,
 * `MuteTiming`, `NotificationTemplate`. Property-kind (they live inside a
 * rule group): `AlertRule`, `AlertQuery` and the expression classes.
 */

import { createProperty, createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type { TimePeriodConfig } from "@intentius/chant-lexicon-prometheus/model";
import type { MatchOp } from "@intentius/chant-lexicon-prometheus/matchers";
import type { DatasourceInput, QueryEntity } from "./query";
import type { DashboardEntity } from "./dashboard";
import type { ContactPointSettingsByType } from "./contact-point-settings.gen";
import type { TypeClassicConditions, TypeMath, TypeReduce, TypeResample, TypeSql, TypeThreshold } from "./schema/expr.gen";

/** The datasource uid Grafana gives server-side expressions. */
export const EXPRESSION_DATASOURCE_UID = "__expr__";

/** A Prometheus-style duration (`30s`, `5m`, `1h`), or a number of seconds. */
export type AlertDuration = string | number;

// ── Queries and expressions ─────────────────────────────────────

/** How far back a query reads, relative to the evaluation time. */
export interface RelativeTimeRange {
  /** How far back the range starts, e.g. `10m` or `600` (seconds). */
  from: AlertDuration;
  /** How far back it ends. Defaults to 0: the evaluation time. */
  to?: AlertDuration;
}

export interface AlertQueryProps {
  /**
   * The datasource the query runs on: a `Datasource`, an `ExternalDatasource`,
   * a `{ type, uid }` ref, or a bare uid string when its plugin type is not
   * known (the checks cannot tell what it is then).
   */
  datasource?: DatasourceInput | string;
  /** A typed query (`PromQuery`, `LokiQuery`, ...) whose model and datasource are used. Set this or `model`. */
  query?: QueryEntity;
  /** The query model exactly as Grafana stores it. Written as it is. */
  model?: Record<string, unknown>;
  /** Defaults to the query's position in `data`: A, B, C, ... */
  refId?: string;
  queryType?: string;
  /** Defaults to the rule's `relativeTimeRange`. */
  relativeTimeRange?: RelativeTimeRange;
}

export interface AlertQueryEntity extends Declarable {
  readonly props: AlertQueryProps;
}

export const ALERT_QUERY_TYPE = "Grafana::AlertQuery";

const AlertQueryBase = createProperty(ALERT_QUERY_TYPE, "grafana") as unknown as (this: object, props: Record<string, unknown>) => void;

/**
 * One datasource query of an alert rule. A typed query (`PromQuery`) can go
 * straight into a rule's `data`; `AlertQuery` is for a query model of any
 * plugin, or to give a typed query its own time range or refId.
 */
export const AlertQuery = function (this: object, props: AlertQueryProps) {
  AlertQueryBase.call(this, props as unknown as Record<string, unknown>);
} as unknown as new (props: AlertQueryProps) => AlertQueryEntity;
Object.defineProperty(AlertQuery, "name", { value: "AlertQuery" });

export function isAlertQueryEntity(value: unknown): value is AlertQueryEntity {
  return typeof value === "object" && value !== null && (value as Declarable).entityType === ALERT_QUERY_TYPE && (value as Declarable).lexicon === "grafana";
}

/** Fields of an expression model the builder writes itself. */
type Managed = "type" | "datasource" | "refId";

/** Every expression takes its refId (defaulting to its position) and an optional time range. */
interface ExpressionCommon {
  refId?: string;
  relativeTimeRange?: RelativeTimeRange;
}

export type ReduceExpressionProps = Omit<TypeReduce, Managed> & ExpressionCommon;
export type MathExpressionProps = Omit<TypeMath, Managed> & ExpressionCommon;
export type ThresholdExpressionProps = Omit<TypeThreshold, Managed> & ExpressionCommon;
export type ResampleExpressionProps = Omit<TypeResample, Managed> & ExpressionCommon;
export type ClassicConditionsExpressionProps = Omit<TypeClassicConditions, Managed> & ExpressionCommon;
export type SqlExpressionProps = Omit<TypeSql, Managed> & ExpressionCommon;

export type ExpressionKind = "reduce" | "math" | "threshold" | "resample" | "classic_conditions" | "sql";

export const EXPRESSION_TYPE_PREFIX = "Grafana::Expression::";

export interface ExpressionEntity<P = Record<string, unknown>> extends Declarable {
  readonly props: P;
  /** The expression's `type` in the model. */
  readonly expressionKind: ExpressionKind;
}

function expressionClass<P>(kind: ExpressionKind, className: string): new (props: P) => ExpressionEntity<P> {
  const Base = createProperty(`${EXPRESSION_TYPE_PREFIX}${kind}`, "grafana") as unknown as (this: object, props: Record<string, unknown>) => void;
  const Cls = function (this: object, props: P) {
    Base.call(this, props as unknown as Record<string, unknown>);
    Object.defineProperty(this, "expressionKind", { value: kind, enumerable: false });
  };
  Object.defineProperty(Cls, "name", { value: className });
  return Cls as unknown as new (props: P) => ExpressionEntity<P>;
}

/** Reduce a series to one number per series: `expression` is a refId (`A` or `$A`). */
export const ReduceExpression = expressionClass<ReduceExpressionProps>("reduce", "ReduceExpression");
/** Arithmetic and logic over results by refId: `$A / $B`, `$A > 0.05 && $B > 0.05`. */
export const MathExpression = expressionClass<MathExpressionProps>("math", "MathExpression");
/** Compare a result with a threshold; an `unloadEvaluator` adds a recovery threshold. */
export const ThresholdExpression = expressionClass<ThresholdExpressionProps>("threshold", "ThresholdExpression");
/** Resample a time series to a fixed `window`. */
export const ResampleExpression = expressionClass<ResampleExpressionProps>("resample", "ResampleExpression");
/** Grafana's legacy classic conditions: reducers, evaluators and and/or across queries. */
export const ClassicConditionsExpression = expressionClass<ClassicConditionsExpressionProps>("classic_conditions", "ClassicConditionsExpression");
/** A SQL query over the other results (Grafana's SQL expressions). */
export const SqlExpression = expressionClass<SqlExpressionProps>("sql", "SqlExpression");

export function isExpressionEntity(value: unknown): value is ExpressionEntity {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Declarable).lexicon === "grafana" &&
    typeof (value as Declarable).entityType === "string" &&
    (value as Declarable).entityType.startsWith(EXPRESSION_TYPE_PREFIX)
  );
}

/** One entry of a rule's `data`: a typed query, an `AlertQuery`, or an expression. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AlertRuleData = QueryEntity<any, any> | AlertQueryEntity | ExpressionEntity<any>;

// ── Rules and groups ────────────────────────────────────────────

export type NoDataState = "NoData" | "Alerting" | "OK" | "KeepLast";
export type ExecErrState = "Error" | "Alerting" | "OK" | "KeepLast";

/** Per-rule routing: send this rule's alerts to a contact point directly, instead of through the policy tree. */
export interface AlertRuleNotificationSettings {
  receiver: ContactPointEntity | string;
  group_by?: string[];
  group_wait?: string;
  group_interval?: string;
  repeat_interval?: string;
  mute_time_intervals?: Array<MuteTimingEntity | string>;
  active_time_intervals?: Array<MuteTimingEntity | string>;
}

/** What makes a rule a recording rule: the metric it writes and the refId it writes from. */
export interface AlertRuleRecord {
  metric: string;
  /** The refId whose result is recorded. */
  from: string;
  /** Where the metric is written (a Prometheus datasource with remote write). */
  targetDatasourceUid?: string;
}

export interface AlertRuleProps {
  title: string;
  /**
   * Stable id: letters, digits, `-` and `_`, at most 40 characters. Grafana
   * refuses a rule without one. Defaults to the title as a uid.
   */
  uid?: string;
  /** Queries and expressions, in the order Grafana evaluates them. */
  data: AlertRuleData[];
  /** The refId whose result decides whether the rule fires. Defaults to the last entry of `data`. Recording rules have none. */
  condition?: string;
  /** Default time range of every query in `data` that sets none. Defaults to the last 10 minutes, as Grafana's editor does. */
  relativeTimeRange?: RelativeTimeRange;
  /** How long the condition must hold before the alert fires. */
  for?: string;
  /** How long the alert keeps firing after the condition stops holding. */
  keepFiringFor?: string;
  /** What a query with no data does (Grafana's default: `NoData`). */
  noDataState?: NoDataState;
  /** What a query error does (Grafana's default: `Error`). */
  execErrState?: ExecErrState;
  /** Evaluations a series may be missing before its alert resolves. */
  missing_series_evals_to_resolve?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  isPaused?: boolean;
  /** The dashboard (and `panelId`) the rule is linked to. */
  dashboardUid?: DashboardEntity | string;
  panelId?: number;
  notification_settings?: AlertRuleNotificationSettings;
  record?: AlertRuleRecord;
}

export interface AlertRuleEntity extends Declarable {
  readonly props: AlertRuleProps;
}

export const ALERT_RULE_TYPE = "Grafana::AlertRule";

const AlertRuleBase = createProperty(ALERT_RULE_TYPE, "grafana") as unknown as (this: object, props: Record<string, unknown>) => void;

/** A Grafana-managed alert or recording rule, inside an `AlertRuleGroup`. */
export const AlertRule = function (this: object, props: AlertRuleProps) {
  AlertRuleBase.call(this, props as unknown as Record<string, unknown>);
} as unknown as new (props: AlertRuleProps) => AlertRuleEntity;
Object.defineProperty(AlertRule, "name", { value: "AlertRule" });

export function isAlertRuleEntity(value: unknown): value is AlertRuleEntity {
  return typeof value === "object" && value !== null && (value as Declarable).entityType === ALERT_RULE_TYPE && (value as Declarable).lexicon === "grafana";
}

export interface AlertRuleGroupProps {
  /** The group's name, unique within its folder. */
  name: string;
  /** The folder the rules are stored in, by title; Grafana creates it when missing. */
  folder: string;
  /** How often every rule in the group is evaluated, a multiple of 10s. Defaults to `1m`. */
  interval?: string;
  orgId?: number;
  rules: AlertRuleEntity[];
}

export interface AlertRuleGroupEntity extends Declarable {
  readonly props: AlertRuleGroupProps;
}

export const ALERT_RULE_GROUP_TYPE = "Grafana::AlertRuleGroup";

const GroupBase = createResource(ALERT_RULE_GROUP_TYPE, "grafana", {}) as unknown as (this: object, props: Record<string, unknown>) => void;

/** A group of Grafana-managed rules, evaluated together at one interval. */
export const AlertRuleGroup = function (this: object, props: AlertRuleGroupProps) {
  GroupBase.call(this, props as unknown as Record<string, unknown>);
} as unknown as new (props: AlertRuleGroupProps) => AlertRuleGroupEntity;
Object.defineProperty(AlertRuleGroup, "name", { value: "AlertRuleGroup" });

export function isAlertRuleGroupEntity(value: unknown): value is AlertRuleGroupEntity {
  return typeof value === "object" && value !== null && (value as Declarable).entityType === ALERT_RULE_GROUP_TYPE && (value as Declarable).lexicon === "grafana";
}

// ── Contact points ──────────────────────────────────────────────

/** The integrations Grafana 12.4 and 13.2 offer (`GET /api/alert-notifiers`). Any other plugin id is accepted as a string. */
export type ContactPointIntegrationType = keyof ContactPointSettingsByType;

/** One integration of a contact point. */
export interface ContactPointReceiverBase {
  /** Stable id, at most 40 characters. Defaults to the contact point's name and the integration type as a uid. */
  uid?: string;
  disableResolveMessage?: boolean;
}

/**
 * A receiver of one of the 24 integrations Grafana lists, its `settings`
 * typed from `GET /api/alert-notifiers`. Write secrets (webhook URLs,
 * tokens, passwords) as `$__env{NAME}` or `$__file{/path}`: Grafana expands
 * them when it reads the file, and GRAF002 flags a literal. GRAF114 reports
 * a setting the integration does not take and a missing required one.
 */
export type KnownContactPointReceiver = {
  [K in ContactPointIntegrationType]: ContactPointReceiverBase & { type: K; settings: ContactPointSettingsByType[K] };
}[ContactPointIntegrationType];

/** An integration this lexicon has no settings type for (a plugin id, or one a newer Grafana added). Its settings are not checked. */
export interface OtherContactPointReceiver extends ContactPointReceiverBase {
  // eslint-disable-next-line @typescript-eslint/ban-types
  type: string & {};
  settings: Record<string, unknown>;
}

export type ContactPointReceiver = KnownContactPointReceiver | OtherContactPointReceiver;

export interface ContactPointProps {
  /** The name policies and rules route to. */
  name: string;
  orgId?: number;
  receivers: ContactPointReceiver[];
}

export interface ContactPointEntity extends Declarable {
  readonly props: ContactPointProps;
}

export const CONTACT_POINT_TYPE = "Grafana::ContactPoint";

const ContactPointBase = createResource(CONTACT_POINT_TYPE, "grafana", {}) as unknown as (this: object, props: Record<string, unknown>) => void;

/** A contact point: one or more integrations alerts are sent to, under one name. */
export const ContactPoint = function (this: object, props: ContactPointProps) {
  ContactPointBase.call(this, props as unknown as Record<string, unknown>);
} as unknown as new (props: ContactPointProps) => ContactPointEntity;
Object.defineProperty(ContactPoint, "name", { value: "ContactPoint" });

export function isContactPointEntity(value: unknown): value is ContactPointEntity {
  return typeof value === "object" && value !== null && (value as Declarable).entityType === CONTACT_POINT_TYPE && (value as Declarable).lexicon === "grafana";
}

// ── Mute timings and templates ──────────────────────────────────

export interface MuteTimingProps {
  /** The name policies and rules refer to. */
  name: string;
  orgId?: number;
  /** When it applies: each period's fields left out match everything. */
  time_intervals: TimePeriodConfig[];
}

export interface MuteTimingEntity extends Declarable {
  readonly props: MuteTimingProps;
}

export const MUTE_TIMING_TYPE = "Grafana::MuteTiming";

const MuteTimingBase = createResource(MUTE_TIMING_TYPE, "grafana", {}) as unknown as (this: object, props: Record<string, unknown>) => void;

/** A named time interval, for a policy's or rule's `mute_time_intervals` or `active_time_intervals`. */
export const MuteTiming = function (this: object, props: MuteTimingProps) {
  MuteTimingBase.call(this, props as unknown as Record<string, unknown>);
} as unknown as new (props: MuteTimingProps) => MuteTimingEntity;
Object.defineProperty(MuteTiming, "name", { value: "MuteTiming" });

export function isMuteTimingEntity(value: unknown): value is MuteTimingEntity {
  return typeof value === "object" && value !== null && (value as Declarable).entityType === MUTE_TIMING_TYPE && (value as Declarable).lexicon === "grafana";
}

export interface NotificationTemplateProps {
  /** The template group's name. */
  name: string;
  orgId?: number;
  /** Go template text, usually one or more `{{ define "..." }}` blocks. */
  template: string;
}

export interface NotificationTemplateEntity extends Declarable {
  readonly props: NotificationTemplateProps;
}

export const NOTIFICATION_TEMPLATE_TYPE = "Grafana::NotificationTemplate";

const TemplateBase = createResource(NOTIFICATION_TEMPLATE_TYPE, "grafana", {}) as unknown as (this: object, props: Record<string, unknown>) => void;

/** A notification template group, usable from contact point settings. */
export const NotificationTemplate = function (this: object, props: NotificationTemplateProps) {
  TemplateBase.call(this, props as unknown as Record<string, unknown>);
} as unknown as new (props: NotificationTemplateProps) => NotificationTemplateEntity;
Object.defineProperty(NotificationTemplate, "name", { value: "NotificationTemplate" });

export function isNotificationTemplateEntity(value: unknown): value is NotificationTemplateEntity {
  return (
    typeof value === "object" && value !== null && (value as Declarable).entityType === NOTIFICATION_TEMPLATE_TYPE && (value as Declarable).lexicon === "grafana"
  );
}

// ── Notification policies ───────────────────────────────────────

/** A label matcher as Grafana stores it: `["severity", "=", "page"]`. */
export type ObjectMatcher = [string, MatchOp, string];

/** Routing settings shared by the root policy and its child routes. */
interface PolicySettings {
  /** Group alerts by these labels; `["..."]` groups by every label. */
  group_by?: string[];
  group_wait?: string;
  group_interval?: string;
  repeat_interval?: string;
  mute_time_intervals?: Array<MuteTimingEntity | string>;
  active_time_intervals?: Array<MuteTimingEntity | string>;
  routes?: PolicyRoute[];
}

/** A child route of the policy tree. */
export interface PolicyRoute extends PolicySettings {
  /** Defaults to the parent's receiver. */
  receiver?: ContactPointEntity | string;
  /** Matchers as `[label, op, value]`, the form Grafana writes. */
  object_matchers?: ObjectMatcher[];
  /** Matchers in Alertmanager's syntax, e.g. `severity="page"`. */
  matchers?: string[];
  /** @deprecated Alertmanager's old equality matchers; use `object_matchers`. */
  match?: Record<string, string>;
  /** @deprecated Alertmanager's old regex matchers; use `object_matchers`. */
  match_re?: Record<string, string>;
  /** Keep matching sibling routes after this one matches. */
  continue?: boolean;
}

export interface NotificationPolicyProps extends PolicySettings {
  orgId?: number;
  /** The contact point every alert goes to unless a route sends it elsewhere. */
  receiver: ContactPointEntity | string;
}

export interface NotificationPolicyEntity extends Declarable {
  readonly props: NotificationPolicyProps;
}

export const NOTIFICATION_POLICY_TYPE = "Grafana::NotificationPolicy";

const PolicyBase = createResource(NOTIFICATION_POLICY_TYPE, "grafana", {}) as unknown as (this: object, props: Record<string, unknown>) => void;

/**
 * An organisation's notification policy tree, from its root. Provisioning it
 * replaces the whole tree, so there is one per organisation.
 */
export const NotificationPolicy = function (this: object, props: NotificationPolicyProps) {
  PolicyBase.call(this, props as unknown as Record<string, unknown>);
} as unknown as new (props: NotificationPolicyProps) => NotificationPolicyEntity;
Object.defineProperty(NotificationPolicy, "name", { value: "NotificationPolicy" });

export function isNotificationPolicyEntity(value: unknown): value is NotificationPolicyEntity {
  return (
    typeof value === "object" && value !== null && (value as Declarable).entityType === NOTIFICATION_POLICY_TYPE && (value as Declarable).lexicon === "grafana"
  );
}
