/**
 * `Watchdog`: an alert that always fires, routed to a heartbeat receiver.
 *
 * The alert's expression is `vector(1)`, so it fires from the first rule
 * evaluation for as long as Prometheus evaluates rules and Alertmanager
 * delivers notifications. The route sends it to a heartbeat service
 * (healthchecks.io, Dead Man's Snitch, a PagerDuty or Opsgenie heartbeat),
 * which raises its own alarm when the notifications stop: the whole alerting
 * path, not just Prometheus, is down.
 *
 * The route is a child route, matched on the alert's name and severity. Put
 * it first under the root route: `AlertRouting({ routes: [watchdog.route] })`,
 * or the `routes` of a root `Route` of your own. Left unnested it is a second
 * root, and the build warns.
 *
 * By default the receiver is a webhook that reads its URL from a file
 * (`url_file`), since a heartbeat URL is a credential; mount the file into
 * Alertmanager.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import { Receiver, Route, isReceiver, type ReceiverEntity, type ReceiverProps, type RouteEntity } from "../alertmanager";
import { RuleGroup, type RuleGroupEntity } from "../rules";
import type { LabelSet } from "../model";
import { durationMs, isValidDuration } from "../duration";

export interface WatchdogProps {
  /**
   * Where the heartbeat goes: a declared `Receiver`, a receiver's props
   * (the composite declares it), or the name of one declared elsewhere.
   * Default: a `heartbeat` receiver with one webhook reading `urlFile`.
   */
  receiver?: ReceiverEntity | ReceiverProps | string;
  /** The file the default receiver's webhook reads its URL from (default `/etc/alertmanager/secrets/heartbeat-url`). */
  urlFile?: string;
  /** The alert's name (default `Watchdog`). */
  alert?: string;
  /** The alert's `severity` label (default `none`): no severity route takes it. */
  severity?: string;
  /** How often the heartbeat is sent again while the alert fires (default `1m`). Keep it under the heartbeat service's period. */
  repeatInterval?: string;
  /** The rule group's name (default `watchdog`). */
  group?: string;
  /** More labels on the alert. */
  labels?: LabelSet;
  /** More annotations on the alert. */
  annotations?: LabelSet;
}

export type WatchdogMembers = {
  /** The always-firing alert. */
  rules: RuleGroupEntity;
  /** The child route that sends it to the heartbeat receiver. */
  route: RouteEntity;
  /** The heartbeat receiver, when this composite declares it. */
  receiver?: ReceiverEntity;
};

export type WatchdogInstance = CompositeInstance<WatchdogMembers> & WatchdogMembers;

const ALERT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The default heartbeat URL file. */
export const WATCHDOG_URL_FILE = "/etc/alertmanager/secrets/heartbeat-url";

function fail(message: string): never {
  throw new Error(`Watchdog: ${message}`);
}

/**
 * An always-firing alert and the route that sends it to a heartbeat receiver.
 *
 * @example
 * ```ts
 * import { AlertRouting, Watchdog } from "@intentius/chant-lexicon-prometheus";
 *
 * export const watchdog = Watchdog({ urlFile: "/etc/alertmanager/secrets/healthchecks-url" });
 * export const routing = AlertRouting({ routes: [watchdog.route] });
 * ```
 */
export const Watchdog = Composite<WatchdogProps, WatchdogMembers>((input) => {
  const props = input ?? {};
  const alert = props.alert ?? "Watchdog";
  if (!ALERT_NAME.test(alert)) fail(`alert "${alert}" is not a valid alert name`);
  const severity = props.severity ?? "none";
  if (typeof severity !== "string" || severity === "") fail("severity must be a non-empty string");
  const repeat = props.repeatInterval ?? "1m";
  if (!isValidDuration(repeat) || !durationMs(repeat)) fail(`repeatInterval "${repeat}" is not a positive duration`);
  // repeat_interval under group_interval is PROM223; a faster heartbeat brings the group interval down with it.
  const groupInterval = (durationMs(repeat) ?? 0) < 60_000 ? repeat : "1m";
  const groupName = props.group ?? "watchdog";
  if (!GROUP_NAME.test(groupName)) fail(`group "${groupName}" must be letters, digits, '.', '_' or '-'`);
  if (props.urlFile !== undefined && props.receiver !== undefined) fail("urlFile configures the default receiver; leave it out when receiver is set");
  if (props.urlFile !== undefined && props.urlFile.trim() === "") fail("urlFile must be a path");

  let receiver: ReceiverEntity | undefined;
  let ref: ReceiverEntity | string;
  if (typeof props.receiver === "string") {
    if (props.receiver === "") fail("receiver must name a receiver");
    ref = props.receiver;
  } else if (isReceiver(props.receiver)) {
    ref = props.receiver;
  } else {
    const p: ReceiverProps = props.receiver ?? {
      name: "heartbeat",
      webhook_configs: [{ url_file: props.urlFile ?? WATCHDOG_URL_FILE, send_resolved: false }],
    };
    if (!p.name) fail("receiver.name is required");
    receiver = new Receiver(p);
    ref = receiver;
  }

  const rules = new RuleGroup({
    name: groupName,
    rules: [
      {
        alert,
        expr: "vector(1)",
        labels: { ...(props.labels ?? {}), severity },
        annotations: {
          summary: "Always firing, to show the alerting pipeline works",
          description:
            "This alert fires all the time. A heartbeat service receives it every few minutes and raises its own alarm when it stops arriving, which means Prometheus, Alertmanager or the path between them is down.",
          ...(props.annotations ?? {}),
        },
      },
    ],
  });
  const route = new Route({
    receiver: ref,
    matchers: [`alertname=${JSON.stringify(alert)}`, `severity=${JSON.stringify(severity)}`],
    group_by: ["alertname"],
    group_wait: "0s",
    group_interval: groupInterval,
    repeat_interval: repeat,
    continue: false,
  });
  const members: WatchdogMembers = { rules, route };
  if (receiver) members.receiver = receiver;
  return members;
}, "Watchdog");
