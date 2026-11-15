/**
 * Alertmanager declarations delivered to Kubernetes as the Prometheus
 * Operator's `AlertmanagerConfig` (`monitoring.coreos.com/v1alpha1`), from
 * `@intentius/chant-lexicon-prometheus/k8s` (#5113).
 *
 * `chant import` of an `AlertmanagerConfig` hands `spec.route`,
 * `spec.receivers`, `spec.inhibitRules` and `spec.muteTimeIntervals` to this
 * lexicon, which reads each as typed `Route`, `Receiver`, `InhibitRule` and
 * `TimeInterval` declarations. The functions here are the way back: each
 * takes the declarations and returns the field the CRD holds, so the built
 * object equals the one that was imported.
 *
 * The CRD spells things as the operator does, which is not how
 * `alertmanager.yml` spells them:
 *
 * - names are camel case (`groupBy`, `slackConfigs`, `sendResolved`,
 *   `iconURL`) where Alertmanager's are snake case;
 * - a matcher is `{ name, value, matchType }`, where Alertmanager writes the
 *   string `name="value"` (`matchType` is `=`, `!=`, `=~` or `!~`);
 * - an inhibit rule's `sourceMatch` and `targetMatch` hold those matcher
 *   objects, where Alertmanager's `source_matchers` and `target_matchers`
 *   hold strings;
 * - a time interval's `timeIntervals` entries write `daysOfMonth` as
 *   `{ start, end }` and `times` as `{ startTime, endTime }`.
 *
 * A credential is a Secret reference in the CRD (`apiURL: { name, key }`),
 * which an `alertmanager.yml` has no way to say. The reference is never read:
 * `alertmanagerConfigReceivers` takes it as a second argument, in the CRD's
 * own shape, and puts it back beside the typed fields.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { parseMatchers, type MatchOp } from "./matchers";
import type { ReceiverEntity, RouteEntity, RouteProps, InhibitRuleEntity, TimeIntervalEntity } from "./alertmanager";

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── names ────────────────────────────────────────────────────────────

/** `apiURL` as `api_url`, `forceImplicitTLS` as `force_implicit_tls`, `okText` as `ok_text`. */
export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** The fields of one notifier a CRD entry can say in Alertmanager's own terms: a plain value, or a list or object of them. */
export interface FieldSpec {
  /** CRD field names holding a string, number, boolean or list of strings. */
  readonly plain: readonly string[];
  /** CRD field names holding a list of objects, each described by its own spec. */
  readonly lists?: Readonly<Record<string, FieldSpec>>;
  /** CRD field names holding an object, described by its own spec. */
  readonly objects?: Readonly<Record<string, FieldSpec>>;
}

/**
 * The notifiers whose fields convert, by the CRD's `*Configs` name, and the
 * fields of each that do. Everything else in an entry (a Secret reference,
 * `httpConfig`, a `details` list the CRD writes where Alertmanager has a map)
 * is a field the declaration cannot hold, kept as the CRD wrote it.
 */
export const NOTIFIERS: Readonly<Record<string, FieldSpec>> = {
  slackConfigs: {
    plain: [
      "sendResolved", "callbackId", "channel", "color", "fallback", "footer", "iconEmoji", "iconURL", "imageURL", "linkNames",
      "messageText", "mrkdwnIn", "pretext", "shortFields", "text", "thumbURL", "timeout", "title", "titleLink", "updateMessage", "username",
    ],
    lists: {
      fields: { plain: ["title", "value", "short"] },
      actions: {
        plain: ["type", "text", "url", "style", "name", "value"],
        objects: { confirm: { plain: ["text", "title", "okText", "dismissText"] } },
      },
    },
  },
  webhookConfigs: { plain: ["sendResolved", "maxAlerts", "timeout", "url"] },
  pagerdutyConfigs: {
    plain: ["sendResolved", "class", "client", "clientURL", "component", "description", "group", "severity", "source", "timeout", "url"],
  },
  emailConfigs: {
    plain: ["sendResolved", "authIdentity", "authUsername", "forceImplicitTLS", "from", "hello", "html", "requireTLS", "smarthost", "text", "to"],
  },
  opsgenieConfigs: {
    plain: ["sendResolved", "actions", "apiURL", "description", "entity", "message", "note", "priority", "source", "tags", "updateAlerts"],
    lists: { responders: { plain: ["id", "name", "type", "username"] } },
  },
  pushoverConfigs: {
    plain: [
      "sendResolved", "device", "expire", "html", "message", "monospace", "priority", "retry", "sound", "title", "tokenFile", "ttl", "url",
      "urlTitle", "userKeyFile",
    ],
  },
  telegramConfigs: {
    plain: ["sendResolved", "apiURL", "botTokenFile", "chatID", "disableNotifications", "message", "messageThreadID", "parseMode"],
  },
  webexConfigs: { plain: ["sendResolved", "apiURL", "message", "roomID"] },
  discordConfigs: { plain: ["sendResolved", "avatarURL", "content", "message", "title", "username"] },
};

/** Alertmanager's name for a notifier list: `slackConfigs` is `slack_configs`. */
export function notifierKey(crdKey: string): string {
  return snakeCase(crdKey);
}

/** Every CRD field name a spec mentions, nested ones included, by the Alertmanager name it becomes. */
function reverseNames(spec: FieldSpec, into: Map<string, string> = new Map()): Map<string, string> {
  for (const key of spec.plain) into.set(snakeCase(key), key);
  for (const [key, sub] of Object.entries(spec.lists ?? {})) {
    into.set(snakeCase(key), key);
    reverseNames(sub, into);
  }
  for (const [key, sub] of Object.entries(spec.objects ?? {})) {
    into.set(snakeCase(key), key);
    reverseNames(sub, into);
  }
  return into;
}

const REVERSE: Record<string, Map<string, string>> = Object.fromEntries(
  Object.entries(NOTIFIERS).map(([key, spec]) => [notifierKey(key), reverseNames(spec)]),
);

// ── matchers ─────────────────────────────────────────────────────────

const MATCH_TYPES: readonly string[] = ["=", "!=", "=~", "!~"];

/** The CRD's matcher objects for the matcher strings of a declaration. */
function crdMatchers(entries: readonly unknown[], where: string): Json[] {
  const out: Json[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") throw new Error(`${where}: a matcher is not a string`);
    const parsed = parseMatchers(entry);
    if (!parsed.ok) throw new Error(`${where}: ${parsed.error}`);
    for (const m of parsed.matchers) out.push({ name: m.name, value: m.value, matchType: m.op satisfies MatchOp });
  }
  return out;
}

/** The matcher string for a CRD matcher object, or undefined when it cannot be written as one and read back the same. */
export function matcherString(m: unknown): string | undefined {
  if (!isObject(m)) return undefined;
  if (!Object.keys(m).every((k) => k === "name" || k === "value" || k === "matchType")) return undefined;
  if (typeof m.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.name)) return undefined;
  if (typeof m.value !== "string" || typeof m.matchType !== "string" || !MATCH_TYPES.includes(m.matchType)) return undefined;
  const value = m.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return `${m.name}${m.matchType}"${value}"`;
}

// ── declarations back to the CRD ─────────────────────────────────────

function nameOf(ref: unknown, entityKey: "receiverName" | "intervalName"): string {
  if (typeof ref === "string") return ref;
  const name = isObject(ref) ? (ref as Json)[entityKey] : undefined;
  if (typeof name !== "string") throw new Error(`alertmanager: a ${entityKey === "receiverName" ? "receiver" : "time interval"} reference is neither a name nor a declaration`);
  return name;
}

function propsOf(value: unknown, what: string): Json {
  const props = isObject(value) && isObject((value as unknown as Declarable & { props?: unknown }).props) ? (value as unknown as { props: Json }).props : value;
  if (!isObject(props)) throw new Error(`alertmanager: ${what} is not a declaration or a props object`);
  return props;
}

/** `spec.route`, or one of its children, from a `Route` or its props. */
export function alertmanagerConfigRoute(route: RouteEntity | RouteProps): Json {
  return routeSpec(propsOf(route, "the route"), "route");
}

function routeSpec(props: Json, where: string): Json {
  const { receiver, group_by, group_wait, group_interval, repeat_interval, matchers, continue: cont, mute_time_intervals, active_time_intervals, routes, ...rest } = props;
  const unknown = Object.keys(rest).filter((k) => rest[k] !== undefined);
  if (unknown.length > 0) throw new Error(`${where}: ${unknown.join(", ")} cannot be written to an AlertmanagerConfig route`);
  const out: Json = {};
  if (receiver !== undefined) out.receiver = nameOf(receiver, "receiverName");
  if (group_by !== undefined) out.groupBy = group_by;
  if (group_wait !== undefined) out.groupWait = group_wait;
  if (group_interval !== undefined) out.groupInterval = group_interval;
  if (repeat_interval !== undefined) out.repeatInterval = repeat_interval;
  if (matchers !== undefined) out.matchers = crdMatchers(matchers as unknown[], where);
  if (cont !== undefined) out.continue = cont;
  if (mute_time_intervals !== undefined) out.muteTimeIntervals = (mute_time_intervals as unknown[]).map((t) => nameOf(t, "intervalName"));
  if (active_time_intervals !== undefined) out.activeTimeIntervals = (active_time_intervals as unknown[]).map((t) => nameOf(t, "intervalName"));
  if (routes !== undefined) out.routes = (routes as unknown[]).map((child, i) => routeSpec(propsOf(child, `${where}.routes[${i}]`), `${where}.routes[${i}]`));
  return out;
}

function camelEntry(value: unknown, names: Map<string, string>, where: string): unknown {
  if (Array.isArray(value)) return value.map((v) => camelEntry(v, names, where));
  if (!isObject(value)) return value;
  const out: Json = {};
  for (const [key, v] of Object.entries(value)) {
    const crd = names.get(key);
    if (crd === undefined) throw new Error(`${where}: ${key} cannot be written to an AlertmanagerConfig receiver`);
    out[crd] = camelEntry(v, names, where);
  }
  return out;
}

/** Fold the kept fields of one notifier entry into the converted one. */
function withKept(entry: Json, kept: Json | undefined): Json {
  return kept === undefined ? entry : { ...entry, ...kept };
}

/**
 * `spec.receivers` from `Receiver`s. `kept` holds what the declarations
 * cannot, by receiver name, in the CRD's own shape: the Secret references,
 * `httpConfig` and any notifier this lexicon does not convert. A notifier
 * list there is merged in entry by entry, so `{ slack: { slackConfigs: [{ apiURL: { name, key } }] } }`
 * puts the reference back beside the first Slack entry's typed fields.
 */
export function alertmanagerConfigReceivers(receivers: readonly (ReceiverEntity | Json)[], kept: Record<string, Json> = {}): Json[] {
  return receivers.map((r) => {
    const props = propsOf(r, "a receiver");
    const { name, labels, ...configs } = props;
    if (typeof name !== "string") throw new Error("alertmanager: a receiver has no name");
    if (labels !== undefined) throw new Error(`receiver ${name}: labels cannot be written to an AlertmanagerConfig receiver`);
    const out: Json = { name };
    const extra = kept[name] ?? {};
    const keys = new Set<string>();
    for (const [key, list] of Object.entries(configs)) {
      if (list === undefined) continue;
      const names = REVERSE[key];
      if (names === undefined || !Array.isArray(list)) throw new Error(`receiver ${name}: ${key} cannot be written to an AlertmanagerConfig receiver`);
      const crdKey = [...Object.keys(NOTIFIERS)].find((k) => notifierKey(k) === key)!;
      const keptList = Array.isArray(extra[crdKey]) ? (extra[crdKey] as unknown[]) : [];
      const length = Math.max(list.length, keptList.length);
      out[crdKey] = Array.from({ length }, (_, i) => {
        const typed = i < list.length ? (camelEntry(list[i], names, `receiver ${name}`) as Json) : {};
        return withKept(typed, isObject(keptList[i]) ? keptList[i] : undefined);
      });
      keys.add(crdKey);
    }
    // A notifier no declaration holds at all: kept whole.
    for (const [crdKey, value] of Object.entries(extra)) if (!keys.has(crdKey)) out[crdKey] = value;
    return out;
  });
}

/** `spec.inhibitRules` from `InhibitRule`s. */
export function alertmanagerConfigInhibitRules(rules: readonly (InhibitRuleEntity | Json)[]): Json[] {
  return rules.map((r, i) => {
    const { source_matchers, target_matchers, equal, ...rest } = propsOf(r, "an inhibit rule");
    const unknown = Object.keys(rest).filter((k) => rest[k] !== undefined);
    if (unknown.length > 0) throw new Error(`inhibitRules[${i}]: ${unknown.join(", ")} cannot be written to an AlertmanagerConfig inhibit rule`);
    const out: Json = {};
    if (source_matchers !== undefined) out.sourceMatch = crdMatchers(source_matchers as unknown[], `inhibitRules[${i}]`);
    if (target_matchers !== undefined) out.targetMatch = crdMatchers(target_matchers as unknown[], `inhibitRules[${i}]`);
    if (equal !== undefined) out.equal = equal;
    return out;
  });
}

/** An Alertmanager `1:5` or `3` as the CRD's `{ start, end }`. */
function crdDayRange(text: unknown, where: string): Json {
  const m = typeof text === "string" ? /^(-?\d+)(?::(-?\d+))?$/.exec(text) : null;
  if (!m) throw new Error(`${where}: days_of_month entry ${JSON.stringify(text)} is not a day or a first:last range`);
  return { start: Number(m[1]), end: Number(m[2] ?? m[1]) };
}

/** `spec.muteTimeIntervals` from `TimeInterval`s. */
export function alertmanagerConfigMuteTimeIntervals(intervals: readonly (TimeIntervalEntity | Json)[]): Json[] {
  return intervals.map((t) => {
    const { name, time_intervals, ...rest } = propsOf(t, "a time interval");
    const where = `time interval ${String(name)}`;
    const unknown = Object.keys(rest).filter((k) => rest[k] !== undefined);
    if (unknown.length > 0) throw new Error(`${where}: ${unknown.join(", ")} cannot be written to an AlertmanagerConfig time interval`);
    const periods = (Array.isArray(time_intervals) ? time_intervals : []).map((p) => {
      if (!isObject(p)) throw new Error(`${where}: a period is not an object`);
      const { times, weekdays, days_of_month, months, years, ...more } = p;
      const bad = Object.keys(more).filter((k) => more[k] !== undefined);
      if (bad.length > 0) throw new Error(`${where}: ${bad.join(", ")} cannot be written to an AlertmanagerConfig time interval (the CRD has no ${bad.join(" or ")})`);
      const out: Json = {};
      if (times !== undefined) out.times = (times as Json[]).map((r) => ({ startTime: r.start_time, endTime: r.end_time }));
      if (weekdays !== undefined) out.weekdays = weekdays;
      if (days_of_month !== undefined) out.daysOfMonth = (days_of_month as unknown[]).map((d) => crdDayRange(d, where));
      if (months !== undefined) out.months = months;
      if (years !== undefined) out.years = years;
      return out;
    });
    return { name, ...(periods.length > 0 || time_intervals !== undefined ? { timeIntervals: periods } : {}) };
  });
}
