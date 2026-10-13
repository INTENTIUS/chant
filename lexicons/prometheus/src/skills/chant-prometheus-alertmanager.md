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

Import it rather than retyping it: `chant import alertmanager.yml --output src` (with `--lexicon prometheus` outside a chant project). The importer writes `receivers.ts`, `time-intervals.ts`, `routes.ts` (the root `Route`, children as `RouteProps` that reference receivers and time intervals by variable), `inhibit-rules.ts` and `settings.ts`. `*_file` paths and Go templates are kept as written; a literal credential is imported as found and PROM001 reports it, so offer to move it to the `*_file` field. Every integration comes back typed (`OpsGenieConfig[]`, `MSTeamsV2Config[]`, ...); a receiver or `global` key Alertmanager doesn't define is spread in from an untyped const, with a warning. `match`/`match_re` and the top-level `mute_time_intervals` come back in their current spelling (`matchers`, `time_intervals`), and `chant import` prints a warning for each.

## What the checks hold you to

- One root route (the `Route` no other route nests), with a receiver and no matchers (PROM205).
- Routes name receivers and time intervals that exist (PROM201, PROM204). Reference the entity rather than a string and TypeScript does most of this.
- Every `severity` an alert in the same build root carries is matched by some route below the root (PROM202). The check only sees one build root (chant #1939): keep the rules and the Alertmanager config in the same one, or it goes quiet.
- Credentials go in `*_file` fields. Alertmanager does not expand environment variables in its config, and a literal `api_url`, `routing_key` or `auth_password` is flagged (PROM001).
- Each integration has its destination, credential and required fields, or the `global` default it falls back to (PROM209): a webhook `url`, a Slack `api_url` or app token, an Opsgenie `api_key`, a Telegram `chat_id` and bot token, a Webex `room_id` and `http_config.authorization`, one SNS target, a Jira `project` and `issue_type`, an email `to`/`smarthost`/`from`, and so on.
- No setting Alertmanager rejects (PROM210): a value and its `*_file` both set, a Slack `api_url` with an app token, `update_message` without `api_url: https://slack.com/api/chat.postMessage`, a WeChat `message_type` other than `text`/`markdown`, a Telegram `parse_mode` other than `Markdown`/`MarkdownV2`/`HTML`.
- Durations parse (PROM208). Route timers and `resolve_timeout` take `1d`; the integration `timeout`s and Pushover `retry`/`expire`/`ttl` are Go durations and take `24h`, not `1d`.

Run `amtoolCheckConfig(alertmanagerYaml(entities))` in a test to have `amtool check-config` confirm it when installed.
