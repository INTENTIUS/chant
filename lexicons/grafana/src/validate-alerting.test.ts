/**
 * GRAF111-GRAF114, and GRAF108 over alert rules: each check against
 * hand-written provisioning documents for the shapes the typed API cannot
 * produce, and through the post-synth checks over a build.
 */
import { describe, expect, test } from "vitest";
import { makePostSynthCtxFromFiles } from "@intentius/chant-test-utils";
import type { Declarable } from "@intentius/chant/declarable";
import { grafanaSerializer } from "./serializer";
import { Datasource, ExternalDatasource } from "./datasource";
import { PromQuery } from "./query";
import { AlertQuery, AlertRule, AlertRuleGroup, ContactPoint, MathExpression, MuteTiming, NotificationPolicy, ReduceExpression, ThresholdExpression } from "./alerting";
import { checkAlertingIdentity, checkNotificationRefs, checkRuleDatasources, checkRulePromql, checkRuleQueries, expressionInputs, type AlertingDoc } from "./validate-alerting";
import { knownDatasources } from "./datasource-refs";
import { graf108 } from "./lint/post-synth/graf108";
import { graf111 } from "./lint/post-synth/graf111";
import { graf112 } from "./lint/post-synth/graf112";
import { graf113 } from "./lint/post-synth/graf113";
import { graf114 } from "./lint/post-synth/graf114";

type Json = Record<string, unknown>;

const expr = (refId: string, model: Json): Json => ({ refId, datasourceUid: "__expr__", model: { refId, ...model } });
const prom = (refId: string, e: string): Json => ({ refId, datasourceUid: "prom", relativeTimeRange: { from: 600, to: 0 }, model: { refId, expr: e } });

function rule(extra: Json = {}): Json {
  return {
    uid: "r1",
    title: "Errors",
    condition: "C",
    data: [prom("A", "sum(up)"), expr("B", { type: "reduce", expression: "A", reducer: "last" }), expr("C", { type: "threshold", expression: "B", conditions: [{ evaluator: { type: "gt", params: [1] } }] })],
    ...extra,
  };
}

function doc(rules: Json[], extra: Json = {}): AlertingDoc[] {
  return [{ json: { apiVersion: 1, groups: [{ name: "g", folder: "F", interval: "1m", rules }], ...extra } }];
}

const PROM = knownDatasources([{ name: "Prometheus", type: "prometheus", uid: "prom" }]);

describe("GRAF111: a rule's queries and expressions fit together", () => {
  test("a well-formed rule, and a recording rule, pass", () => {
    const record = { uid: "r2", title: "rec", data: [prom("A", "sum(up)")], record: { metric: "up:sum", from: "A" } };
    expect(checkRuleQueries(doc([rule(), record]))).toEqual([]);
  });

  test("a condition, an expression input or record.from naming no refId is an error", () => {
    const messages = checkRuleQueries(
      doc([
        rule({ condition: "Z" }),
        rule({ uid: "r2", data: [prom("A", "up"), expr("B", { type: "math", expression: "$A + $Q" }), expr("C", { type: "reduce", expression: "C", reducer: "last" })] }),
        { uid: "r3", title: "rec", data: [prom("A", "up")], record: { metric: "m", from: "X" } },
        { uid: "r4", title: "none", data: [prom("A", "up")] },
      ]),
    ).map((i) => i.message);
    expect(messages).toEqual([
      expect.stringContaining('has condition "Z", which is not one of its refIds (A, B, C)'),
      expect.stringContaining('expression B reads "Q"'),
      expect.stringContaining("expression C reads its own result"),
      expect.stringContaining('records from "X"'),
      expect.stringContaining("has no condition"),
    ]);
  });

  test("duplicate refIds and expression models the schema rejects are errors", () => {
    const issues = checkRuleQueries(doc([rule({ data: [prom("A", "up"), prom("A", "up"), expr("C", { type: "reduce", expression: "A", reducer: "average" })] })]));
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining('two queries with refId "A"'),
      expect.stringContaining("expression C reducer must be equal to one of the allowed values: \"sum\", \"mean\""),
    ]);
  });

  test("the refIds each expression reads", () => {
    expect(expressionInputs({ type: "math", expression: "$A / ${B} + $A" })).toEqual(["A", "B"]);
    expect(expressionInputs({ type: "reduce", expression: "$A" })).toEqual(["A"]);
    expect(expressionInputs({ type: "classic_conditions", conditions: [{ query: { params: ["A"] } }, { query: { params: ["B"] } }] })).toEqual(["A", "B"]);
  });
});

describe("GRAF112: rule datasources", () => {
  test("an undeclared uid is an error once any datasource is declared, and a warning otherwise", () => {
    const docs = doc([rule({ data: [{ ...prom("A", "up"), datasourceUid: "other" }, expr("C", { type: "math", expression: "$A" })] })]);
    expect(checkRuleDatasources(docs, PROM).map((i) => [i.severity, i.message])).toEqual([["error", expect.stringContaining('uses datasource uid "other"')]]);
    expect(checkRuleDatasources(docs, new Map()).map((i) => [i.severity, i.message])).toEqual([["warning", expect.stringContaining("cannot check it")]]);
  });

  test("a model for another plugin, and a recording target that is not Prometheus, are errors", () => {
    const known = knownDatasources([
      { name: "Prometheus", type: "prometheus", uid: "prom" },
      { name: "Loki", type: "loki", uid: "loki" },
    ]);
    const lokiModel = { ...prom("A", "up"), model: { refId: "A", expr: "up", datasource: { type: "loki", uid: "prom" } } };
    const issues = checkRuleDatasources(doc([rule({ data: [lokiModel] , condition: "A"}), { uid: "r2", title: "rec", data: [prom("A", "up")], record: { metric: "m", from: "A", targetDatasourceUid: "loki" } }]), known);
    expect(issues.map((i) => i.message)).toEqual([expect.stringContaining("has a loki query model, but datasource \"Prometheus\" is prometheus"), expect.stringContaining("which is loki")]);
  });
});

describe("GRAF108 over alert rules", () => {
  test("PromQL sent to a Prometheus datasource, declared or stated in the model, is parsed", () => {
    const stated = { refId: "B", datasourceUid: "elsewhere", model: { expr: "sum(rate(x[5m])", datasource: { type: "prometheus", uid: "elsewhere" } } };
    const loki = { refId: "D", datasourceUid: "logs", model: { expr: "{app=\"x\"} |= \"(\"" } };
    const issues = checkRulePromql(doc([rule({ data: [prom("A", "sum(rate(x[5m]))"), stated, prom("C", "up{"), loki] })]), PROM);
    expect(issues.map((i) => [i.code, i.message])).toEqual([
      ["GRAF108", expect.stringContaining("query B is not valid PromQL")],
      ["GRAF108", expect.stringContaining("query C is not valid PromQL")],
    ]);
  });
});

describe("GRAF113: notification references", () => {
  const cps = { contactPoints: [{ name: "oncall", receivers: [{ uid: "o", type: "email", settings: { addresses: "a@b" } }] }], muteTimes: [{ name: "weekends", time_intervals: [] }] };

  test("receivers and timings the build declares pass; the built-in default email passes", () => {
    const docs = doc([rule({ notification_settings: { receiver: "grafana-default-email", mute_time_intervals: ["weekends"] } })], {
      ...cps,
      policies: [{ receiver: "oncall", routes: [{ receiver: "oncall", object_matchers: [["severity", "=~", "page|crit"]], active_time_intervals: ["weekends"] }] }],
    });
    expect(checkNotificationRefs(docs)).toEqual([]);
  });

  test("an unknown receiver or timing, and a matcher that does not parse, are errors", () => {
    const docs = doc([rule({ notification_settings: { receiver: "pager" } })], {
      ...cps,
      policies: [
        {
          receiver: "oncall",
          routes: [
            { receiver: "tickets", object_matchers: [["severity", "==", "x"]], mute_time_intervals: ["nights"] },
            { matchers: ['severity="page'], routes: [{ object_matchers: [["team", "=~", "("]] }] },
          ],
        },
      ],
    });
    expect(checkNotificationRefs(docs).map((i) => i.message)).toEqual([
      expect.stringContaining('route 1 sends to contact point "tickets"'),
      expect.stringContaining('mute_time_intervals names "nights"'),
      expect.stringContaining('object matcher ["severity","==","x"]'),
      expect.stringContaining('has matcher "severity=\\"page"'),
      expect.stringContaining("not a valid regular expression"),
      expect.stringContaining('sends to contact point "pager"'),
    ]);
  });

  test("with no contact point or timing declared it warns that it cannot check", () => {
    const issues = checkNotificationRefs(doc([], { policies: [{ receiver: "oncall", routes: [{ mute_time_intervals: ["w"] }] }] }));
    expect(issues.map((i) => [i.severity, i.message])).toEqual([
      ["warning", expect.stringContaining('contact point "oncall"')],
      ["warning", expect.stringContaining('mute timing "w"')],
    ]);
  });
});

describe("GRAF114: identity, duplicates and intervals", () => {
  test("a bad uid, title, interval, duration or state, and a group with no folder, are errors", () => {
    const docs: AlertingDoc[] = [
      {
        json: {
          apiVersion: 1,
          groups: [
            { name: "g", folder: "F", interval: "15s", rules: [rule({ uid: "x".repeat(41), for: "5 minutes", noDataState: "Nope" }), rule({ uid: "ok", title: "" })] },
            { name: "h", folder: "", interval: "1m", rules: [] },
          ],
        },
      },
    ];
    expect(checkAlertingIdentity(docs).map((i) => i.message)).toEqual([
      expect.stringContaining("interval 15s"),
      expect.stringContaining('Rule group "h" has no folder'),
      expect.stringContaining("one bad rule stops it provisioning every alerting file"),
      expect.stringContaining('for "5 minutes"'),
      expect.stringContaining('noDataState "Nope"'),
      expect.stringContaining("has no title"),
    ]);
  });

  test("duplicates across files are errors: rule uids, groups, contact points, receivers, policy trees, timings, templates", () => {
    const one = {
      apiVersion: 1,
      groups: [{ name: "g", folder: "F", interval: "1m", rules: [rule()] }],
      contactPoints: [{ name: "c", receivers: [{ uid: "u", type: "email", settings: { addresses: "a" } }] }],
      policies: [{ receiver: "c" }],
      muteTimes: [{ name: "m", time_intervals: [] }],
      templates: [{ name: "t", template: "x" }],
    };
    const issues = checkAlertingIdentity([{ json: one }, { json: one }]);
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining('share the uid "r1"'),
      expect.stringContaining('named "g" in folder "F"'),
      expect.stringContaining('contact points are named "c"'),
      expect.stringContaining('receivers share the uid "u"'),
      expect.stringContaining("policy trees are declared for org 1"),
      expect.stringContaining('mute timings are named "m"'),
      expect.stringContaining('templates are named "t"'),
    ]);
  });
});

describe("the post-synth checks over a build", () => {
  function ctxOf(entities: Record<string, Declarable>) {
    const out = grafanaSerializer.serialize(new Map(Object.entries(entities)));
    if (typeof out === "string") throw new Error("expected files");
    return makePostSynthCtxFromFiles("grafana", out.files!, out.primary, new Map(Object.entries(entities)));
  }
  const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", uid: "prom" });
  const oncall = new ContactPoint({ name: "oncall", receivers: [{ type: "email", settings: { addresses: "a@example.com" } }] });
  const weekends = new MuteTiming({ name: "weekends", time_intervals: [{ weekdays: ["saturday"] }] });

  test("a clean build has no findings", () => {
    const group = new AlertRuleGroup({
      name: "g",
      folder: "F",
      rules: [
        new AlertRule({
          title: "Errors",
          data: [
            new PromQuery({ datasource: prometheus, expr: "sum(rate(errors[5m]))", instant: true }),
            new ReduceExpression({ expression: "A", reducer: "last" }),
            new ThresholdExpression({ expression: "B", conditions: [{ evaluator: { type: "gt", params: [1] } }] }),
          ],
          notification_settings: { receiver: oncall, mute_time_intervals: [weekends] },
        }),
      ],
    });
    const policy = new NotificationPolicy({ receiver: oncall });
    const ctx = ctxOf({ prometheus, oncall, weekends, group, policy });
    for (const check of [graf108, graf111, graf112, graf113, graf114]) expect(check.check(ctx), check.id).toEqual([]);
  });

  test("each check reports what is wrong in the built file", () => {
    const external = new ExternalDatasource({ type: "prometheus", uid: "ext" });
    const group = new AlertRuleGroup({
      name: "g",
      folder: "F",
      interval: "25s",
      rules: [
        new AlertRule({
          title: "Broken",
          data: [
            new AlertQuery({ datasource: "missing", model: { expr: "up" } }),
            new PromQuery({ datasource: external, expr: "sum(rate(x[5m])" }),
            new MathExpression({ expression: "$A + $Z" }),
          ],
          notification_settings: { receiver: "nobody" },
        }),
      ],
    });
    const ctx = ctxOf({ prometheus, external, oncall, group });
    expect(graf108.check(ctx).map((d) => d.message)).toEqual([expect.stringContaining("query B is not valid PromQL")]);
    expect(graf111.check(ctx).map((d) => d.message)).toEqual([expect.stringContaining('expression C reads "Z"')]);
    expect(graf112.check(ctx).map((d) => d.message)).toEqual([expect.stringContaining('datasource uid "missing"')]);
    expect(graf113.check(ctx).map((d) => d.message)).toEqual([expect.stringContaining('contact point "nobody"')]);
    expect(graf114.check(ctx).map((d) => d.message)).toEqual([expect.stringContaining("interval 25s")]);
  });
});
