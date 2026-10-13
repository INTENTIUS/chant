/**
 * Grafana Operator alerting through `chant import` (#3538): the output of
 * `GrafanaOperatorResources` (#3156) for a set of alerting declarations,
 * imported as grafana declarations, builds back to the same resources, and
 * the declarations build the same alerting provisioning file.
 *
 * The manifest is written by `GrafanaOperatorResources` itself, so the test
 * holds the writer and the reader to each other. A rule group's folder is
 * the one thing that changes on the way: the resource names its
 * GrafanaFolder and the declaration wants the folder's title, so the
 * provisioning comparison puts the folder name in the source's `folder`.
 */

import { describe, expect, test } from "vitest";
import { load, loadAll } from "js-yaml";
import { build } from "@intentius/chant/build";
import { expandComposite } from "@intentius/chant/composite";
import type { SerializerResult } from "@intentius/chant/serializer";
import {
  AlertRule,
  AlertRuleGroup,
  ALERTING_FILE,
  ContactPoint,
  Datasource,
  MuteTiming,
  NotificationPolicy,
  NotificationTemplate,
  PromQuery,
  grafanaSerializer,
} from "@intentius/chant-lexicon-grafana";
import { buildGrafana } from "@intentius/chant-lexicon-grafana/build";
import { normalizeAlerting } from "@intentius/chant-lexicon-grafana/import/normalize-alerting";
import { GrafanaOperatorResources } from "@intentius/chant-lexicon-grafana/k8s";
import { k8sSerializer } from "../serializer";
import { importManifest, removeDir } from "./testdata/embedded/fixtures";

type Json = Record<string, unknown>;

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" });
const oncall = new ContactPoint({
  name: "oncall",
  receivers: [
    { uid: "oncall-slack", type: "slack", settings: { url: "${SLACK_URL}", title: "chant" } },
    { uid: "oncall-mail", type: "email", settings: { addresses: "a@example.com" }, disableResolveMessage: true },
  ],
});
const weekends = new MuteTiming({ name: "weekends", time_intervals: [{ weekdays: ["saturday", "sunday"] }] });
const template = new NotificationTemplate({ name: "t", template: '{{ define "t" }}x{{ end }}' });
const policy = new NotificationPolicy({
  receiver: oncall,
  group_by: ["alertname"],
  routes: [{ receiver: "tickets", matchers: ['severity="ticket"', 'team=~"a|b"'], mute_time_intervals: [weekends], routes: [{ matchers: ['env!="dev"'] }] }],
});
const errors = new AlertRule({
  title: "High errors",
  data: [new PromQuery({ datasource: prometheus, expr: "up" })],
  dashboardUid: "dash1",
  panelId: 2,
  for: "5m",
  labels: { severity: "page" },
});
const fewSeries = new AlertRule({
  title: "Few series",
  data: [new PromQuery({ datasource: prometheus, expr: "count(up)" })],
  missing_series_evals_to_resolve: 3,
  notification_settings: { receiver: oncall, group_by: ["alertname"] },
});
const group = new AlertRuleGroup({ name: "errors", folder: "Alerts", interval: "30s", rules: [errors, fewSeries] });
const alerting = [oncall, weekends, template, policy, group];
const entities = [prometheus, ...alerting];

const KINDS = ["GrafanaAlertRuleGroup", "GrafanaContactPoint", "GrafanaNotificationPolicy", "GrafanaMuteTiming", "GrafanaNotificationTemplate"];

function primary(out: string | SerializerResult | undefined): string {
  if (out === undefined) return "";
  return typeof out === "string" ? out : out.primary;
}

function manifest(policyRoutes = false): string {
  const instance = GrafanaOperatorResources({
    entities: entities as never,
    instanceSelector: { matchLabels: { dashboards: "grafana" } },
    secretName: "grafana-secrets",
    namespace: "monitoring",
    policyRoutes,
  });
  return primary(k8sSerializer.serialize(expandComposite("grafana", instance)));
}

function find(docs: Json[], kind: string): Json {
  const doc = docs.find((d) => d.kind === kind);
  if (!doc) throw new Error(`no ${kind}`);
  return doc;
}

describe("GrafanaOperatorResources -> chant import -> chant build", () => {
  test("the five alerting kinds are imported as grafana declarations and build back to the same resources", async () => {
    const yaml = manifest();
    const input = (loadAll(yaml) as Json[]).filter((d) => d);
    expect(KINDS.every((k) => input.some((d) => d.kind === k))).toBe(true);

    const imported = await importManifest(yaml);
    try {
      expect(imported.result.error).toBeUndefined();
      expect(imported.result.success).toBe(true);

      // Each field the grafana lexicon reads is a call over its declarations.
      const main = imported.files["other.ts"];
      expect(main).toContain('from "@intentius/chant-lexicon-grafana/k8s"');
      for (const fn of ["operatorRules", "operatorPolicy", "operatorTimeIntervals", "operatorTemplate"]) expect(main).toContain(`${fn}(`);
      // The contact point reads a Secret, so its receivers come from a module naming it.
      const receivers = imported.files["grafana-contact-point-oncall/receivers.ts"];
      expect(receivers).toContain("operatorReceivers(");
      expect(receivers).toContain('"grafana-secrets"');
      expect(imported.files["grafana-contact-point-oncall/notifications.ts"]).toContain("${SLACK_URL}");
      expect(imported.files["grafana-rule-group-alerts-errors/alert-rules.ts"]).toContain("new AlertRuleGroup(");
      expect(imported.files["grafana-notification-policy/notifications.ts"]).toContain("new NotificationPolicy(");
      expect(imported.result.warnings.join("\n")).toContain('rule group "errors"');

      const result = await build(imported.srcDir, [k8sSerializer, grafanaSerializer]);
      expect(result.errors).toEqual([]);

      const output = (loadAll(primary(result.outputs.get("k8s"))) as Json[]).filter((d) => d);
      for (const kind of KINDS) expect(find(output, kind)).toEqual(find(input, kind));

      // The declarations build the alerting file the source declares.
      const expected = buildGrafana(entities as never).alerting!;
      const groups = (expected.groups ?? []).map((g) => ({ ...g, folder: "grafana-folder-alerts" }));
      const text = (result.outputs.get("grafana") as SerializerResult | undefined)?.files?.[ALERTING_FILE];
      expect(text).toBeDefined();
      expect(normalizeAlerting(load(text!) as Json)).toEqual(normalizeAlerting({ ...expected, groups } as unknown as Json));
    } finally {
      removeDir(imported.dir);
    }
  });

  test("a policy route is imported as a declaration and builds back to the same resource, its policy kept as written", async () => {
    const yaml = manifest(true);
    const input = (loadAll(yaml) as Json[]).filter((d) => d);
    const route = find(input, "GrafanaNotificationPolicyRoute");

    const imported = await importManifest(yaml);
    try {
      expect(imported.result.error).toBeUndefined();
      expect(imported.result.success).toBe(true);
      expect(imported.files["other.ts"]).toContain("operatorRouteSpec(");
      expect(imported.files["grafana-notification-policy-route-1/notifications.ts"]).toContain("new NotificationPolicy(");

      const result = await build(imported.srcDir, [k8sSerializer, grafanaSerializer]);
      expect(result.errors).toEqual([]);
      const output = (loadAll(primary(result.outputs.get("k8s"))) as Json[]).filter((d) => d);
      expect(find(output, "GrafanaNotificationPolicyRoute")).toEqual(route);
      expect(find(output, "GrafanaNotificationPolicy")).toEqual(find(input, "GrafanaNotificationPolicy"));
    } finally {
      removeDir(imported.dir);
    }
  });
});
