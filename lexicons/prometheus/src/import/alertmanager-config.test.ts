import { describe, expect, test } from "vitest";
import type { EmbeddedContent } from "@intentius/chant/import/embedded";
import { alertmanagerConfigImporter } from "./alertmanager-config";

const SPEC = {
  route: {
    receiver: "slack",
    groupBy: ["alertname"],
    matchers: [{ name: "team", value: "db", matchType: "=" }],
    routes: [{ receiver: "pager", matchers: [{ name: "severity", value: "crit.*", matchType: "=~" }] }],
  },
  receivers: [
    {
      name: "slack",
      slackConfigs: [{ apiURL: { name: "slack-token", key: "url" }, channel: "#a", sendResolved: true }],
    },
    { name: "pager", pagerdutyConfigs: [{ routingKey: { name: "pd", key: "key" }, httpConfig: { followRedirects: true }, severity: "critical" }], msteamsConfigs: [{ title: "t" }] },
  ],
  inhibitRules: [{ sourceMatch: [{ name: "a", value: "1", matchType: "=" }], targetMatch: [{ name: "a", value: "2", matchType: "!=" }], equal: ["x"] }],
  muteTimeIntervals: [{ name: "weekends", timeIntervals: [{ weekdays: ["saturday"], daysOfMonth: [{ start: 1, end: 5 }], times: [{ startTime: "00:00", endTime: "06:00" }] }] }],
};

const site = (select: string, spec: Record<string, unknown> = SPEC): EmbeddedContent => ({
  host: "k8s",
  hostType: "K8s::Monitoring::AlertmanagerConfig",
  location: `AlertmanagerConfig main spec.${select}`,
  directory: "main",
  document: spec,
  select,
});

describe("an AlertmanagerConfig's fields (#5113)", () => {
  test("matches each of the four fields of an AlertmanagerConfig, and nothing else", () => {
    for (const field of ["route", "receivers", "inhibitRules", "muteTimeIntervals"]) expect(alertmanagerConfigImporter.matches(site(field))).toBe(true);
    expect(alertmanagerConfigImporter.matches(site("groups"))).toBe(false);
    expect(alertmanagerConfigImporter.matches({ ...site("route"), hostType: "K8s::Monitoring::PrometheusRule" })).toBe(false);
    expect(alertmanagerConfigImporter.matches({ ...site("route"), select: undefined })).toBe(false);
    expect(alertmanagerConfigImporter.matches({ ...site("route"), document: "text" })).toBe(false);
  });

  test("spec.route is one Route through alertmanagerConfigRoute, matchers as strings, declarations not exported singly", () => {
    const out = alertmanagerConfigImporter.import(site("route"));
    expect(out.value).toEqual({
      bindings: [{ from: "routes.ts", name: "declared", member: "root" }],
      shape: "single",
      through: { from: "@intentius/chant-lexicon-prometheus/k8s", name: "alertmanagerConfigRoute" },
    });
    const text = out.files.map((f) => f.content).join("\n");
    expect(text).toContain("new Route(");
    expect(text).toContain("group_by: [\"alertname\"]");
    expect(text).toContain('matchers: [\'team="db"\']');
    expect(text).toContain('severity=~"crit.*"');
    expect(text).toContain("export const declared = { root };");
    expect(text).not.toMatch(/export \{/);
    expect(out.warnings ?? []).toEqual([]);
  });

  test("spec.receivers keeps what a declaration cannot hold in a module, and names it in warnings", () => {
    const out = alertmanagerConfigImporter.import(site("receivers"));
    expect(out.value).toEqual({ bindings: [{ from: "crd-receivers.ts", name: "receivers" }], shape: "single" });
    const typed = out.files.find((f) => f.path === "receivers.ts")!.content;
    expect(typed).toContain("channel: \"#a\"");
    expect(typed).toContain("send_resolved: true");
    expect(typed).not.toMatch(/apiURL|api_url|routingKey|routing_key|msteams|httpConfig/);
    const module = out.files.find((f) => f.path === "crd-receivers.ts")!.content;
    expect(module).toContain('"apiURL"');
    expect(module).toContain('"name": "slack-token"');
    expect(module).toContain('"msteamsConfigs"');
    expect(module).toContain("alertmanagerConfigReceivers([declared.slack, declared.pager], kept)");
    expect(out.warnings).toEqual([
      'receiver "slack": slackConfigs[0] keeps apiURL as the CRD wrote it (a Secret reference is carried and never read, and httpConfig has no declaration), beside the declaration.',
      'receiver "pager": pagerdutyConfigs[0] keeps routingKey, httpConfig as the CRD wrote them (a Secret reference is carried and never read, and httpConfig has no declaration), beside the declaration.',
      'receiver "pager": msteamsConfigs is not a notifier the prometheus lexicon converts, so it is kept as the CRD wrote it, beside the declaration.',
    ]);
  });

  test("receivers with nothing to keep become a plain list through alertmanagerConfigReceivers", () => {
    const out = alertmanagerConfigImporter.import(site("receivers", { receivers: [{ name: "hook", webhookConfigs: [{ url: "https://example.com", maxAlerts: 3 }] }] }));
    expect(out.value).toEqual({
      bindings: [{ from: "receivers.ts", name: "declared", member: "hook" }],
      shape: "list",
      through: { from: "@intentius/chant-lexicon-prometheus/k8s", name: "alertmanagerConfigReceivers" },
    });
    expect(out.files.map((f) => f.path)).toEqual(["receivers.ts"]);
    expect(out.files[0].content).toContain("max_alerts: 3");
    expect(out.warnings).toEqual([]);
  });

  test("inhibit rules and time intervals", () => {
    const rules = alertmanagerConfigImporter.import(site("inhibitRules"));
    expect(rules.files[0].content).toContain("new InhibitRule(");
    expect(rules.files[0].content).toContain('source_matchers: [\'a="1"\']');
    expect(rules.files[0].content).toContain('target_matchers: [\'a!="2"\']');
    const intervals = alertmanagerConfigImporter.import(site("muteTimeIntervals"));
    expect(intervals.files[0].content).toContain("new TimeInterval(");
    expect(intervals.files[0].content).toContain('days_of_month: ["1:5"]');
    expect(intervals.files[0].content).toContain("start_time: \"00:00\"");
  });

  test.each([
    ["a matcher without matchType", { route: { receiver: "a", matchers: [{ name: "x", value: "y" }] } }, "spec.route.matchers[0] is not a matcher a declaration can hold"],
    ["the deprecated regex", { route: { matchers: [{ name: "x", value: "y", matchType: "=", regex: true }] } }, "spec.route.matchers[0]"],
    ["a field the CRD route does not have", { route: { receiver: "a", labels: {} } }, "spec.route has labels"],
    ["a child with a wrong type", { route: { routes: [{ groupWait: 30 }] } }, "spec.route.routes[0].groupWait is not a string"],
    ["a name used twice", { receivers: [{ name: "a" }, { name: "a" }] }, "used twice"],
    ["a day range that is not a pair", { muteTimeIntervals: [{ name: "t", timeIntervals: [{ daysOfMonth: [{ start: 1 }] }] }] }, "daysOfMonth[0] is not a { start, end } pair"],
    ["an inhibit rule with a field the CRD does not have", { inhibitRules: [{ sourceMatch: [], name: "x" }] }, "spec.inhibitRules[0] has name"],
  ])("%s keeps the field as written: the import throws and core warns", (_what, spec, message) => {
    const select = Object.keys(spec)[0];
    expect(() => alertmanagerConfigImporter.import(site(select, spec))).toThrow(message);
  });
});
