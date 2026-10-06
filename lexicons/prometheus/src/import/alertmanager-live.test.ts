/**
 * Alertmanager's re-marshalled `/api/v2/status` config back to the declared
 * shape (#3371). The fixture is written by hand in the shape
 * `Config.String()` gives at Alertmanager v0.34.1 (defaults written out,
 * globals copied into each integration, secrets masked); a stack run
 * against a real Alertmanager is what confirms it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { maskedSecretPaths, stripAlertmanagerDefaults } from "./alertmanager-live";
import { loadPrometheusYaml } from "./parser";

const original = readFileSync(join(import.meta.dirname, "..", "api", "testdata", "am-status-original.yml"), "utf8");
const doc = loadPrometheusYaml(original) as Record<string, unknown>;

describe("stripAlertmanagerDefaults", () => {
  const stripped = stripAlertmanagerDefaults(doc);

  test("global keeps only what differs from DefaultGlobalConfig", () => {
    expect(stripped.global).toEqual({ smtp_from: "am@example.com", smtp_smarthost: "smtp.example.com:587" });
  });

  test("routes lose continue: false and keep matchers, group_by and time intervals", () => {
    expect(stripped.route).toEqual({
      receiver: "team",
      group_by: ["alertname"],
      routes: [{ receiver: "pager", matchers: ['severity="page"'], mute_time_intervals: ["weekends"] }],
    });
  });

  test("integrations lose inherited globals, their own defaults and zero values, and keep what was set", () => {
    expect(stripped.receivers).toEqual([
      { name: "team", webhook_configs: [{ url: "<secret>" }] },
      {
        name: "pager",
        // require_tls: false differs from the global true, so it was set and stays.
        email_configs: [{ to: "oncall@example.com", require_tls: false }],
        pagerduty_configs: [{ routing_key: "<secret>", details: { team: "payments" } }],
      },
    ]);
  });

  test("inhibit rules and time intervals are kept, an empty templates list is not", () => {
    expect(stripped.inhibit_rules).toEqual([{ source_matchers: ['severity="page"'], target_matchers: ['severity="ticket"'], equal: ["alertname"] }]);
    expect(stripped.time_intervals).toEqual([{ name: "weekends", time_intervals: [{ weekdays: ["saturday", "sunday"] }] }]);
    expect("templates" in stripped).toBe(false);
  });

  test("a webhook that turned send_resolved off keeps it", () => {
    const out = stripAlertmanagerDefaults({ receivers: [{ name: "x", webhook_configs: [{ send_resolved: false, url: "http://x" }] }] });
    expect(out.receivers).toEqual([{ name: "x", webhook_configs: [{ send_resolved: false, url: "http://x" }] }]);
  });

  test("the input is not changed", () => {
    expect((loadPrometheusYaml(original) as Record<string, unknown>).global).toEqual(doc.global);
  });
});

test("maskedSecretPaths names every <secret>", () => {
  expect(maskedSecretPaths(stripAlertmanagerDefaults(doc))).toEqual([
    "receivers[0].webhook_configs[0].url",
    "receivers[1].pagerduty_configs[0].routing_key",
  ]);
});
