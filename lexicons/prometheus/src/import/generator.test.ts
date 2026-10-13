import { describe, expect, test } from "vitest";
import type { AlertmanagerConfig, RuleGroupConfig } from "../model";
import { generateAlertmanagerFiles, generateRuleFileFiles, PrometheusGenerator, tsLiteral } from "./generator";

const byPath = (files: Array<{ path: string; content: string }>) => Object.fromEntries(files.map((f) => [f.path, f.content]));

describe("rule files", () => {
  test("a group is a Rule[] const of plain objects and a RuleGroup, exported by list", () => {
    const files = byPath(
      generateRuleFileFiles({
        groups: [{ name: "api-slo", interval: "30s", labels: { team: "api" }, rules: [{ record: "a:b", expr: "sum(x)" }] }],
      }),
    );
    expect(files["rules.ts"]).toBe(
      [
        "/** Rule groups */",
        'import { type LabelSet, type Rule, RuleGroup } from "@intentius/chant-lexicon-prometheus";',
        "",
        'const apiSloLabels: LabelSet = { team: "api" };',
        'const apiSloRules: Rule[] = [{ record: "a:b", expr: "sum(x)" }];',
        "const apiSlo = new RuleGroup({",
        '  name: "api-slo",',
        '  interval: "30s",',
        "  labels: apiSloLabels,",
        "  rules: apiSloRules,",
        "});",
        "",
        "export { apiSlo };",
        "",
      ].join("\n"),
    );
  });

  test("more than eight groups are split across files, the limit COR009 sets", () => {
    const groups: RuleGroupConfig[] = Array.from({ length: 10 }, (_, i) => ({ name: `g${i}`, rules: [] }));
    const files = generateRuleFileFiles({ groups });
    expect(files.map((f) => f.path)).toEqual(["rules-1.ts", "rules-2.ts"]);
    expect(files[0].content).toContain("export { g0, g1, g2, g3, g4, g5, g6, g7 };");
    expect(files[1].content).toContain("export { g8, g9 };");
  });

  test("names that clash or are not identifiers get a suffix", () => {
    const files = byPath(
      generateRuleFileFiles({
        groups: [
          { name: "default", rules: [] },
          { name: "2xx", rules: [] },
          { name: "Slo", rules: [] },
          { name: "a.b", rules: [] },
          { name: "a-b", rules: [] },
        ],
      }),
    );
    expect(files["rules.ts"]).toContain("export { defaultGroup, group2xx, slo, aB, aBGroup };");
  });
});

describe("alertmanager.yml", () => {
  const config: AlertmanagerConfig = {
    route: {
      receiver: "fallback",
      routes: [
        { receiver: "pager", matchers: ['severity="page"'], mute_time_intervals: ["nights", "undeclared"] },
        { receiver: "elsewhere" },
      ],
    },
    receivers: [
      { name: "fallback" },
      { name: "pager", pagerduty_configs: [{ routing_key_file: "/k" }] },
    ],
    time_intervals: [{ name: "nights", time_intervals: [{ times: [{ start_time: "00:00", end_time: "06:00" }] }] }],
  };

  test("routes reference receivers and time intervals by variable; names nothing declares stay strings", () => {
    const files = byPath(generateAlertmanagerFiles(config));
    expect(Object.keys(files)).toEqual(["receivers.ts", "time-intervals.ts", "routes.ts"]);
    expect(files["routes.ts"]).toContain('import { fallback, pager } from "./receivers";');
    expect(files["routes.ts"]).toContain('import { nights } from "./time-intervals";');
    expect(files["routes.ts"]).toContain('mute_time_intervals: [nights, "undeclared"]');
    expect(files["routes.ts"]).toContain('{ receiver: "elsewhere" }');
    expect(files["routes.ts"]).toContain("const root = new Route({ receiver: fallback, routes: rootChildren });");
  });

  test("every integration Alertmanager defines is declared with its type", () => {
    const files = byPath(
      generateAlertmanagerFiles({
        receivers: [{ name: "ops", opsgenie_configs: [{ api_key_file: "/k", priority: "P1" }], msteamsv2_configs: [{ webhook_url_file: "/t" }] }],
      }),
    );
    expect(files["receivers.ts"]).toContain('const opsOpsgenie: OpsGenieConfig[] = [{ api_key_file: "/k", priority: "P1" }];');
    expect(files["receivers.ts"]).toContain('const opsMsteamsv2: MSTeamsV2Config[] = [{ webhook_url_file: "/t" }];');
    expect(files["receivers.ts"]).not.toContain("Untyped");
  });

  test("a receiver or global key Alertmanager doesn't define is spread in from an untyped const, with a comment", () => {
    const files = byPath(
      generateAlertmanagerFiles({
        global: { resolve_timeout: "5m", pigeon_loft: "roof" } as never,
        receivers: [{ name: "ops", pigeon_configs: [{ loft: "roof" }] } as never],
      }),
    );
    expect(files["receivers.ts"]).toContain(
      [
        '// Receiver "ops": pigeon_configs is not a field Alertmanager v0.34.1 defines, so it is carried as',
        "// data, untyped.",
        'const opsUntyped = { pigeon_configs: [{ loft: "roof" }] };',
        'const ops = new Receiver({ name: "ops", ...opsUntyped });',
      ].join("\n"),
    );
    expect(files["settings.ts"]).toContain("// global: pigeon_loft is not a field Alertmanager v0.34.1 defines");
    expect(files["settings.ts"]).toContain("...globalUntyped,");
  });
});

describe("tsLiteral", () => {
  test("multi-line strings are template literals with backticks, backslashes and ${ escaped", () => {
    expect(tsLiteral("a\n`b` \\d ${x}", 0)).toBe("`a\n\\`b\\` \\\\d \\${x}`");
  });

  test("a string with double quotes is single-quoted, and keys that are not identifiers are quoted", () => {
    expect(tsLiteral({ "a-b": 'x="1"', continue: true }, 0)).toBe(`{ "a-b": 'x="1"', continue: true }`);
  });
});

test("PrometheusGenerator never hands core an empty file list", () => {
  expect(new PrometheusGenerator().generate({ resources: [], parameters: [] })).toHaveLength(1);
});

test("an Slo's variable leaves its member's name, <name>Rules, free", async () => {
  const { Slo } = await import("../composites/slo");
  const { ruleGroupConfig } = await import("../rules");
  const slo = ruleGroupConfig(
    Slo({ name: "checkout", objective: 0.99, window: "30d", sli: { errors: "sum(rate(e[{{window}}]))", total: "sum(rate(t[{{window}}]))" } }).rules,
  );
  const files = byPath(generateRuleFileFiles({ groups: [{ name: "checkout-rules", rules: [] }, slo] }));
  expect(files["slos.ts"]).toContain("const checkout = Slo({");
  expect(files["rules.ts"]).toContain("const checkoutRulesGroup = new RuleGroup(");
});
