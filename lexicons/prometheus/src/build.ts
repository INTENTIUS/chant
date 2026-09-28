/**
 * Declared entities -> `RuleFileConfig` / `AlertmanagerConfig` -> YAML.
 *
 * The serializer runs these over a build's entities, and a composite in
 * another lexicon (the k8s `PrometheusRule` path, a ConfigMap holding
 * `alertmanager.yml`) runs them over the entities it has. Both get the same
 * config and the same text.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { dump } from "js-yaml";
import {
  isAlertmanagerSettings,
  isInhibitRule,
  isReceiver,
  isRoute,
  isTimeInterval,
  type AlertmanagerSettingsEntity,
  type ReceiverEntity,
  type RouteEntity,
  type RouteProps,
  type TimeIntervalEntity,
} from "./alertmanager";
import type {
  AlertmanagerConfig,
  InhibitRuleConfig,
  ReceiverConfig,
  RouteConfig,
  RuleFileConfig,
  TimeIntervalConfig,
} from "./model";
import { isRuleGroup, ruleGroupConfig, type RuleGroupEntity } from "./rules";

function byName(a: unknown, b: unknown): number {
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function entityList(entities: Iterable<Declarable> | Map<string, Declarable>): Declarable[] {
  return entities instanceof Map ? [...entities.values()] : [...entities];
}

/** A value with `undefined` keys dropped and entities left as they are. */
function plain(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object" && value !== null) {
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === "function") return plain(toJSON.call(value));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = plain(v);
    }
    return out;
  }
  return value;
}

// ── Rule file ───────────────────────────────────────────────────────

export interface BuiltRuleFile {
  config: RuleFileConfig;
  groups: RuleGroupEntity[];
}

/** The rule file for a set of declared entities. Entities that aren't `RuleGroup`s are ignored. */
export function buildRuleFile(entities: Iterable<Declarable> | Map<string, Declarable>): BuiltRuleFile {
  const groups: RuleGroupEntity[] = [];
  for (const e of entityList(entities)) {
    if (isRuleGroup(e) && !groups.includes(e)) groups.push(e);
  }
  // Sorted by name: Prometheus evaluates groups independently, so their order
  // carries no meaning, and sorting makes the file the same however the
  // groups were collected (a build's entity map, or a list passed by hand).
  groups.sort((a, b) => byName(a.props.name, b.props.name));
  return { config: { groups: groups.map((g) => ruleGroupConfig(g)) }, groups };
}

// ── alertmanager.yml ────────────────────────────────────────────────

export interface BuiltAlertmanager {
  config: AlertmanagerConfig;
  /** Non-fatal problems, e.g. more than one root route. */
  warnings: string[];
  /** Every Alertmanager entity that took part, including ones reached only by reference. */
  count: number;
}

function receiverName(ref: unknown): string {
  return isReceiver(ref) ? ref.props.name : String(ref);
}

function intervalName(ref: unknown): string {
  return isTimeInterval(ref) ? ref.props.name : String(ref);
}

function routeProps(route: RouteEntity | RouteProps): RouteProps {
  return isRoute(route) ? route.props : route;
}

function routeConfig(route: RouteEntity | RouteProps): RouteConfig {
  const p = routeProps(route);
  const out: RouteConfig = {};
  if (p.receiver !== undefined) out.receiver = receiverName(p.receiver);
  if (p.group_by !== undefined) out.group_by = [...p.group_by];
  if (p.continue !== undefined) out.continue = p.continue;
  if (p.matchers !== undefined) out.matchers = [...p.matchers];
  if (p.group_wait !== undefined) out.group_wait = p.group_wait;
  if (p.group_interval !== undefined) out.group_interval = p.group_interval;
  if (p.repeat_interval !== undefined) out.repeat_interval = p.repeat_interval;
  if (p.mute_time_intervals !== undefined) out.mute_time_intervals = p.mute_time_intervals.map(intervalName);
  if (p.active_time_intervals !== undefined) out.active_time_intervals = p.active_time_intervals.map(intervalName);
  if (p.labels !== undefined) out.labels = { ...p.labels };
  if (p.routes !== undefined) out.routes = p.routes.map(routeConfig);
  return out;
}

/** The `alertmanager.yml` for a set of declared entities. Entities that aren't Alertmanager ones are ignored. */
export function buildAlertmanagerConfig(entities: Iterable<Declarable> | Map<string, Declarable>): BuiltAlertmanager {
  const all = entityList(entities);
  const warnings: string[] = [];
  const receivers: ReceiverEntity[] = [];
  const intervals: TimeIntervalEntity[] = [];
  const routes: RouteEntity[] = [];
  const inhibits: InhibitRuleConfig[] = [];
  let settings: AlertmanagerSettingsEntity | undefined;
  let count = 0;

  const addReceiver = (r: ReceiverEntity) => {
    if (!receivers.includes(r)) receivers.push(r);
  };
  const addInterval = (t: TimeIntervalEntity) => {
    if (!intervals.includes(t)) intervals.push(t);
  };

  for (const e of all) {
    if (isReceiver(e)) addReceiver(e);
    else if (isTimeInterval(e)) addInterval(e);
    else if (isRoute(e)) routes.push(e);
    else if (isInhibitRule(e)) inhibits.push(plain(e.props) as InhibitRuleConfig);
    else if (isAlertmanagerSettings(e)) {
      if (settings) warnings.push("prometheus: more than one AlertmanagerSettings is declared; the first one is used");
      else settings = e;
    } else continue;
    count++;
  }

  // Receivers and time intervals a route references by entity are part of the
  // config even when not declared on their own, and child Route entities are
  // not roots.
  const children = new Set<RouteEntity>();
  const walk = (route: RouteEntity | RouteProps) => {
    const p = routeProps(route);
    if (isReceiver(p.receiver)) addReceiver(p.receiver);
    for (const t of [...(p.mute_time_intervals ?? []), ...(p.active_time_intervals ?? [])]) {
      if (isTimeInterval(t)) addInterval(t);
    }
    for (const child of p.routes ?? []) {
      if (isRoute(child)) children.add(child);
      walk(child);
    }
  };
  for (const r of routes) walk(r);
  const roots = routes.filter((r) => !children.has(r));
  if (roots.length > 1) {
    warnings.push(
      `prometheus: ${roots.length} root Routes are declared; Alertmanager has one routing tree, so the first is used. Nest the others under its routes.`,
    );
  }

  const config: AlertmanagerConfig = {};
  if (settings?.props.global) config.global = plain(settings.props.global) as AlertmanagerConfig["global"];
  if (settings?.props.templates) config.templates = [...settings.props.templates];
  if (roots.length > 0) config.route = routeConfig(roots[0]);
  if (inhibits.length > 0) config.inhibit_rules = inhibits;
  // Receivers and time intervals are looked up by name, so their order carries
  // no meaning; sorted, the file is the same however they were collected.
  receivers.sort((a, b) => byName(a.props.name, b.props.name));
  intervals.sort((a, b) => byName(a.props.name, b.props.name));
  if (receivers.length > 0) config.receivers = receivers.map((r) => plain(r.props) as ReceiverConfig);
  if (intervals.length > 0) config.time_intervals = intervals.map((t) => plain(t.props) as TimeIntervalConfig);
  if (settings?.props.tracing) config.tracing = plain(settings.props.tracing) as AlertmanagerConfig["tracing"];

  return { config, warnings, count };
}

// ── YAML ────────────────────────────────────────────────────────────

/** Print a rule file or Alertmanager config as YAML, keys in the order given. */
export function emitYaml(value: unknown): string {
  return dump(value, { lineWidth: -1, noRefs: true, quotingType: '"', sortKeys: false });
}

/** The rule file YAML for a set of declared entities, exactly as the serializer emits it. */
export function ruleFileYaml(entities: Iterable<Declarable> | Map<string, Declarable>): string {
  return emitYaml(buildRuleFile(entities).config);
}

/** The `alertmanager.yml` text for a set of declared entities, exactly as the serializer emits it. */
export function alertmanagerYaml(entities: Iterable<Declarable> | Map<string, Declarable>): string {
  return emitYaml(buildAlertmanagerConfig(entities).config);
}
