/**
 * The composites' PromQL against real series, through Grafana.
 *
 * Builds the dashboards-from-declarations example (RedDashboard,
 * SloDashboard and AgentDashboard over its spanmetrics connector, its Slo
 * and the GenAI preset), backfills a Prometheus with series named the way
 * those declarations name them, provisions the build into each Grafana
 * release in `GRAFANA_IMAGES` on the same Docker network, and runs every
 * panel's target through `/api/ds/query` the way the dashboard would, with
 * each variable at its "All" value.
 *
 * The series grow at constant rates, so the expected values are exact:
 *
 * - checkout: server spans at 1/s OK and 0.1/s errors, plus client spans
 *   erroring at 10/s. Rate 1.1, error ratio 0.1/1.1; the client errors
 *   are not counted.
 * - cart: server spans at 2/s, no error series. Rate 2, error ratio 0.
 * - worker: consumer spans at 0.5/s, counted.
 * - frontend: client spans only. Absent from every panel and from the
 *   service picker.
 * - idle: a server-span counter that doesn't move. Rate 0, and error ratio
 *   0/0 = NaN, which is what a group with no traffic should give.
 * - agents: two models, two tools, an idle model, token counters; the
 *   token totals are one instant value each.
 * - SLO: the recording rules' outputs, seeded as plain series (the rules
 *   themselves are the prometheus lexicon's, checked there).
 *
 * Skipped, with the reason in the suite name, without Docker.
 * On demand: `npx vitest run --project e2e lexicons/grafana/src/composites/queries.e2e.test.ts`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { otelSerializer } from "@intentius/chant-lexicon-otel/serializer";
import { prometheusSerializer } from "@intentius/chant-lexicon-prometheus/serializer";
import { grafanaSerializer } from "../serializer";
import { DockerScope, GRAFANA_IMAGES, dockerAvailable, waitFor, type GrafanaContainer } from "../../test/e2e/containers";
import { dsQuery, lastBy, type Target } from "../../test/e2e/ds-query";
import { openMetrics, type Family } from "../../test/e2e/openmetrics";

const hasDocker = dockerAvailable();
const skipReason = hasDocker ? "" : " (skipped: Docker is not running)";
const example = join(import.meta.dirname, "..", "..", "examples", "dashboards-from-declarations", "src");

const STEP = 15;
/** The last sample, on a step boundary a minute back so no query reaches past the data. */
const END = Math.floor(Date.now() / 1000 / STEP) * STEP - 60;
const START = END - 3600;
/** Every query covers the last 30 minutes of the data. */
const FROM_MS = (END - 1800) * 1000;
const TO_MS = END * 1000;
const RANGE_S = 1800;

const SERVER = "SPAN_KIND_SERVER";
const CLIENT = "SPAN_KIND_CLIENT";
const CONSUMER = "SPAN_KIND_CONSUMER";
const OK = "STATUS_CODE_UNSET";
const ERROR = "STATUS_CODE_ERROR";

const span = (service: string, kind: string, status: string) => ({ service_name: service, span_name: `${service}-op`, span_kind: kind, status_code: status });

const agent = (model: string, tool: string, status: string, errorType = "") => ({
  service_name: "agent",
  gen_ai_request_model: model,
  ...(tool ? { gen_ai_tool_name: tool } : {}),
  status_code: status,
  ...(errorType ? { error_type: errorType } : {}),
});

const FAMILIES: Family[] = [
  {
    type: "counter",
    name: "shop_calls",
    series: [
      { labels: span("checkout", SERVER, OK), perSecond: 1 },
      { labels: span("checkout", SERVER, ERROR), perSecond: 0.1 },
      { labels: span("checkout", CLIENT, ERROR), perSecond: 10 },
      { labels: span("cart", SERVER, OK), perSecond: 2 },
      { labels: span("worker", CONSUMER, OK), perSecond: 0.5 },
      { labels: span("frontend", CLIENT, OK), perSecond: 3 },
      { labels: span("frontend", CLIENT, ERROR), perSecond: 1 },
      { labels: span("idle", SERVER, OK), perSecond: 0 },
    ],
  },
  {
    type: "histogram",
    name: "shop_duration_milliseconds",
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
    series: [
      { labels: span("checkout", SERVER, OK), perSecond: 1.1, within: 100 },
      { labels: span("checkout", CLIENT, ERROR), perSecond: 10, within: 1000 },
      { labels: span("cart", SERVER, OK), perSecond: 2, within: 10 },
      { labels: span("worker", CONSUMER, OK), perSecond: 0.5, within: 250 },
      { labels: span("frontend", CLIENT, OK), perSecond: 4, within: 500 },
    ],
  },
  {
    type: "counter",
    name: "agents_calls",
    series: [
      { labels: agent("big", "", OK), perSecond: 1 },
      { labels: agent("big", "", ERROR, "timeout"), perSecond: 0.25 },
      { labels: agent("big", "search", OK), perSecond: 0.2 },
      { labels: agent("big", "search", ERROR, "tool_error"), perSecond: 0.05 },
      { labels: agent("small", "", OK), perSecond: 0.5 },
      { labels: agent("small", "fetch", OK), perSecond: 0.1 },
      { labels: agent("idle-model", "", OK), perSecond: 0 },
    ],
  },
  {
    type: "histogram",
    name: "agents_duration_seconds",
    buckets: [0.1, 0.5, 1, 2.5, 5],
    series: [
      { labels: { service_name: "agent", gen_ai_request_model: "big" }, perSecond: 1.25, within: 2.5 },
      { labels: { service_name: "agent", gen_ai_request_model: "big", gen_ai_tool_name: "search" }, perSecond: 0.25, within: 2.5 },
      { labels: { service_name: "agent", gen_ai_request_model: "small" }, perSecond: 0.5, within: 0.5 },
      { labels: { service_name: "agent", gen_ai_request_model: "small", gen_ai_tool_name: "fetch" }, perSecond: 0.1, within: 0.5 },
    ],
  },
  {
    type: "counter",
    name: "agents_tokens_input",
    series: [
      { labels: { gen_ai_request_model: "big" }, perSecond: 100 },
      { labels: { gen_ai_request_model: "small" }, perSecond: 10 },
    ],
  },
  {
    type: "counter",
    name: "agents_tokens_output",
    series: [
      { labels: { gen_ai_request_model: "big" }, perSecond: 20 },
      { labels: { gen_ai_request_model: "small" }, perSecond: 5 },
    ],
  },
  ...(
    [
      ["slo:sli_error:ratio_rate30d", 0.0005],
      ["slo:objective:ratio", 0.999],
      ["slo:error_budget:remaining", 0.5],
      ["slo:sli_error:ratio_rate5m", 0.004],
      ["slo:sli_error:ratio_rate30m", 0.003],
      ["slo:sli_error:ratio_rate1h", 0.002],
      ["slo:sli_error:ratio_rate2h", 0.0015],
      ["slo:sli_error:ratio_rate6h", 0.001],
      ["slo:sli_error:ratio_rate1d", 0.0008],
      ["slo:sli_error:ratio_rate3d", 0.0006],
    ] as const
  ).map(([name, value]): Family => ({ type: "gauge", name, series: [{ labels: { slo: "checkout" }, value }] })),
];

/** `histogram_quantile` inside the bucket `(lower, upper]` that holds every observation. */
const interpolated = (q: number, lower: number, upper: number) => lower + q * (upper - lower);

interface Panel {
  title: string;
  type: string;
  targets?: Target[];
  panels?: Panel[];
}

interface Built {
  uid: string;
  templating: { list: Array<{ name: string; query: string | { query: string }; allValue?: string }> };
  panels: Panel[];
}

function panelsOf(d: Built): Panel[] {
  const out: Panel[] = [];
  const walk = (ps: Panel[]) => {
    for (const p of ps) {
      if (p.panels) walk(p.panels);
      if (p.targets) out.push(p);
    }
  };
  walk(d.panels);
  return out;
}

/** Each variable at its "All" value, as the dashboard opens. */
function allValues(d: Built): Record<string, string> {
  return Object.fromEntries(d.templating.list.map((v) => [v.name, v.allValue ?? ".*"]));
}

describe.skipIf(!hasDocker)(`composite queries against a seeded Prometheus, through Grafana${skipReason}`, () => {
  const scope = new DockerScope("grafana-queries");
  const dashboards = new Map<string, Built>();
  let network = "";
  let dir = "";

  beforeAll(async () => {
    const result = await build(example, [otelSerializer, prometheusSerializer, grafanaSerializer]);
    expect(result.errors).toEqual([]);
    const out = result.outputs.get("grafana") as SerializerResult;
    dir = scope.tempDir();
    for (const [file, content] of Object.entries(out.files ?? {})) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
      if (file.endsWith(".json")) {
        const d = JSON.parse(content) as Built;
        dashboards.set(d.uid, d);
      }
    }
    network = scope.network();
    await scope.prometheus({ network, alias: "prometheus", openMetrics: openMetrics({ start: START, end: END, step: STEP }, FAMILIES) });
  }, 300_000);

  afterAll(() => scope.cleanup());

  describe.each(GRAFANA_IMAGES)("%s", (image) => {
    let grafana: GrafanaContainer;
    const dashboard = (uid: string) => {
      const d = dashboards.get(uid);
      if (!d) throw new Error(`the example built no dashboard ${uid}; it built ${[...dashboards.keys()].join(", ")}`);
      return d;
    };
    const panel = (uid: string, title: string, nth = 0) => {
      const p = panelsOf(dashboard(uid)).filter((x) => x.title === title)[nth];
      if (!p) throw new Error(`${uid} has no panel ${title}`);
      return p;
    };
    const run = async (uid: string, target: Target) => {
      const r = await dsQuery(grafana, target, { from: FROM_MS, to: TO_MS, vars: allValues(dashboard(uid)) });
      expect(r.error, `${target.expr}\n${r.error}`).toBeUndefined();
      return r;
    };
    const runPanel = async (uid: string, title: string, nth = 0) => run(uid, panel(uid, title, nth).targets![0]);

    beforeAll(async () => {
      grafana = await scope.grafana({ image, network, provisioningDir: join(dir, "provisioning"), dashboardsDir: join(dir, "dashboards") });
      // The datasource reaches the seeded Prometheus before any panel runs.
      await waitFor("Grafana to reach Prometheus", async () => {
        const r = await grafana.api("/api/datasources/uid/prometheus/health");
        return r.status === 200 && r.body?.status === "OK" ? true : undefined;
      });
    }, 300_000);

    it("every panel query of every composite dashboard runs, and returns data", { timeout: 120_000 }, async () => {
      for (const [uid, d] of dashboards) {
        for (const p of panelsOf(d)) {
          for (const t of p.targets!) {
            const r = await run(uid, t);
            expect(r.series.length, `${uid} / ${p.title} / ${t.refId}: ${t.expr}`).toBeGreaterThan(0);
          }
        }
      }
    });

    describe("RedDashboard", () => {
      it("rate counts server and consumer spans only; client-only services are absent", async () => {
        const rate = lastBy((await runPanel("red-shop", "Rate")).series, "service_name");
        expect(Object.keys(rate).sort()).toEqual(["cart", "checkout", "idle", "worker"]);
        expect(rate.checkout).toBeCloseTo(1.1, 6);
        expect(rate.cart).toBeCloseTo(2, 6);
        expect(rate.worker).toBeCloseTo(0.5, 6);
        expect(rate.idle).toBe(0);
      });

      it("error ratio ignores client errors, reads 0 for a service with calls and no errors, and NaN for one with no traffic", async () => {
        const ratio = lastBy((await runPanel("red-shop", "Errors")).series, "service_name");
        expect(Object.keys(ratio).sort()).toEqual(["cart", "checkout", "idle", "worker"]);
        expect(ratio.checkout).toBeCloseTo(0.1 / 1.1, 6);
        expect(ratio.cart).toBe(0);
        expect(ratio.worker).toBe(0);
        expect(ratio.idle).toBeNaN();
      });

      it("duration quantiles come from server and consumer spans only", async () => {
        for (const [title, q] of [
          ["Duration p50", 0.5],
          ["Duration p95", 0.95],
          ["Duration p99", 0.99],
        ] as const) {
          const d = lastBy((await runPanel("red-shop", title)).series, "service_name");
          expect(Object.keys(d).sort(), title).toEqual(["cart", "checkout", "worker"]);
          expect(d.checkout, title).toBeCloseTo(interpolated(q, 50, 100), 6);
          expect(d.cart, title).toBeCloseTo(interpolated(q, 5, 10), 6);
          expect(d.worker, title).toBeCloseTo(interpolated(q, 100, 250), 6);
        }
      });

      it("the service picker lists the services that serve, not the client-only one", async () => {
        const v = dashboard("red-shop").templating.list.find((x) => x.name === "service")!;
        const query = typeof v.query === "string" ? v.query : v.query.query;
        const m = /^label_values\((.*), (\w+)\)$/.exec(query);
        expect(m, query).not.toBeNull();
        const params = new URLSearchParams({ "match[]": m![1], start: String(FROM_MS / 1000), end: String(TO_MS / 1000) });
        const r = await grafana.api(`/api/datasources/uid/prometheus/resources/api/v1/label/${m![2]}/values?${params}`);
        expect(r.status).toBe(200);
        expect([...r.body.data].sort()).toEqual(["cart", "checkout", "idle", "worker"]);
      });
    });

    describe("AgentDashboard", () => {
      it("calls, errors and latency per model", async () => {
        const calls = lastBy((await runPanel("agents-agents", "Calls by model")).series, "gen_ai_request_model");
        expect(calls.big).toBeCloseTo(1.5, 6);
        expect(calls.small).toBeCloseTo(0.6, 6);
        expect(calls["idle-model"]).toBe(0);
        const errors = lastBy((await runPanel("agents-agents", "Errors by model")).series, "gen_ai_request_model");
        expect(errors.big).toBeCloseTo(0.3 / 1.5, 6);
        expect(errors.small).toBe(0);
        expect(errors["idle-model"]).toBeNaN();
        const latency = lastBy((await runPanel("agents-agents", "Latency p95 by model")).series, "gen_ai_request_model");
        expect(latency.big).toBeCloseTo(interpolated(0.95, 1, 2.5), 6);
        expect(latency.small).toBeCloseTo(interpolated(0.95, 0.1, 0.5), 6);
      });

      it("calls, errors and latency per tool, leaving out calls with no tool", async () => {
        const calls = lastBy((await runPanel("agents-agents", "Tool calls")).series, "gen_ai_tool_name");
        expect(Object.keys(calls).sort()).toEqual(["fetch", "search"]);
        expect(calls.search).toBeCloseTo(0.25, 6);
        expect(calls.fetch).toBeCloseTo(0.1, 6);
        const errors = lastBy((await runPanel("agents-agents", "Errors by tool")).series, "gen_ai_tool_name");
        expect(errors.search).toBeCloseTo(0.2, 6);
        expect(errors.fetch).toBe(0);
        const latency = lastBy((await runPanel("agents-agents", "Latency p95 by tool")).series, "gen_ai_tool_name");
        expect(Object.keys(latency).sort()).toEqual(["fetch", "search"]);
        expect(latency.search).toBeCloseTo(interpolated(0.95, 1, 2.5), 6);
        expect(latency.fetch).toBeCloseTo(interpolated(0.95, 0.1, 0.5), 6);
      });

      it("errors by type", async () => {
        const byType = lastBy((await runPanel("agents-agents", "Errors by type")).series, "error_type");
        expect(Object.keys(byType).sort()).toEqual(["timeout", "tool_error"]);
        expect(byType.timeout).toBeCloseTo(0.25, 6);
        expect(byType.tool_error).toBeCloseTo(0.05, 6);
      });

      it("token rates per model", async () => {
        const input = lastBy((await runPanel("agents-agents", "Input tokens by model")).series, "gen_ai_request_model");
        expect(input.big).toBeCloseTo(100, 6);
        expect(input.small).toBeCloseTo(10, 6);
        const output = lastBy((await runPanel("agents-agents", "Output tokens by model")).series, "gen_ai_request_model");
        expect(output.big).toBeCloseTo(20, 6);
        expect(output.small).toBeCloseTo(5, 6);
      });

      it("token totals come back as one instant value over the dashboard's range", async () => {
        for (const [title, perSecond] of [
          ["Input tokens", 110],
          ["Output tokens", 25],
        ] as const) {
          const r = await runPanel("agents-agents", title);
          expect(r.series.length, title).toBe(1);
          expect(r.series[0].values.length, title).toBe(1);
          expect(r.series[0].values[0]!, title).toBeCloseTo(perSecond * RANGE_S, 3);
        }
      });
    });

    describe("SloDashboard", () => {
      it("reads the recorded SLI, objective, budget and burn rates", async () => {
        const last = async (title: string, nth = 0, refId = "A") => {
          const p = panel("slo-checkout", title, nth);
          const r = await run("slo-checkout", p.targets!.find((t) => t.refId === refId)!);
          expect(r.series.length, `${title} ${refId}`).toBe(1);
          return [...r.series[0].values].reverse().find((v) => v !== null)!;
        };
        expect(await last("SLI over 30d")).toBeCloseTo(0.9995, 9);
        expect(await last("Objective")).toBeCloseTo(0.999, 9);
        expect(await last("Error budget remaining")).toBeCloseTo(0.5, 9);
        // No alert is firing, so `or vector(0)` gives 0.
        expect(await last("Burn-rate alerts firing")).toBe(0);
        expect(await last("Burn rate 1h / 5m (page)", 0, "A")).toBeCloseTo(2, 6);
        expect(await last("Burn rate 1h / 5m (page)", 0, "B")).toBeCloseTo(4, 6);
        expect(await last("Burn rate 3d / 6h (ticket)", 0, "A")).toBeCloseTo(0.6, 6);
      });
    });
  });
});
