/**
 * Alertmanager entities: `Route`, `Receiver`, `InhibitRule`, `TimeInterval`
 * and `AlertmanagerSettings`, which together serialize to `alertmanager.yml`.
 *
 * A route names its receiver and its time intervals either by the declared
 * entity, which keeps the reference checked by TypeScript, or by name string
 * for one declared somewhere chant can't see. PROM201 and PROM204 catch a
 * string that names nothing declared.
 *
 * The routing tree is built from `Route`s: the root is the one route no other
 * route lists as a child. Child routes may be `Route` entities or plain
 * objects.
 */

import { createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type {
  AlertmanagerGlobalConfig,
  AlertmanagerTracingConfig,
  InhibitRuleConfig,
  ReceiverConfig,
  RouteConfig,
  TimeIntervalConfig,
} from "./model";

export const RECEIVER_TYPE = "Prometheus::Alertmanager::Receiver";
export const ROUTE_TYPE = "Prometheus::Alertmanager::Route";
export const INHIBIT_RULE_TYPE = "Prometheus::Alertmanager::InhibitRule";
export const TIME_INTERVAL_TYPE = "Prometheus::Alertmanager::TimeInterval";
export const SETTINGS_TYPE = "Prometheus::Alertmanager::Settings";

type Ctor<P, E> = new (props: P) => E;

function entityClass<P, E>(entityType: string, className: string, extra?: (self: object, props: P) => void): Ctor<P, E> {
  const Base = createResource(entityType, "prometheus", {}) as unknown as (this: object, props: Record<string, unknown>) => void;
  const Cls = function (this: object, props: P) {
    Base.call(this, (props ?? {}) as unknown as Record<string, unknown>);
    extra?.(this, props);
  };
  Object.defineProperty(Cls, "name", { value: className });
  return Cls as unknown as Ctor<P, E>;
}

// ── Receiver ────────────────────────────────────────────────────────

export type ReceiverProps = ReceiverConfig;

export interface ReceiverEntity extends Declarable {
  readonly props: ReceiverProps;
  readonly receiverName: string;
}

/**
 * A notification receiver: webhook, email, Slack and PagerDuty integrations.
 *
 * Credentials (Slack `api_url`, PagerDuty `routing_key`, SMTP passwords)
 * belong in the `*_file` fields; Alertmanager does not expand environment
 * variables in its config, and PROM001 flags a literal.
 */
export const Receiver = entityClass<ReceiverProps, ReceiverEntity>(RECEIVER_TYPE, "Receiver", (self, props) => {
  Object.defineProperty(self, "receiverName", { value: props?.name, enumerable: false });
});

// ── TimeInterval ────────────────────────────────────────────────────

export type TimeIntervalProps = TimeIntervalConfig;

export interface TimeIntervalEntity extends Declarable {
  readonly props: TimeIntervalProps;
  readonly intervalName: string;
}

/** A named set of time periods a route can mute or activate on. */
export const TimeInterval = entityClass<TimeIntervalProps, TimeIntervalEntity>(TIME_INTERVAL_TYPE, "TimeInterval", (self, props) => {
  Object.defineProperty(self, "intervalName", { value: props?.name, enumerable: false });
});

// ── Route ───────────────────────────────────────────────────────────

export type ReceiverRef = ReceiverEntity | string;
export type TimeIntervalRef = TimeIntervalEntity | string;

export interface RouteProps extends Omit<RouteConfig, "receiver" | "routes" | "mute_time_intervals" | "active_time_intervals"> {
  /** The receiver alerts matching this route go to. Required on the root route. */
  receiver?: ReceiverRef;
  /** Child routes, tried in order. */
  routes?: Array<RouteEntity | RouteProps>;
  mute_time_intervals?: TimeIntervalRef[];
  active_time_intervals?: TimeIntervalRef[];
}

export interface RouteEntity extends Declarable {
  readonly props: RouteProps;
}

/** A node in the routing tree. Declare one root route; nest the rest under `routes`. */
export const Route = entityClass<RouteProps, RouteEntity>(ROUTE_TYPE, "Route");

// ── InhibitRule ─────────────────────────────────────────────────────

export type InhibitRuleProps = InhibitRuleConfig;

export interface InhibitRuleEntity extends Declarable {
  readonly props: InhibitRuleProps;
}

/** Mutes alerts matching `target_matchers` while an alert matching `source_matchers` fires. */
export const InhibitRule = entityClass<InhibitRuleProps, InhibitRuleEntity>(INHIBIT_RULE_TYPE, "InhibitRule");

// ── AlertmanagerSettings ────────────────────────────────────────────

export interface AlertmanagerSettingsProps {
  global?: AlertmanagerGlobalConfig;
  /** Paths of notification template files. */
  templates?: string[];
  /** Where Alertmanager sends its own traces. */
  tracing?: AlertmanagerTracingConfig;
}

export interface AlertmanagerSettingsEntity extends Declarable {
  readonly props: AlertmanagerSettingsProps;
}

/** The `global:` block, `templates:` list and `tracing:` block. Optional; declare at most one. */
export const AlertmanagerSettings = entityClass<AlertmanagerSettingsProps, AlertmanagerSettingsEntity>(
  SETTINGS_TYPE,
  "AlertmanagerSettings",
);

// ── Guards ──────────────────────────────────────────────────────────

function isType<T>(type: string) {
  return (value: unknown): value is T =>
    typeof value === "object" && value !== null && (value as Declarable).entityType === type;
}

export const isReceiver = isType<ReceiverEntity>(RECEIVER_TYPE);
export const isRoute = isType<RouteEntity>(ROUTE_TYPE);
export const isInhibitRule = isType<InhibitRuleEntity>(INHIBIT_RULE_TYPE);
export const isTimeInterval = isType<TimeIntervalEntity>(TIME_INTERVAL_TYPE);
export const isAlertmanagerSettings = isType<AlertmanagerSettingsEntity>(SETTINGS_TYPE);

/** True for any of the Alertmanager entity kinds. */
export function isAlertmanagerEntity(value: unknown): boolean {
  return isReceiver(value) || isRoute(value) || isInhibitRule(value) || isTimeInterval(value) || isAlertmanagerSettings(value);
}
