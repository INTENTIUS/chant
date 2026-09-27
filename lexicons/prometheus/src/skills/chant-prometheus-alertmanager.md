---
skill: chant-prometheus-alertmanager
description: Declare Alertmanager routing (routes, receivers, inhibit rules, time intervals) and keep every alert severity routed
user-invocable: true
---

# Alertmanager routing with chant

`Route`, `Receiver`, `InhibitRule`, `TimeInterval` and `AlertmanagerSettings` build `alertmanager.yml`. When the same build root declares `RuleGroup`s, the rule file is the primary output and `alertmanager.yml` is written beside it.

```ts
import { AlertmanagerSettings, InhibitRule, Receiver, Route, TimeInterval } from "@intentius/chant-lexicon-prometheus";

export const settings = new AlertmanagerSettings({ global: { resolve_timeout: "5m" } });

export const oncall = new Receiver({
  name: "oncall",
  pagerduty_configs: [{ routing_key_file: "/etc/alertmanager/secrets/pagerduty-key" }],
});
export const team = new Receiver({
  name: "team-slack",
  slack_configs: [{ api_url_file: "/etc/alertmanager/secrets/slack-url", channel: "#alerts", send_resolved: true }],
});
export const sink = new Receiver({ name: "default", webhook_configs: [{ url: "http://alert-sink.monitoring:8080/" }] });

export const offHours = new TimeInterval({
  name: "off-hours",
  time_intervals: [{ weekdays: ["saturday", "sunday"] }, { times: [{ start_time: "18:00", end_time: "24:00" }] }],
});

export const root = new Route({
  receiver: sink,
  group_by: ["alertname", "job"],
  group_wait: "30s",
  group_interval: "5m",
  repeat_interval: "4h",
  routes: [
    { matchers: ['severity="page"'], receiver: oncall },
    { matchers: ['severity="ticket"'], receiver: team, mute_time_intervals: [offHours] },
  ],
});

export const pageMutesTicket = new InhibitRule({
  source_matchers: ['severity="page"'],
  target_matchers: ['severity="ticket"'],
  equal: ["alertname", "job"],
});
```

## What the checks hold you to

- One root route (the `Route` no other route nests), with a receiver and no matchers (PROM205).
- Routes name receivers and time intervals that exist (PROM201, PROM204). Reference the entity rather than a string and TypeScript does most of this.
- Every `severity` an alert in the same build root carries is matched by some route below the root (PROM202). The check only sees one build root (chant #1939): keep the rules and the Alertmanager config in the same one, or it goes quiet.
- Credentials go in `*_file` fields. Alertmanager does not expand environment variables in its config, and a literal `api_url`, `routing_key` or `auth_password` is flagged (PROM001).
- Each integration has somewhere to send (PROM209): a webhook `url`, a Slack `api_url` (or `global.slack_api_url`), a PagerDuty key, an email `to`/`smarthost`/`from` (or the global SMTP defaults).

Run `amtoolCheckConfig(alertmanagerYaml(entities))` in a test to have `amtool check-config` confirm it when installed.
