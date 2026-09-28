import { describe, expect, test } from "vitest";
import { matcherString, parsePrometheusYaml, PrometheusParser, RULE_FILE_RESOURCE_TYPE, ALERTMANAGER_RESOURCE_TYPE } from "./parser";

const lines = (...l: string[]) => `${l.join("\n")}\n`;

describe("parsePrometheusYaml", () => {
  test("tells a rule file from an alertmanager.yml", () => {
    expect(parsePrometheusYaml("groups:\n  - name: a\n    rules: []\n").kind).toBe("rules");
    expect(parsePrometheusYaml("route:\n  receiver: x\nreceivers:\n  - name: x\n").kind).toBe("alertmanager");
    expect(parsePrometheusYaml("receivers:\n  - name: x\n").kind).toBe("alertmanager");
  });

  test("rejects a document that is neither, and one that is not a mapping", () => {
    expect(() => parsePrometheusYaml("receivers:\n  otlp: {}\n")).toThrow(/neither a Prometheus rule file/);
    expect(() => parsePrometheusYaml("- a\n- b\n")).toThrow(/YAML mapping/);
    expect(() => parsePrometheusYaml("")).toThrow(/neither/);
  });

  test("a rule's values are strings, label values included, and a group's limit a number", () => {
    const parsed = parsePrometheusYaml(
      lines("groups:", "  - name: g", "    limit: 5", "    labels: { tier: 1 }", "    rules:", "      - record: a:b", "        expr: 1", "        labels: { on: true }"),
    );
    if (parsed.kind !== "rules") throw new Error("expected a rule file");
    expect(parsed.file.groups[0]).toEqual({ name: "g", limit: 5, labels: { tier: "1" }, rules: [{ record: "a:b", expr: "1", labels: { on: "true" } }] });
    expect(parsed.warnings).toEqual([]);
  });

  test("names the rule file fields it does not carry", () => {
    const parsed = parsePrometheusYaml(
      lines("groups:", "  - name: g", "    source_tenants: [a]", "    rules:", "      - alert: A", "        expr: up == 0", "        severity: page", "namespace: x"),
    );
    expect(parsed.warnings).toEqual([
      'top-level key "namespace" is not part of a rule file; it is not carried',
      'group "g": "source_tenants" is not a rule group field; it is not carried',
      'group "g" rules[0].severity is not a rule field; it is not carried',
    ]);
  });

  test("route and inhibit rule match maps become matchers, with quotes and backslashes escaped", () => {
    const parsed = parsePrometheusYaml(
      lines(
        "route:",
        "  receiver: x",
        "  match: { team: 'a\"b' }",
        "  match_re: { service: '^api\\.v[0-9]+$' }",
        "  matchers: ['env=\"prod\"']",
        "inhibit_rules:",
        "  - source_match: { severity: page }",
        "    target_match_re: { severity: 'ticket|info' }",
        "receivers:",
        "  - name: x",
      ),
    );
    if (parsed.kind !== "alertmanager") throw new Error("expected alertmanager.yml");
    expect(parsed.config.route?.matchers).toEqual(['env="prod"', 'team="a\\"b"', 'service=~"^api\\\\.v[0-9]+$"']);
    expect(parsed.config.inhibit_rules).toEqual([{ source_matchers: ['severity="page"'], target_matchers: ['severity=~"ticket|info"'] }]);
    expect(parsed.warnings).toHaveLength(3);
  });

  test("the top-level mute_time_intervals join time_intervals, and unknown sections are named", () => {
    const parsed = parsePrometheusYaml(
      lines(
        "receivers: [{ name: x }]",
        "time_intervals: [{ name: a, time_intervals: [{ weekdays: [monday] }] }]",
        "mute_time_intervals: [{ name: b, time_intervals: [{ weekdays: [sunday] }] }]",
        "event_recorder: { enabled: true }",
      ),
    );
    if (parsed.kind !== "alertmanager") throw new Error("expected alertmanager.yml");
    expect(parsed.config.time_intervals?.map((t) => t.name)).toEqual(["a", "b"]);
    expect(parsed.warnings).toEqual([
      'top-level section "event_recorder" is not one chant declares; it is not carried',
      "the top-level mute_time_intervals (b) are declared as TimeIntervals and written under time_intervals, which Alertmanager reads the same way",
    ]);
  });

  test("receivers are carried whole, merge keys resolved, templates and *_file values as written", () => {
    const parsed = parsePrometheusYaml(
      lines(
        "receivers:",
        "  - name: chat",
        "    slack_configs:",
        "      - &base { api_url_file: /s/url, title: '{{ .CommonLabels.alertname }}' }",
        "      - { <<: *base, channel: '#b' }",
        "    opsgenie_configs: [{ api_key: literal }]",
      ),
    );
    if (parsed.kind !== "alertmanager") throw new Error("expected alertmanager.yml");
    expect(parsed.config.receivers).toEqual([
      {
        name: "chat",
        slack_configs: [
          { api_url_file: "/s/url", title: "{{ .CommonLabels.alertname }}" },
          { api_url_file: "/s/url", title: "{{ .CommonLabels.alertname }}", channel: "#b" },
        ],
        opsgenie_configs: [{ api_key: "literal" }],
      },
    ]);
  });

  test("dates and times stay strings, as the Go loaders read them", () => {
    const parsed = parsePrometheusYaml(lines("receivers: [{ name: x }]", "time_intervals: [{ name: t, time_intervals: [{ years: [2026-01-01] }] }]"));
    if (parsed.kind !== "alertmanager") throw new Error("expected alertmanager.yml");
    expect(parsed.config.time_intervals?.[0].time_intervals[0].years).toEqual(["2026-01-01"]);
  });
});

describe("PrometheusParser", () => {
  test("carries the whole file as one IR resource", () => {
    const rules = new PrometheusParser().parse("groups:\n  - name: a\n    rules: []\n");
    expect(rules.resources).toEqual([{ logicalId: "ruleFile", type: RULE_FILE_RESOURCE_TYPE, properties: { file: { groups: [{ name: "a", rules: [] }] } } }]);
    const am = new PrometheusParser().parse("receivers:\n  - name: x\n");
    expect(am.resources.map((r) => r.type)).toEqual([ALERTMANAGER_RESOURCE_TYPE]);
  });
});

test("matcherString escapes the value the way Alertmanager's matcher parser reads it", () => {
  expect(matcherString("a", "=", 'x"y\\z')).toBe('a="x\\"y\\\\z"');
  expect(matcherString("a", "=~", "line\nbreak")).toBe('a=~"line\\nbreak"');
});
