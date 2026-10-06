import { describe, expect, test } from "vitest";
import type { EmbeddedContent } from "@intentius/chant/import/embedded";
import { grafanaPlugin } from "../plugin";
import { operatorContactPoint, operatorPolicyRoute, operatorRouteSpec, operatorRule } from "../k8s";
import { operatorImporter, provisionedReceivers, provisionedRoute, provisionedRule } from "./operator";

const site = (hostType: string, select: string, spec: Record<string, unknown>): EmbeddedContent => ({
  host: "k8s",
  hostType,
  location: `${hostType.split("::").pop()} x spec.${select}`,
  directory: "x",
  document: spec,
  select,
  labels: {},
});

const SELECTOR = { matchLabels: { dashboards: "grafana" } };

describe("Grafana Operator alerting embedded in a k8s manifest (#3538)", () => {
  test("the plugin registers the importer", () => {
    expect(grafanaPlugin.embeddedImporters?.()).toContain(operatorImporter);
  });

  test("matches the five kinds at their own field, and nothing else", () => {
    expect(operatorImporter.matches(site("K8s::Grafana::GrafanaAlertRuleGroup", "rules", { rules: [] }))).toBe(true);
    expect(operatorImporter.matches(site("K8s::Grafana::GrafanaContactPoint", "receivers", { receivers: [] }))).toBe(true);
    expect(operatorImporter.matches(site("K8s::Grafana::GrafanaNotificationPolicy", "route", { route: {} }))).toBe(true);
    expect(operatorImporter.matches(site("K8s::Grafana::GrafanaNotificationPolicyRoute", "route", { route: { receiver: "r" } }))).toBe(true);
    expect(operatorImporter.matches(site("K8s::Grafana::GrafanaMuteTiming", "time_intervals", { time_intervals: [] }))).toBe(true);
    expect(operatorImporter.matches(site("K8s::Grafana::GrafanaNotificationTemplate", "template", { template: "x" }))).toBe(true);
    expect(operatorImporter.matches(site("K8s::Grafana::GrafanaAlertRuleGroup", "receivers", {}))).toBe(false);
    expect(operatorImporter.matches(site("K8s::Core::ConfigMap", "rules", { rules: [] }))).toBe(false);
  });

  describe("a rule", () => {
    test("goes back to the file's spelling, without the values the CRD requires and Grafana defaults", () => {
      expect(
        provisionedRule({
          uid: "r",
          title: "R",
          condition: "A",
          data: [],
          for: "0s",
          noDataState: "NoData",
          execErrState: "Alerting",
          missingSeriesEvalsToResolve: 3,
          notificationSettings: { receiver: "oncall", group_by: ["a"] },
          annotations: { __dashboardUid__: "dash", __panelId__: "2", summary: "s" },
        }),
      ).toEqual({
        uid: "r",
        title: "R",
        condition: "A",
        data: [],
        missing_series_evals_to_resolve: 3,
        notification_settings: { receiver: "oncall", group_by: ["a"] },
        dashboardUid: "dash",
        panelId: 2,
        annotations: { summary: "s" },
      });
    });

    test("keeps values that are not the defaults, and a record rule's condition is the rule's own", () => {
      const back = provisionedRule({ uid: "r", title: "R", condition: "B", data: [], for: "5m", noDataState: "Alerting", execErrState: "Error" });
      expect(back).toMatchObject({ for: "5m", noDataState: "Alerting", execErrState: "Error", condition: "B" });
      expect(provisionedRule({ uid: "r", title: "R", condition: "A", data: [], record: { metric: "m", from: "A" } })).not.toHaveProperty("condition");
    });

    test("is the inverse of operatorRule", () => {
      const rule = {
        uid: "r",
        title: "R",
        condition: "A",
        data: [],
        for: "5m",
        labels: { severity: "page" },
        dashboardUid: "dash",
        panelId: 4,
        annotations: { summary: "s" },
        missing_series_evals_to_resolve: 2,
        notification_settings: { receiver: "oncall" },
      };
      expect(provisionedRule(operatorRule(rule))).toEqual(rule);
    });
  });

  describe("a receiver", () => {
    test("reads each valuesFrom entry back as ${NAME} at its path, and names the Secret", () => {
      const forward = operatorContactPoint(
        { name: "oncall", receivers: [{ uid: "u", type: "slack", settings: { title: "t", url: "${SLACK_URL}", tlsConfig: { clientKey: "$KEY" } } }] },
        "grafana-secrets",
      );
      const back = provisionedReceivers(forward.receivers as unknown[], "contact point");
      expect(back.secretName).toBe("grafana-secrets");
      expect(back.receivers).toEqual([{ uid: "u", type: "slack", settings: { title: "t", url: "${SLACK_URL}", tlsConfig: { clientKey: "${KEY}" } } }]);
    });

    test("without valuesFrom there is no Secret", () => {
      expect(provisionedReceivers([{ uid: "m", type: "email", settings: { addresses: "a@example.com" } }], "cp")).toEqual({
        receivers: [{ uid: "m", type: "email", settings: { addresses: "a@example.com" } }],
      });
    });

    test("refuses what a ${NAME} reference cannot say", () => {
      const from = (valueFrom: unknown, name = "s") => [{ type: "x", settings: {}, valuesFrom: [{ targetPath: "url", valueFrom }, { targetPath: "b", valueFrom: { secretKeyRef: { name, key: "B" } } }] }];
      expect(() => provisionedReceivers(from({ configMapKeyRef: { name: "c", key: "K" } }), "cp")).toThrow(/secretKeyRef/);
      expect(() => provisionedReceivers(from({ secretKeyRef: { name: "s", key: "not-a-name" } }), "cp")).toThrow(/secretKeyRef/);
      expect(() => provisionedReceivers(from({ secretKeyRef: { name: "one", key: "A" } }, "two"), "cp")).toThrow(/one secretName/);
    });
  });

  describe("the policy tree", () => {
    test("object_matchers go back to matchers in every nested route", () => {
      const route = operatorPolicyRoute({
        receiver: "oncall",
        routes: [{ receiver: "tickets", matchers: ['severity="ticket"', "team=~a|b"], routes: [{ matchers: ["env!=dev"] }] }],
      });
      expect(provisionedRoute(route)).toEqual({
        receiver: "oncall",
        routes: [{ receiver: "tickets", matchers: ['severity="ticket"', 'team=~"a|b"'], routes: [{ matchers: ['env!="dev"'] }] }],
      });
    });

    test("a matcher that cannot be written as a string keeps them all as objects", () => {
      const objects = [
        ["a", "=", "x"],
        ["b", "=", 'say "hi"'],
      ];
      expect(provisionedRoute({ receiver: "r", object_matchers: objects })).toEqual({ receiver: "r", object_matchers: objects });
    });
  });

  describe("import", () => {
    test("a rule group becomes an AlertRuleGroup, read through operatorRules, with a warning about its folder", () => {
      const spec = {
        instanceSelector: SELECTOR,
        name: "errors",
        folderRef: "grafana-folder-alerts",
        interval: "30s",
        rules: [
          {
            uid: "high-errors",
            title: "High errors",
            condition: "A",
            for: "5m",
            noDataState: "NoData",
            execErrState: "Alerting",
            data: [{ refId: "A", relativeTimeRange: { from: 600, to: 0 }, datasourceUid: "prom", model: { refId: "A", expr: "up", datasource: { type: "prometheus", uid: "prom" } } }],
          },
        ],
      };
      const out = operatorImporter.import(site("K8s::Grafana::GrafanaAlertRuleGroup", "rules", spec));
      expect(out.value.shape).toBe("single");
      expect(out.value.through).toEqual({ from: "@intentius/chant-lexicon-grafana/k8s", name: "operatorRules" });
      const [binding] = out.value.bindings;
      expect(out.files.find((f) => f.path === binding.from)?.content).toContain(`const ${binding.name} = new AlertRuleGroup(`);
      const text = out.files.map((f) => f.content).join("\n");
      expect(text).toContain('folder: "grafana-folder-alerts"');
      expect(text).toContain("new AlertRule(");
      expect(out.warnings?.join("\n")).toContain('rule group "errors": a declaration\'s folder is a title');
    });

    test("a contact point that reads a Secret gets a module naming it", () => {
      const spec = {
        instanceSelector: SELECTOR,
        name: "oncall",
        receivers: [
          {
            uid: "oncall-slack",
            type: "slack",
            settings: { title: "chant" },
            valuesFrom: [{ targetPath: "url", valueFrom: { secretKeyRef: { name: "grafana-secrets", key: "SLACK_URL" } } }],
          },
        ],
      };
      const out = operatorImporter.import(site("K8s::Grafana::GrafanaContactPoint", "receivers", spec));
      expect(out.value.through).toBeUndefined();
      const [binding] = out.value.bindings;
      expect(binding).toEqual({ from: "receivers.ts", name: "receivers" });
      const module = out.files.find((f) => f.path === "receivers.ts")!.content;
      expect(module).toContain('import { operatorReceivers } from "@intentius/chant-lexicon-grafana/k8s";');
      expect(module).toContain('"grafana-secrets"');
      expect(out.files.map((f) => f.content).join("\n")).toContain("${SLACK_URL}");
    });

    test("a contact point with no Secret is read through operatorReceivers alone", () => {
      const spec = { name: "mail", receivers: [{ uid: "m", type: "email", settings: { addresses: "a@example.com" } }] };
      const out = operatorImporter.import(site("K8s::Grafana::GrafanaContactPoint", "receivers", spec));
      expect(out.value.through).toEqual({ from: "@intentius/chant-lexicon-grafana/k8s", name: "operatorReceivers" });
      expect(out.files.some((f) => f.path === "receivers.ts")).toBe(false);
    });

    test("a policy, a mute timing and a template", () => {
      const policy = operatorImporter.import(site("K8s::Grafana::GrafanaNotificationPolicy", "route", { route: { receiver: "oncall", routes: [{ object_matchers: [["severity", "=", "page"]] }] } }));
      expect(policy.value.through?.name).toBe("operatorPolicy");
      const text = policy.files.map((f) => f.content).join("\n");
      expect(text).toContain("new NotificationPolicy(");
      expect(text).toContain('severity="page"');

      const mute = operatorImporter.import(site("K8s::Grafana::GrafanaMuteTiming", "time_intervals", { name: "weekends", time_intervals: [{ weekdays: ["saturday", "sunday"] }] }));
      expect(mute.value.through?.name).toBe("operatorTimeIntervals");
      expect(mute.files.map((f) => f.content).join("\n")).toContain("new MuteTiming(");

      const template = operatorImporter.import(site("K8s::Grafana::GrafanaNotificationTemplate", "template", { name: "t", template: '{{ define "t" }}x{{ end }}' }));
      expect(template.value.through?.name).toBe("operatorTemplate");
      expect(template.files.map((f) => f.content).join("\n")).toContain("new NotificationTemplate(");
    });

    test("a policy route is read as the child of a policy and written back through operatorRouteSpec", () => {
      const spec = { receiver: "tickets", object_matchers: [["severity", "=", "ticket"]], mute_time_intervals: ["weekends"], routes: [{ object_matchers: [["team", "=", "a"]] }] };
      const out = operatorImporter.import(site("K8s::Grafana::GrafanaNotificationPolicyRoute", "route", { route: spec }));
      expect(out.value.through).toEqual({ from: "@intentius/chant-lexicon-grafana/k8s", name: "operatorRouteSpec" });
      const text = out.files.map((f) => f.content).join("\n");
      expect(text).toContain("new NotificationPolicy(");
      expect(text).toContain('severity="ticket"');
      expect(text).toContain('team="a"');
    });

    test("a policy route's routeSelector is left out with a warning, and a route with no receiver throws", () => {
      const out = operatorImporter.import(site("K8s::Grafana::GrafanaNotificationPolicyRoute", "route", { route: { receiver: "r", routeSelector: { matchLabels: { a: "b" } } } }));
      expect((out.warnings ?? []).join("\n")).toContain("routeSelector");
      expect(() => operatorImporter.import(site("K8s::Grafana::GrafanaNotificationPolicyRoute", "route", { route: { matchers: [] } }))).toThrow(/spec.receiver/);
    });

    test("a policy that selects routes by label throws so the host keeps it as written", () => {
      const route = { receiver: "oncall", routeSelector: { matchLabels: { a: "b" } } };
      expect(() => operatorImporter.import(site("K8s::Grafana::GrafanaNotificationPolicy", "route", { route }))).toThrow(/routeSelector/);
    });

    test("a policy with no receiver, and a group with no folder, throw so the host keeps them as written", () => {
      expect(() => operatorImporter.import(site("K8s::Grafana::GrafanaNotificationPolicy", "route", { route: { group_by: ["a"] } }))).toThrow();
      expect(() => operatorImporter.import(site("K8s::Grafana::GrafanaAlertRuleGroup", "rules", { name: "g", rules: [] }))).toThrow(/names no folder/);
    });
  });
});
