/**
 * GRAF116 (LogQL) and GRAF117 (TraceQL): the syntax checks, how queries are
 * routed to them, and the real exports, community dashboards and alerting
 * files in the round-trip corpus staying clean.
 */
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { makePostSynthCtxFromFiles } from "@intentius/chant-test-utils";
import { checkGrafanaLogql, checkGrafanaTraceql, lokiQueries, tempoQueries, variableLogql } from "./query-syntax";
import { checkRuleLogql, type AlertingDoc } from "./validate-alerting";
import { knownDatasources } from "./datasource-refs";
import { graf116 } from "./lint/post-synth/graf116";
import { graf117 } from "./lint/post-synth/graf117";

type Json = Record<string, unknown>;

const LOKI = { type: "loki", uid: "logs" };
const TEMPO = { type: "tempo", uid: "traces" };
const known = knownDatasources([
  { name: "Loki", type: "loki", uid: "logs" },
  { name: "Tempo", type: "tempo", uid: "traces" },
  { name: "Prometheus", type: "prometheus", uid: "prom" },
]);

function panel(id: number, datasource: Json | undefined, targets: Json[]): Json {
  return { type: "table", id, title: `p${id}`, gridPos: { x: 0, y: id * 4, w: 12, h: 4 }, ...(datasource ? { datasource } : {}), targets };
}

function dashboard(panels: Json[], variables: Json[] = [], extra: Json = {}): Json {
  return { uid: "d", title: "D", schemaVersion: 42, annotations: { list: [] }, templating: { list: variables }, panels, ...extra };
}

function ctxOf(d: Json) {
  return makePostSynthCtxFromFiles("grafana", { "dashboards/d.json": JSON.stringify(d) }, "{}");
}

describe("checkGrafanaLogql", () => {
  test.each([
    '{app="x"}',
    '{app="x"} |= "error" | json | level="error" | line_format "{{.msg}}"',
    'sum by (level) (count_over_time({app="x"} |= "$filter" [$__auto]))',
    'sum(rate({app="$app", env=~"${env:regex}"}[$__interval])) by ($label)',
    'topk(10, sum by (path) (rate({job="nginx"} | pattern "<ip> - <_> \\"<method> <path> <_>\\"" [5m])))',
    '{app="x"} $pipeline',
    '{app="x"} | logfmt | __error__="" | keep level, msg',
  ])("passes %s", (q) => {
    expect(checkGrafanaLogql(q)).toEqual({ ok: true });
  });

  test("flags an unclosed stream selector and names where", () => {
    const r = checkGrafanaLogql('sum(rate({app="x"[5m]))');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/syntax error at offset \d+/);
  });

  test("flags a range written outside the brackets and a query that ends early", () => {
    expect(checkGrafanaLogql('sum(rate({app="x"}[1]m))').ok).toBe(false);
    const r = checkGrafanaLogql('rate({app="x"}[5m]) by');
    expect(r).toEqual({ ok: false, message: expect.stringContaining("the query ends early") });
  });
});

describe("checkGrafanaTraceql", () => {
  test.each([
    '{ resource.service.name = "checkout" } | max(duration) > 1s',
    '{ span.http.status_code >= 500 && .route = "$route" } | rate() by (resource.service.name)',
    "{ .code = $code }",
    "{ status = error } >> { kind = server }",
    "{}",
  ])("passes %s", (q) => {
    expect(checkGrafanaTraceql(q)).toEqual({ ok: true });
  });

  test("flags an unclosed spanset", () => {
    expect(checkGrafanaTraceql('{ .a = "b" ').ok).toBe(false);
    expect(checkGrafanaTraceql("{ .a = } | count()").ok).toBe(false);
  });
});

describe("variableLogql", () => {
  test("only the stream selector of a Loki query variable is LogQL", () => {
    expect(variableLogql('label_values({app="x"}, pod)')).toEqual(['{app="x"}']);
    expect(variableLogql("label_values(pod)")).toEqual([]);
    expect(variableLogql("label_names()")).toEqual([]);
    expect(variableLogql({ type: 1, label: "pod", stream: '{app="x"}' })).toEqual(['{app="x"}']);
    expect(variableLogql({ type: 0 })).toEqual([]);
  });
});

describe("routing by resolved datasource", () => {
  test("Loki panel queries, annotations and variables go to GRAF116; Tempo TraceQL to GRAF117; PromQL to neither", () => {
    const d = dashboard(
      [
        panel(1, LOKI, [{ refId: "A", expr: '{app="x"' }]),
        panel(2, { type: "datasource", uid: "-- Mixed --" }, [
          { refId: "A", datasource: LOKI, expr: '{app="x"} |= "ok"' },
          { refId: "B", datasource: TEMPO, queryType: "traceql", query: "{ .a = }" },
          { refId: "C", datasource: { type: "prometheus", uid: "prom" }, expr: '{app="x"' },
        ]),
        panel(3, TEMPO, [
          { refId: "A", queryType: "traceId", query: "{ not traceql" },
          { refId: "B", query: "4bf92f3577b34da6a3ce929d0e0e4736" },
          { refId: "C", queryType: "serviceMap", query: "" },
        ]),
      ],
      [{ type: "query", name: "pod", datasource: LOKI, query: 'label_values({app="x", pod)' }],
      { annotations: { list: [{ name: "deploys", datasource: LOKI, enable: true, expr: '{app="deploy"} |= ' }] } },
    );
    expect(lokiQueries(d, known).map((q) => q.where)).toEqual([
      'panel "p1" (id 1) query A',
      'panel "p2" (id 2) query A',
      'variable "pod" query',
      'annotation "deploys" query',
    ]);
    expect(tempoQueries(d, known).map((q) => q.where)).toEqual(['panel "p2" (id 2) query B']);

    const logql = graf116.check(ctxOf(d));
    expect(logql.map((x) => [x.checkId, x.severity])).toEqual([
      ["GRAF116", "error"],
      ["GRAF116", "error"],
      ["GRAF116", "error"],
    ]);
    expect(logql.map((x) => x.message)).toEqual([
      expect.stringContaining('panel "p1" (id 1) query A is not valid LogQL'),
      expect.stringContaining('variable "pod" query is not valid LogQL'),
      expect.stringContaining('annotation "deploys" query is not valid LogQL'),
    ]);
    expect(graf117.check(ctxOf(d)).map((x) => [x.checkId, x.severity, x.message])).toEqual([
      ["GRAF117", "warning", expect.stringContaining('panel "p2" (id 2) query B is not valid TraceQL')],
    ]);
  });

  test("a datasource variable's plugin type routes its queries; one whose datasource can't be told is left alone", () => {
    const ds = { type: "datasource", name: "logs", query: "loki" };
    const d = dashboard([panel(1, { uid: "${logs}" }, [{ refId: "A", expr: "{app=" }]), panel(2, undefined, [{ refId: "A", expr: "{app=" }])], [ds]);
    expect(graf116.check(ctxOf(d)).map((x) => x.message)).toEqual([expect.stringContaining('panel "p1" (id 1) query A')]);
  });

  test("library panels in an export's __elements are checked", () => {
    const d = dashboard([], [], { __elements: { lib1: { name: "lib", kind: 1, model: panel(9, LOKI, [{ refId: "A", expr: "{app=" }]) } } });
    expect(lokiQueries(d, known)).toEqual([{ where: 'library panel "lib1" query A', expr: "{app=" }]);
  });
});

describe("GRAF116 over alert rules", () => {
  test("LogQL sent to a Loki datasource, declared or stated in the model, is parsed; PromQL is not", () => {
    const q = (refId: string, uid: string, e: string, type?: string): Json => ({ refId, datasourceUid: uid, model: { refId, expr: e, ...(type ? { datasource: { type, uid } } : {}) } });
    const docs: AlertingDoc[] = [
      {
        json: {
          apiVersion: 1,
          groups: [
            {
              name: "g",
              folder: "F",
              interval: "1m",
              rules: [{ uid: "r", title: "R", condition: "A", data: [q("A", "logs", 'sum(count_over_time({app="x"} |= "panic" [5m]))'), q("B", "logs", "{app="), q("C", "elsewhere", "count_over_time({a=}[1m])", "loki"), q("D", "prom", "{app=")] }],
            },
          ],
        },
      },
    ];
    expect(checkRuleLogql(docs, known).map((i) => [i.code, i.message])).toEqual([
      ["GRAF116", expect.stringContaining("query B is not valid LogQL")],
      ["GRAF116", expect.stringContaining("query C is not valid LogQL")],
    ]);
  });
});

describe("GRAF116 and GRAF117 over the round-trip corpus", () => {
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
  const exportsDir = join(fixtures, "exports");
  const dashboards = [
    ...readdirSync(exportsDir)
      .filter((d) => d.startsWith("grafana-"))
      .flatMap((v) => readdirSync(join(exportsDir, v)).filter((f) => f.endsWith(".json") && !f.includes("-resource")).map((f) => `exports/${v}/${f}`)),
    ...["community", "kube-prometheus"].flatMap((dir) =>
      readdirSync(join(fixtures, dir))
        .filter((f) => f.endsWith(".json"))
        .map((f) => `${dir}/${f}`),
    ),
  ];
  const alerting = ["grafana-12.4.11", "grafana-13.2.2", "community"].flatMap((dir) =>
    readdirSync(join(fixtures, "alerting", dir))
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => `alerting/${dir}/${f}`),
  );
  const none = knownDatasources([]);
  let logql = 0;
  let traceql = 0;

  test.each(dashboards)("%s has no GRAF116 or GRAF117 findings", (name) => {
    const text = readFileSync(join(fixtures, name), "utf-8");
    const json = JSON.parse(text) as Json;
    logql += lokiQueries(json, none).length;
    traceql += tempoQueries(json, none).length;
    const ctx = makePostSynthCtxFromFiles("grafana", { [name]: text }, "{}");
    expect([...graf116.check(ctx), ...graf117.check(ctx)]).toEqual([]);
  });

  test.each(alerting)("%s has no GRAF116 findings", (name) => {
    expect(graf116.check(makePostSynthCtxFromFiles("grafana", { [name]: readFileSync(join(fixtures, name), "utf-8") }, "{}"))).toEqual([]);
  });

  test("the corpus is not vacuous: it sends LogQL to Loki and TraceQL to Tempo", () => {
    expect(logql).toBeGreaterThan(0);
    expect(traceql).toBeGreaterThan(0);
  });
});
