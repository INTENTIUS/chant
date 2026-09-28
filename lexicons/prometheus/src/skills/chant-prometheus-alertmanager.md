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

## Starting from an existing alertmanager.yml

Import it rather than retyping it: `chant import alertmanager.yml --output src` (with `--lexicon prometheus` outside a chant project). The importer writes `receivers.ts`, `time-intervals.ts`, `routes.ts` (the root `Route`, children as `RouteProps` that reference receivers and time intervals by variable), `inhibit-rules.ts` and `settings.ts`. `*_file` paths and Go templates are kept as written; a literal credential is imported as found and PROM001 reports it, so offer to move it to the `*_file` field. Integrations the lexicon doesn't type (`opsgenie_configs`, `msteams_configs`, ...) are spread in from an untyped const. `match`/`match_re` and the top-level `mute_time_intervals` come back in their current spelling (`matchers`, `time_intervals`), and `chant import` prints a warning for each.

## What the checks hold you to

- One root route (the `Route` no other route nests), with a receiver and no matchers (PROM205).
- Routes name receivers and time intervals that exist (PROM201, PROM204). Reference the entity rather than a string and TypeScript does most of this.
- Every `severity` an alert in the same build root carries is matched by some route below the root (PROM202). The check only sees one build root (chant #1939): keep the rules and the Alertmanager config in the same one, or it goes quiet.
- Credentials go in `*_file` fields. Alertmanager does not expand environment variables in its config, and a literal `api_url`, `routing_key` or `auth_password` is flagged (PROM001).
- Each integration has somewhere to send (PROM209): a webhook `url`, a Slack `api_url` (or `global.slack_api_url`), a PagerDuty key, an email `to`/`smarthost`/`from` (or the global SMTP defaults).

Run `amtoolCheckConfig(alertmanagerYaml(entities))` in a test to have `amtool check-config` confirm it when installed.
