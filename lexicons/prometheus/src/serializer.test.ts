import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { prometheusSerializer, ALERTMANAGER_FILE } from "./serializer";
import { AlertmanagerSettings, InhibitRule, Receiver, Route, RuleGroup, TimeInterval } from "./index";
import type { AlertmanagerConfig, RuleFileConfig } from "./model";
import type { SerializerResult } from "@intentius/chant/serializer";

function entities(record: Record<string, unknown>): Map<string, Declarable> {
  return new Map(Object.entries(record) as Array<[string, Declarable]>);
}

function primary(out: ReturnType<typeof prometheusSerializer.serialize>): string {
  return typeof out === "string" ? out : out.primary;
}

const api = () =>
  new RuleGroup({
    name: "api",
    interval: "30s",
    rules: [
      { record: "job:http_requests:rate5m", expr: "sum by (job) (rate(http_requests_total[5m]))" },
      { alert: "ApiDown", expr: 'up{job="api"} == 0', for: "5m", labels: { severity: "page" }, annotations: { summary: "api is down" } },
    ],
  });

describe("prometheus serializer", () => {
  // 1, 2
  test("name and rule prefix", () => {
    expect(prometheusSerializer.name).toBe("prometheus");
    expect(prometheusSerializer.rulePrefix).toBe("PROM");
  });

  // 3
  test("an empty map serializes to the empty string", () => {
    expect(prometheusSerializer.serialize(new Map())).toBe("");
  });

  // 4
  test("one rule group is a rule file", () => {
    expect(prometheusSerializer.serialize(entities({ api: api() }))).toBe(`groups:
  - name: api
    interval: 30s
    rules:
      - record: job:http_requests:rate5m
        expr: sum by (job) (rate(http_requests_total[5m]))
      - alert: ApiDown
        expr: up{job="api"} == 0
        for: 5m
        labels:
          severity: page
        annotations:
          summary: api is down
`);
  });

  // 5, 6: the export name never appears; the group's own name is used
  test("the group name comes from props, not the export name", () => {
    const out = primary(prometheusSerializer.serialize(entities({ someExportName: api() })));
    expect(out).not.toContain("someExportName");
    expect((load(out) as RuleFileConfig).groups[0].name).toBe("api");
  });

  // 7
  test("several groups come out sorted by name", () => {
    const b = new RuleGroup({ name: "b", rules: [{ record: "b:x", expr: "1" }] });
    const a = new RuleGroup({ name: "a", rules: [{ record: "a:x", expr: "1" }] });
    const file = load(primary(prometheusSerializer.serialize(entities({ b, a })))) as RuleFileConfig;
    expect(file.groups.map((g) => g.name)).toEqual(["a", "b"]);
  });

  // 8, 9: nothing is injected; what is set is what comes out
  test("nothing is defaulted in", () => {
    const g = new RuleGroup({ name: "g", rules: [{ alert: "A", expr: "vector(1)" }] });
    expect(load(primary(prometheusSerializer.serialize(entities({ g }))))).toEqual({
      groups: [{ name: "g", rules: [{ alert: "A", expr: "vector(1)" }] }],
    });
  });

  // 10: non-prometheus entities are ignored
  test("entities from other lexicons are skipped", () => {
    const foreign = { lexicon: "k8s", entityType: "K8s::Core::ConfigMap", kind: "resource", props: {} };
    expect(prometheusSerializer.serialize(entities({ foreign }))).toBe("");
  });

  // 11
  test("keys come out in rule-file order whatever order they were written in", () => {
    const g = new RuleGroup({
      rules: [{ annotations: { summary: "s" }, labels: { severity: "page" }, for: "1m", expr: "up == 0", alert: "A" }],
      interval: "1m",
      name: "g",
    } as never);
    const text = primary(prometheusSerializer.serialize(entities({ g })));
    expect(text.indexOf("name: g")).toBeLessThan(text.indexOf("interval"));
    const rule = text.slice(text.indexOf("- alert"));
    const order = ["alert", "expr", "for", "labels", "annotations"].map((k) => rule.indexOf(`${k}:`));
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  // 12: format-specific
  describe("alertmanager.yml", () => {
    const hook = () => new Receiver({ name: "hook", webhook_configs: [{ url: "http://hook:8080/" }] });

    test("alone, it is the primary output", () => {
      const h = hook();
      const root = new Route({ receiver: h, group_by: ["alertname"] });
      const out = prometheusSerializer.serialize(entities({ h, root }));
      expect(typeof out).toBe("string");
      expect(load(out as string)).toEqual({
        route: { receiver: "hook", group_by: ["alertname"] },
        receivers: [{ name: "hook", webhook_configs: [{ url: "http://hook:8080/" }] }],
      });
    });

    test("beside a rule file, it is written as alertmanager.yml", () => {
      const h = hook();
      const out = prometheusSerializer.serialize(entities({ api: api(), h, root: new Route({ receiver: h }) })) as SerializerResult;
      expect((load(out.primary) as RuleFileConfig).groups).toHaveLength(1);
      expect(Object.keys(out.files ?? {})).toEqual([ALERTMANAGER_FILE]);
      expect((load(out.files![ALERTMANAGER_FILE]) as AlertmanagerConfig).route?.receiver).toBe("hook");
    });

    test("sections come out in Alertmanager's order, references by name", () => {
      const h = hook();
      const quiet = new TimeInterval({ name: "weekend", time_intervals: [{ weekdays: ["saturday", "sunday"] }] });
      const out = primary(
        prometheusSerializer.serialize(
          entities({
            quiet,
            inhibit: new InhibitRule({ source_matchers: ['severity="page"'], target_matchers: ['severity="ticket"'], equal: ["alertname"] }),
            h,
            root: new Route({ receiver: h, routes: [{ matchers: ['severity="ticket"'], receiver: "hook", mute_time_intervals: [quiet] }] }),
            settings: new AlertmanagerSettings({ global: { resolve_timeout: "5m" }, templates: ["/etc/am/*.tmpl"] }),
          }),
        ),
      );
      const keys = Object.keys(load(out) as object);
      expect(keys).toEqual(["global", "templates", "route", "inhibit_rules", "receivers", "time_intervals"]);
      expect((load(out) as AlertmanagerConfig).route?.routes?.[0].mute_time_intervals).toEqual(["weekend"]);
    });

    test("a receiver or interval reached only through a route is still emitted", () => {
      const h = hook();
      const quiet = new TimeInterval({ name: "night", time_intervals: [{ times: [{ start_time: "22:00", end_time: "24:00" }] }] });
      const out = load(primary(prometheusSerializer.serialize(entities({ root: new Route({ receiver: h, mute_time_intervals: [quiet] }) })))) as AlertmanagerConfig;
      expect(out.receivers?.map((r) => r.name)).toEqual(["hook"]);
      expect(out.time_intervals?.map((t) => t.name)).toEqual(["night"]);
    });

    test("a child Route entity is not a second root", () => {
      const h = hook();
      const child = new Route({ matchers: ['severity="page"'], receiver: h });
      const out = prometheusSerializer.serialize(entities({ h, child, root: new Route({ receiver: h, routes: [child] }) }));
      expect(typeof out).toBe("string");
      expect((load(out as string) as AlertmanagerConfig).route?.routes).toHaveLength(1);
    });

    test("two roots warn and the first wins", () => {
      const h = hook();
      const out = prometheusSerializer.serialize(entities({ h, a: new Route({ receiver: h }), b: new Route({ receiver: "other" }) })) as SerializerResult;
      expect(out.warnings?.[0]).toContain("2 root Routes");
      expect((load(out.primary) as AlertmanagerConfig).route?.receiver).toBe("hook");
    });
  });

  test("round-trip: the rule file parses back to the declared group", () => {
    const g = api();
    const file = load(primary(prometheusSerializer.serialize(entities({ g })))) as RuleFileConfig;
    expect(file.groups[0]).toEqual(g.props);
  });

  test("a multi-line expr survives as a block scalar", () => {
    const expr = "sum(rate(a[5m]))\n  /\nsum(rate(b[5m]))";
    const g = new RuleGroup({ name: "g", rules: [{ record: "a:ratio", expr }] });
    const text = primary(prometheusSerializer.serialize(entities({ g })));
    expect(text).toContain("expr: |-");
    expect((load(text) as RuleFileConfig).groups[0].rules[0].expr).toBe(expr);
  });
});
