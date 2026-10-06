/**
 * `AlertRouting`: an Alertmanager routing tree by team and severity, the
 * inhibit rules between severity levels, and the receivers.
 *
 * The root route sends to `receiver` (default: a `default` receiver with no
 * integrations, which drops what reaches it). Below it, in order:
 *
 * 1. `routes`: child routes of your own, first, such as `Watchdog`'s.
 * 2. One route per team, matched on the team label (`team` by default),
 *    sending to the team's receiver; a team can send a severity level to
 *    another receiver of its own (a pager for `critical`).
 * 3. One route per severity level, for every alert no team route took.
 *
 * The default levels are the severities the lexicon's composites write:
 * `critical` (with `Slo`'s `page`), `warning` (with `Slo`'s `ticket`, and
 * `GenAiRules`' and `RedAlerts`' default `warning`) and `info`. Each level
 * sends to the root receiver unless it names one, so a project routes
 * `critical` to a pager and leaves the rest, and PROM202 finds every
 * severity routed.
 *
 * While an alert of one level fires, the same alert at every lower level is
 * held back (an inhibit rule per pair). "The same alert" is equal values of
 * `inhibitEqual`, by default `alertname` and the labels the lexicon's
 * composites tell their alerts apart by (`slo`, `service_name`) plus the team
 * label: one SLO's page holds back that SLO's ticket, not another's.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import {
  InhibitRule,
  Receiver,
  Route,
  isReceiver,
  isRoute,
  type InhibitRuleEntity,
  type ReceiverEntity,
  type ReceiverProps,
  type RouteEntity,
  type RouteProps,
} from "../alertmanager";
import { isValidDuration } from "../duration";

/** A receiver: declared, as props for the composite to declare, or by name for one declared elsewhere. */
export type AlertRoutingReceiver = ReceiverEntity | ReceiverProps | string;

/** Route timing, as Alertmanager names it. */
export interface AlertRoutingTiming {
  /** How long to wait before the first notification of a new group. */
  groupWait?: string;
  /** How long to wait before notifying about new alerts in a group already notified. */
  groupInterval?: string;
  /** How long to wait before sending a notification again. */
  repeatInterval?: string;
}

/** One severity level: the `severity` values in it, and where they go. */
export interface AlertRoutingLevel extends AlertRoutingTiming {
  /** The level's name, used in member and inhibit rule names, e.g. `critical`. */
  name: string;
  /** The `severity` values at this level, e.g. `["critical", "page"]`. */
  severities: string[];
  /** Where the level goes (default: the root receiver). */
  receiver?: AlertRoutingReceiver;
}

/** A team's routes: the alerts carrying its team label value. */
export interface AlertRoutingTeam extends AlertRoutingTiming {
  /** The team label's value. */
  team: string;
  /** Where the team's alerts go. */
  receiver: AlertRoutingReceiver;
  /** Another receiver for some levels, by level name, e.g. `{ critical: pager }`. */
  levels?: Record<string, AlertRoutingReceiver>;
}

export interface AlertRoutingProps extends AlertRoutingTiming {
  /** The root route's receiver, for what no child route takes (default: a `default` receiver with no integrations). */
  receiver?: AlertRoutingReceiver;
  /** Severity levels, most severe first (default `critical`, `warning`, `info`; see `ALERT_ROUTING_LEVELS`). */
  levels?: AlertRoutingLevel[];
  /** Team routes, tried before the severity levels (default: none). */
  teams?: AlertRoutingTeam[];
  /** The label team routes match on (default `team`). */
  teamLabel?: string;
  /** Child routes of your own, tried first, e.g. `[watchdog.route]`. */
  routes?: Array<RouteEntity | RouteProps>;
  /** Labels alerts are grouped by into one notification (default `["alertname"]`). */
  groupBy?: string[];
  /** Inhibit lower levels while a higher one fires (default: on). */
  inhibit?: boolean;
  /** The labels that must match for one alert to hold back another (default `alertname`, `slo`, `service_name` and the team label). */
  inhibitEqual?: string[];
}

export type AlertRoutingMembers = {
  /** The root route. */
  route: RouteEntity;
} & {
  /** Receivers this composite declares (`receiver_<name>`) and inhibit rules (`inhibit_<higher>_<lower>`). */
  [member: string]: RouteEntity | ReceiverEntity | InhibitRuleEntity;
};

export type AlertRoutingInstance = CompositeInstance<AlertRoutingMembers> & AlertRoutingMembers;

/** The default levels: the severities `Slo`, `GenAiRules` and `RedAlerts` write, most severe first. */
export const ALERT_ROUTING_LEVELS: readonly AlertRoutingLevel[] = Object.freeze([
  { name: "critical", severities: ["critical", "page"] },
  { name: "warning", severities: ["warning", "ticket"] },
  { name: "info", severities: ["info"] },
]);

const LEVEL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(message: string): never {
  throw new Error(`AlertRouting: ${message}`);
}

/** `severity="a"` for one value, `severity=~"a|b"` for several. */
function severityMatcher(values: string[]): string {
  const escaped = values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return values.length === 1 ? `severity=${JSON.stringify(values[0])}` : `severity=~${JSON.stringify(escaped.join("|"))}`;
}

function timing(t: AlertRoutingTiming, at: string): Pick<RouteProps, "group_wait" | "group_interval" | "repeat_interval"> {
  const out: Pick<RouteProps, "group_wait" | "group_interval" | "repeat_interval"> = {};
  for (const [key, field] of [
    ["groupWait", "group_wait"],
    ["groupInterval", "group_interval"],
    ["repeatInterval", "repeat_interval"],
  ] as const) {
    const v = t[key];
    if (v === undefined) continue;
    if (!isValidDuration(v)) fail(`${at}.${key} "${v}" is not a duration`);
    out[field] = v;
  }
  return out;
}

/**
 * A routing tree by team and severity, with inhibit rules between levels.
 *
 * @example
 * ```ts
 * import { AlertRouting, Watchdog } from "@intentius/chant-lexicon-prometheus";
 *
 * const pager = { name: "pager", pagerduty_configs: [{ routing_key_file: "/etc/alertmanager/secrets/pagerduty" }] };
 * const chat = { name: "chat", slack_configs: [{ api_url_file: "/etc/alertmanager/secrets/slack", channel: "#alerts" }] };
 * export const watchdog = Watchdog({});
 * export const routing = AlertRouting({
 *   receiver: chat,
 *   levels: [{ name: "critical", severities: ["critical", "page"], receiver: pager }, { name: "warning", severities: ["warning", "ticket"] }],
 *   routes: [watchdog.route],
 * });
 * ```
 */
export const AlertRouting = Composite<AlertRoutingProps, AlertRoutingMembers>((input) => {
  const props = input ?? {};
  const members: Record<string, RouteEntity | ReceiverEntity | InhibitRuleEntity> = {};
  const declared = new Map<string, { props: ReceiverProps; entity: ReceiverEntity }>();
  const external = new Map<string, ReceiverEntity>();

  const receiverRef = (r: AlertRoutingReceiver, at: string): ReceiverEntity | string => {
    if (typeof r === "string") {
      if (r === "") fail(`${at} must name a receiver`);
      return r;
    }
    if (isReceiver(r)) {
      const name = r.props.name;
      const seen = declared.get(name)?.entity ?? external.get(name);
      if (seen && seen !== r) fail(`${at}: two receivers are named "${name}"`);
      external.set(name, r);
      return r;
    }
    if (!r || typeof r !== "object" || typeof r.name !== "string" || r.name === "") fail(`${at}.name is required`);
    const before = declared.get(r.name);
    if (before) {
      if (before.props !== r) fail(`${at}: two receivers are named "${r.name}"; declare it once and pass the same object`);
      return before.entity;
    }
    if (external.has(r.name)) fail(`${at}: two receivers are named "${r.name}"`);
    const entity = new Receiver(r);
    declared.set(r.name, { props: r, entity });
    members[`receiver_${r.name.replace(/[^A-Za-z0-9_]/g, "_")}`] = entity;
    return entity;
  };

  const teamLabel = props.teamLabel ?? "team";
  if (!LABEL.test(teamLabel)) fail(`teamLabel "${teamLabel}" is not a label name`);
  const groupBy = props.groupBy ?? ["alertname"];
  for (const l of groupBy) if (l !== "..." && !LABEL.test(l)) fail(`groupBy label "${l}" is not a label name`);
  const equal = props.inhibitEqual ?? ["alertname", "slo", "service_name", teamLabel];
  for (const l of equal) if (!LABEL.test(l)) fail(`inhibitEqual label "${l}" is not a label name`);

  const root = receiverRef(props.receiver ?? { name: "default" }, "receiver");

  const levels = props.levels ?? ALERT_ROUTING_LEVELS;
  if (!Array.isArray(levels)) fail("levels must be a list");
  const levelNames = new Set<string>();
  const severities = new Map<string, string>();
  levels.forEach((l, i) => {
    const at = `levels[${i}]`;
    if (!l || typeof l.name !== "string" || !LEVEL_NAME.test(l.name)) fail(`${at}.name must be letters, digits and '_', starting with a letter`);
    if (levelNames.has(l.name)) fail(`${at}: a second level is named "${l.name}"`);
    levelNames.add(l.name);
    if (!Array.isArray(l.severities) || l.severities.length === 0) fail(`${at}.severities must name at least one severity`);
    for (const s of l.severities) {
      if (typeof s !== "string" || s === "") fail(`${at}.severities must be non-empty strings`);
      const other = severities.get(s);
      if (other !== undefined) fail(`${at}: severity "${s}" is already in level "${other}"`);
      severities.set(s, l.name);
    }
  });

  const children: Array<RouteEntity | RouteProps> = [];
  (props.routes ?? []).forEach((r, i) => {
    if (!isRoute(r) && (typeof r !== "object" || r === null)) fail(`routes[${i}] must be a Route or route props`);
    children.push(r);
  });

  const teams = props.teams ?? [];
  const teamNames = new Set<string>();
  teams.forEach((t, i) => {
    const at = `teams[${i}]`;
    if (!t || typeof t.team !== "string" || t.team === "") fail(`${at}.team is required`);
    if (teamNames.has(t.team)) fail(`${at}: team "${t.team}" is listed twice`);
    teamNames.add(t.team);
    if (t.receiver === undefined) fail(`${at}.receiver is required`);
    const routes: RouteProps[] = [];
    for (const [levelName, r] of Object.entries(t.levels ?? {})) {
      const level = levels.find((l) => l.name === levelName);
      if (!level) fail(`${at}.levels names "${levelName}", which is not a level (${[...levelNames].join(", ")})`);
      routes.push({ matchers: [severityMatcher(level.severities)], receiver: receiverRef(r, `${at}.levels.${levelName}`) });
    }
    children.push({
      matchers: [`${teamLabel}=${JSON.stringify(t.team)}`],
      receiver: receiverRef(t.receiver, `${at}.receiver`),
      ...timing(t, at),
      ...(routes.length > 0 ? { routes } : {}),
    });
  });

  levels.forEach((l, i) => {
    children.push({
      matchers: [severityMatcher(l.severities)],
      receiver: l.receiver !== undefined ? receiverRef(l.receiver, `levels[${i}].receiver`) : root,
      ...timing(l, `levels[${i}]`),
    });
  });

  const route = new Route({
    receiver: root,
    group_by: [...groupBy],
    group_wait: "30s",
    group_interval: "5m",
    repeat_interval: "4h",
    ...timing(props, "props"),
    routes: children,
  });

  if (props.inhibit !== false) {
    for (let hi = 0; hi < levels.length; hi++) {
      for (let lo = hi + 1; lo < levels.length; lo++) {
        const a = levels[hi];
        const b = levels[lo];
        members[`inhibit_${a.name}_${b.name}`] = new InhibitRule({
          name: `${a.name} holds back ${b.name}`,
          source_matchers: [severityMatcher(a.severities)],
          target_matchers: [severityMatcher(b.severities)],
          equal: [...equal],
        });
      }
    }
  }

  return { route, ...members } as AlertRoutingMembers;
}, "AlertRouting");
