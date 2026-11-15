/**
 * An AlertmanagerConfig through `chant import` (#5113): `spec.route`,
 * `spec.receivers`, `spec.inhibitRules` and `spec.muteTimeIntervals` are
 * imported by the prometheus lexicon as typed `Route`, `Receiver`,
 * `InhibitRule` and `TimeInterval` declarations, and `chant build` gives back
 * the same object.
 *
 * The fixture (testdata/embedded/alertmanagerconfig.yaml, written for this
 * test in the shape of the operator's own examples) has a Slack receiver whose
 * `apiURL` is a Secret reference, a nested route with one matcher of each
 * `matchType`, a PagerDuty receiver whose `routingKey` is a Secret reference,
 * a webhook whose `httpConfig` has no declaration, an inhibit rule and a mute
 * time interval.
 */

import { describe, expect, test } from "vitest";
import { join } from "path";
import { loadAll } from "js-yaml";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { prometheusSerializer } from "@intentius/chant-lexicon-prometheus";
import { k8sSerializer } from "../serializer";
import { importManifest, read, removeDir } from "./testdata/embedded/fixtures";

type Json = Record<string, unknown>;

function primary(out: string | SerializerResult | undefined): string {
  if (out === undefined) return "";
  return typeof out === "string" ? out : out.primary;
}

function docs(yaml: string): Json[] {
  return (loadAll(yaml) as Json[]).filter((d) => d);
}

async function importAndBuild(yaml: string) {
  const imported = await importManifest(yaml);
  try {
    expect(imported.result.error).toBeUndefined();
    expect(imported.result.success).toBe(true);
    const result = await build(imported.srcDir, [k8sSerializer, prometheusSerializer]);
    const dirs = [...new Set(Object.keys(imported.files).filter((p) => p.includes("/")).map((p) => p.split("/")[0]))].sort();
    const lint: Record<string, number> = {};
    for (const dir of dirs) {
      const r = await lintCommand({ path: join(imported.srcDir, dir), format: "stylish" });
      lint[dir] = r.errorCount + r.warningCount;
      if (lint[dir] > 0) console.log(r.output);
    }
    return { ...imported, importResult: imported.result, result, built: docs(primary(result.outputs.get("k8s"))), lint, dirs };
  } finally {
    removeDir(imported.dir);
  }
}

describe("AlertmanagerConfig -> chant import -> chant build", () => {
  test("route, receivers, inhibit rules and time intervals become prometheus declarations and build back to the same object", async () => {
    const yaml = read("alertmanagerconfig.yaml");
    const out = await importAndBuild(yaml);
    expect(out.result.errors).toEqual([]);
    expect(out.built).toEqual(docs(yaml));

    expect(out.dirs).toEqual(["main-inhibit-rules", "main-mute-time-intervals", "main-receivers", "main-route"]);
    const main = out.files["main.ts"];
    expect(main).toContain('from "@intentius/chant-lexicon-prometheus/k8s"');
    expect(main).toContain("route: alertmanagerConfigRoute(declared.root)");
    expect(main).toContain("receivers: receivers,");
    expect(main).toContain("alertmanagerConfigInhibitRules(");
    expect(main).toContain("alertmanagerConfigMuteTimeIntervals(");

    // The routing tree is typed Alertmanager, one matcher of each matchType.
    const routes = out.files["main-route/routes.ts"];
    expect(routes).toContain("new Route(");
    expect(routes).toContain('matchers: [\'prometheus=""\']');
    for (const op of ['="critical"', '=~"db|infra"', '!="dev"', '!~"test-']) expect(routes).toContain(op);
    expect(routes).toContain("group_by: [\"alertname\", \"cluster\"]");
    expect(out.files["main-inhibit-rules/inhibit-rules.ts"]).toContain("new InhibitRule(");
    expect(out.files["main-mute-time-intervals/time-intervals.ts"]).toContain('days_of_month: ["1:5"]');

    // A Secret reference is carried, not read: the typed receivers hold no credential field, the reference sits in its own module.
    const receivers = out.files["main-receivers/receivers.ts"];
    expect(receivers).toContain("new Receiver(");
    expect(receivers).toContain("slack_configs");
    expect(receivers).not.toMatch(/api_url|routing_key|apiURL|routingKey/);
    const crd = out.files["main-receivers/crd-receivers.ts"];
    expect(crd).toContain('"name": "slack-alerts-token"');
    expect(crd).toContain('"key": "routing-key"');

    // Each field kept beside a declaration is named.
    const warnings = out.importResult.warnings;
    expect(warnings.some((w) => w.includes('receiver "slack": slackConfigs[0] keeps apiURL'))).toBe(true);
    expect(warnings.some((w) => w.includes('receiver "pager": pagerdutyConfigs[0] keeps routingKey'))).toBe(true);
    expect(warnings.some((w) => w.includes('receiver "pager": webhookConfigs[0] keeps httpConfig'))).toBe(true);
    expect(warnings).toHaveLength(3);

    // The declarations type the CRD's fields and are not exported one by one, so building the project does not also
    // write an alertmanager.yml from them (two AlertmanagerConfigs would be one file with two roots).
    expect(routes).toContain("export const declared = { root };");
    expect(routes).not.toMatch(/export \{/);
    expect(primary(out.result.outputs.get("prometheus"))).toBe("");
  });

  test("the generated declarations lint clean", async () => {
    const out = await importAndBuild(read("alertmanagerconfig.yaml"));
    expect(out.lint).toEqual({ "main-inhibit-rules": 0, "main-mute-time-intervals": 0, "main-receivers": 0, "main-route": 0 });
  });

  test("two AlertmanagerConfigs in one project each keep their own routing and build no alertmanager.yml", async () => {
    const one = read("alertmanagerconfig.yaml");
    const yaml = `${one}---\n${one.replace("name: main\n", "name: other\n")}`;
    const out = await importAndBuild(yaml);
    expect(out.result.errors).toEqual([]);
    expect(out.result.warnings).toEqual([]);
    expect(out.built).toEqual(docs(yaml));
    expect(primary(out.result.outputs.get("prometheus"))).toBe("");
    expect(out.dirs).toContain("other-route");
  });

  test("a route a declaration cannot hold stays as written, with a warning naming why, and the other fields are still imported", async () => {
    const yaml = read("alertmanagerconfig.yaml").replace("matchType: \"=~\"\n", "regex: true\n");
    expect(yaml).toContain("regex: true");
    const out = await importAndBuild(yaml);
    expect(out.result.errors).toEqual([]);
    expect(out.built).toEqual(docs(yaml));
    expect(out.dirs).toEqual(["main-inhibit-rules", "main-mute-time-intervals", "main-receivers"]);
    expect(out.files["main.ts"]).toContain("route: {");
    expect(out.files["main.ts"]).toContain("regex: true");
    expect(out.files["main.ts"]).not.toContain("alertmanagerConfigRoute");
    const warning = out.importResult.warnings.find((w) => w.includes("spec.route"));
    expect(warning).toContain("AlertmanagerConfig main spec.route");
    expect(warning).toContain("kept as written");
    expect(warning).toContain("spec.route.routes[0].matchers[1] is not a matcher a declaration can hold");
  });
});
