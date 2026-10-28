/**
 * The estate page, overdue drift checks and delivery metrics (#4612), over
 * the fixture ledger in __fixtures__/estate-ledger.ts. A Terraform member
 * (`network`) and a Pulumi member (`web`) go through the same code.
 */
import { describe, expect, test } from "vitest";
import { ESTATE_SCHEDULES, ESTATE_TABLES, NOW } from "./__fixtures__/estate-ledger";
import { TERRAGUCCI, PLYWOOD } from "./__fixtures__/product-words";
import { resolveProductWords } from "./ci-product-words";
import {
  buildDelivery,
  buildEstate,
  buildLedgerEstate,
  deliveryGauges,
  doraMetricNames,
  estateFiles,
  estateRows,
  ledgerOverdue,
  otlpMetricsBody,
  otlpMetricsFromEnv,
  renderEstateHtml,
  writeEstate,
} from "./ci-estate";
import type { OtlpFetch } from "./otlp";

const rows = estateRows(ESTATE_TABLES);
const tg = resolveProductWords(TERRAGUCCI);
const ply = resolveProductWords(PLYWOOD);

describe("estateRows", () => {
  test("reads wave jobs, drift checks, gates, applies and pull request environments", () => {
    expect(rows.members).toEqual(["network", "web"]);
    // Every wave job, the deciding one included; the plain notify run is neither.
    expect(rows.waves.map((w) => w.id)).toEqual(["r-a0", "r-a1", "r-a2", "r-b", "r-c", "r-d", "r-e"]);
    expect(rows.waves.find((w) => w.id === "r-a0")).toMatchObject({ job: "decide", applied: [], digest: "dA" });
    expect(rows.waves.find((w) => w.id === "r-a2")).toMatchObject({ job: "share", share: 1, applied: ["dns"], commit: "c1" });
    // A WatchOp's label, or a Drift outcome alone, makes a drift check.
    expect(rows.drift.map((d) => [d.id, d.drifted, d.roots])).toEqual([
      ["d-1", true, ["vpc"]],
      ["d-2", false, []],
      ["d-3", true, []],
    ]);
    expect(rows.approved).toEqual([expect.objectContaining({ member: "network", op: "tf-apply", planDigest: "dA", approvedBy: "alice" })]);
    expect(rows.prEnvs.map((p) => `${p.kind}:${p.env}`)).toEqual(["up:pr-9", "down:pr-9", "up:pr-12"]);
  });

  test("driftOps names the drift checks, and deployOps counts plain runs as applies", () => {
    const r = estateRows(ESTATE_TABLES, { driftOps: ["tf-drift"], deployOps: ["notify"] });
    expect(r.drift.map((d) => d.id)).toEqual(["d-1", "d-2"]);
    expect(r.waves.find((w) => w.id === "x-1")).toMatchObject({ spec: "notify", applied: ["notify"], failed: [] });
  });

  test("a ledger outside a workspace is named by project", () => {
    const solo = { ...ESTATE_TABLES, runs: ESTATE_TABLES.runs.map((r) => ({ ...r, member: null })), gates: [], applies: [], pr_envs: [] };
    expect(estateRows(solo, { project: "infra" }).members).toEqual(["infra"]);
  });

  test("a malformed wave cell reads as no wave", () => {
    const bad = { ...ESTATE_TABLES, runs: [{ ...ESTATE_TABLES.runs[4]!, wave: "{not json" }], gates: [], applies: [], pr_envs: [] };
    expect(estateRows(bad).waves).toEqual([]);
  });
});

describe("buildDelivery", () => {
  const dora = buildDelivery(rows, { words: tg, now: NOW });

  test("keeps terragucci's dora.json shape under the product's schema name", () => {
    expect(dora.schema).toBe("terragucci.dora/v1");
    expect(buildDelivery(rows, { words: ply, now: NOW }).schema).toBe("plywood.dora/v1");
    expect(Object.keys(dora)).toEqual(["schema", "generated", "weeks", "window", "drift_window_seconds", "audit", "source", "estate", "projects"]);
    expect(dora.window).toEqual({ from: "2026-09-07T00:00:00.000Z", to: "2026-10-27T12:00:00.000Z" });
    expect(dora.audit).toBe(true);
    expect(dora.projects.map((p) => p.project)).toEqual(["network", "web"]);
  });

  test("share jobs of one wave count once, and the rate divides by the span the history covers", () => {
    expect(dora.estate.deployments).toBe(3);
    expect(dora.estate.span_seconds).toBe(609600);
    expect(dora.estate.per_week).toBe(2.98);
    expect(dora.projects[0]).toMatchObject({ deployments: 2, per_week: 1.98 });
    expect(dora.projects[1]).toMatchObject({ deployments: 1, span_seconds: 510000, per_week: 1.19 });
  });

  test("lead time runs from the first job of the digest, split at the gate", () => {
    const network = dora.projects[0]!.lead_time;
    expect(network).toEqual({ changes: 2, median_seconds: 3300, before_gate_seconds: 450, at_gate_seconds: 1650, after_gate_seconds: 1200 });
    expect(dora.projects[1]!.lead_time).toMatchObject({ changes: 1, median_seconds: 1200, at_gate_seconds: 0 });
    expect(dora.estate.lead_time).toMatchObject({ changes: 3, median_seconds: 1200 });
  });

  test("a commit time starts a change earlier", () => {
    const early = buildDelivery(rows, { now: NOW, commitTime: (c) => (c === "p1" ? Date.parse("2026-10-21T13:00:00.000Z") : null) });
    expect(early.projects[1]!.lead_time.median_seconds).toBe(4800);
  });

  test("change failure counts failed applies and applies drift followed", () => {
    expect(dora.projects[0]!.change_failure).toEqual({ applies: 3, failed: 1, drifted: 1, rate: 0.666667 });
    // Drift that names no stack matches any of the member's.
    expect(dora.projects[1]!.change_failure).toEqual({ applies: 1, failed: 0, drifted: 1, rate: 1 });
    expect(dora.estate.change_failure).toEqual({ applies: 4, failed: 1, drifted: 2, rate: 0.75 });
  });

  test("time to restore: a failed apply to the next apply of its roots, drift found to a clean check", () => {
    expect(dora.projects[0]!.restore).toEqual({ restored: 2, open: 0, median_seconds: 50400, apply_restored: 1, drift_restored: 1 });
    expect(dora.projects[1]!.restore).toMatchObject({ restored: 0, open: 1, median_seconds: null });
  });

  test("a row per week, oldest first", () => {
    expect(dora.estate.trend).toHaveLength(8);
    expect(dora.estate.trend.at(-2)).toEqual({ week: "2026-10-19", deployments: 3, applies: 4, failures: 3, lead_time_seconds: 1200, restore_seconds: 50400 });
    expect(dora.estate.trend.at(-1)).toMatchObject({ week: "2026-10-26", deployments: 0, applies: 0 });
  });

  test("an empty ledger has no applies and no rates", () => {
    const none = buildDelivery(estateRows({ runs: [], gates: [], applies: [], pr_envs: [] }), { now: NOW });
    expect(none.audit).toBe(false);
    expect(none.estate).toMatchObject({ deployments: 0, change_failure: { rate: null }, lead_time: { median_seconds: null } });
  });

  test("the gauges carry terragucci's metric names under its words", () => {
    expect(doraMetricNames(tg)).toEqual({ deployments: "terragucci_dora_deployments_per_week", leadTime: "terragucci_dora_lead_time_seconds", failureRate: "terragucci_dora_change_failure_ratio", restore: "terragucci_dora_restore_seconds" });
    const gauges = deliveryGauges(dora, tg);
    expect(gauges.filter((g) => g.attributes.project === "*").map((g) => [g.name, g.attributes.segment ?? "", g.value])).toEqual([
      ["terragucci_dora_deployments_per_week", "", 2.98],
      ["terragucci_dora_lead_time_seconds", "total", 1200],
      ["terragucci_dora_lead_time_seconds", "before_gate", 600],
      ["terragucci_dora_lead_time_seconds", "at_gate", 0],
      ["terragucci_dora_lead_time_seconds", "after_gate", 0],
      ["terragucci_dora_change_failure_ratio", "", 0.75],
      ["terragucci_dora_restore_seconds", "", 50400],
    ]);
    expect(doraMetricNames({ product: "sql-yodeler" }).deployments).toBe("sql_yodeler_dora_deployments_per_week");
  });
});

describe("ledgerOverdue", () => {
  const schedules = ESTATE_SCHEDULES.map((s) => ({ ...s, ...("members" in s ? { members: [...s.members] } : {}) }));

  test("a member whose newest check is two fires old is overdue, in the product's words", () => {
    const found = ledgerOverdue(rows, schedules, { words: tg, now: NOW });
    expect(found).toEqual([
      {
        op: "tf-drift",
        cron: "0 6 * * *",
        since: "2026-10-24T06:05:00.000Z",
        member: "network",
        last: { id: "d-2", ended: "2026-10-24T06:05:00.000Z", status: "ok", runUrl: "https://forge.example/run/d-2" },
        message: "terragucci drift checks of root `network` are overdue: the schedule `0 6 * * *` of `tf-drift` has fired at least twice and its last check on the ledger ended on 2026-10-24.",
      },
    ]);
  });

  test("a member with no check is judged from when its schedule began, and skipped without it", () => {
    const found = ledgerOverdue(rows, schedules, { words: ply, now: NOW, added: (op, m) => (op === "tf-drift" && m === "db" ? "2026-10-01T00:00:00.000Z" : undefined) });
    expect(found.map((o) => [o.member, o.neverRan ?? false])).toEqual([["db", true], ["network", false]]);
    expect(found[0]!.message).toBe("plywood drift checks of stack `db` are overdue: the schedule `0 6 * * *` of `tf-drift` has fired at least twice and no check is on the ledger since its schedule began on 2026-10-01.");
  });

  test("a check within its window is on time", () => {
    expect(ledgerOverdue(rows, [{ op: "pulumi-drift", cron: "0 7 * * *" }], { now: NOW })).toEqual([]);
  });
});

describe("buildEstate", () => {
  const overdue = ledgerOverdue(rows, [{ op: "tf-drift", cron: "0 6 * * *" }], { words: tg, now: NOW });
  const dora = buildDelivery(rows, { words: tg, now: NOW });
  const estate = buildEstate(rows, dora, { words: tg, now: NOW, overdue, malformed: { runs: 2, gates: 0 } });

  test("totals over the members, in terragucci's field names", () => {
    expect(estate.schema).toBe("terragucci.estate/v1");
    expect(estate.totals).toEqual({ projects: 2, waiting: 1, drifted_projects: 1, drifted_roots: 1, failed_roots: 0, unreadable: 2, overdue: 1, ephemeral: 1 });
    expect(estate.dora).toEqual({ file: "dora.json", generated: "2026-10-27T12:00:00.000Z", deployments: 3 });
  });

  test("a Terraform member: the newest commit's waves, its drift check and its overdue schedule", () => {
    const network = estate.projects[0]!;
    expect(network).toMatchObject({ project: "network", status: "ok", drifted: 0, failed: 0, waiting: [] });
    expect(network.apply).toEqual({ commit: "c3", waves: [expect.objectContaining({ stage: "tf-apply", wave: 1, roots: 1, changed: 1, applied: "2026-10-22T12:10:00.000Z", run: "r-c" })] });
    expect(network.drift).toMatchObject({ stage: "tf-drift", changed: 0, run: "d-2" });
    expect(network.overdue?.map((o) => o.op)).toEqual(["tf-drift"]);
  });

  test("a Pulumi member: a waiting wave, drift on no named stack, a live pull request environment", () => {
    const web = estate.projects[1]!;
    expect(web.waiting).toEqual([{ project: "web", wave: 1, commit: "p2", since: "2026-10-27T09:02:00.000Z", age_seconds: 10680, gate: "wave-1" }]);
    expect(web.apply?.waves[0]).toMatchObject({ approval: "waiting", waiting_since: "2026-10-27T09:02:00.000Z", status: "gated" });
    expect(web.drifted).toBe(1);
    expect(web.ephemeral).toEqual([{ pr: 12, env: "pr-12", commit: "p12", applied: "2026-10-26T10:00:00.000Z", expires: "2026-10-29T10:00:00.000Z", run_url: "https://forge.example/run/pr12" }]);
  });

  test("an approved share is marked, and the newest runs come newest first", () => {
    const share = estate.recent.find((r) => r.run === "r-a2");
    expect(share).toMatchObject({ approval: "approved", share: 1 });
    expect(estate.recent.slice(0, 3).map((r) => r.run)).toEqual(["r-e", "d-3", "d-2"]);
    // The deciding job is not a run on the page.
    expect(estate.recent.some((r) => r.run === "r-a0")).toBe(false);
  });

  test("a member the caller names with no row reads as no-index", () => {
    const e = buildEstate(rows, undefined, { now: NOW, members: ["network", "db"] });
    expect(e.projects[1]).toEqual({ project: "db", status: "no-index", waiting: [], drifted: 0, failed: 0 });
    expect(e.dora).toBeUndefined();
  });
});

describe("the page and its files", () => {
  const built = buildLedgerEstate({ load: { data: { ...emptyData(), ...ESTATE_TABLES }, malformed: { ...emptyMalformed() } }, words: ply, now: NOW, schedules: [{ op: "tf-drift", cron: "0 6 * * *" }] });

  test("one section per member, the delivery section, and the product's own sections", () => {
    const html = renderEstateHtml(built.estate, built.dora, ply, { member: (p) => `<p class="mine">${p.project} extra</p>`, sections: [{ title: "Versions", html: "<p>v</p>" }] });
    expect(html).toContain('<section class="member" id="member-network">');
    expect(html).toContain('<section class="member" id="member-web">');
    expect(html).toContain("<title>plywood estate</title>");
    expect(html).toContain("2 stacks, 1 waiting");
    expect(html).toContain("wave 1 waits at wave-1, for 2h 58m");
    expect(html).toContain("plywood drift checks of stack `network` are overdue");
    expect(html).toContain('<table id="dora">');
    expect(html).toContain('<p class="mine">web extra</p>');
    expect(html).toContain("<h2>Versions</h2>");
  });

  test("the files are estate.json, estate.html and dora.json", () => {
    const files = estateFiles(built, ply);
    expect(Object.keys(files)).toEqual(["estate.json", "estate.html", "dora.json"]);
    expect(JSON.parse(files["dora.json"]!).schema).toBe("plywood.dora/v1");
    expect(JSON.parse(files["estate.json"]!).projects.map((p: { project: string }) => p.project)).toEqual(["network", "web"]);
  });

  test("writeEstate puts each file under the prefix and sends the gauges to the metrics endpoint", async () => {
    const put: Array<[string, string]> = [];
    const sent: Array<{ url: string; body: string }> = [];
    const fetch: OtlpFetch = async (url, init) => {
      sent.push({ url, body: init.body });
      return { ok: true, status: 200, text: async () => "" };
    };
    const result = await writeEstate(built, {
      put: async (key, _body, type) => {
        put.push([key, type]);
      },
      prefix: "/reports/estate/",
      words: ply,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" },
      fetch,
    });
    expect(put).toEqual([
      ["reports/estate/estate.json", "application/json"],
      ["reports/estate/estate.html", "text/html; charset=utf-8"],
      ["reports/estate/dora.json", "application/json"],
    ]);
    expect(result.keys).toHaveLength(3);
    expect(result.metrics).toEqual({ sent: deliveryGauges(built.dora, ply).length });
    expect(sent[0]!.url).toBe("http://127.0.0.1:4318/v1/metrics");
    const body = JSON.parse(sent[0]!.body);
    expect(body.resourceMetrics[0].resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "plywood" } });
    expect(body.resourceMetrics[0].scopeMetrics[0].metrics.map((m: { name: string }) => m.name)).toContain("plywood_dora_deployments_per_week");
  });

  test("with no endpoint no gauge is sent, and a collector that fails is the problem", async () => {
    const quiet = await writeEstate(built, { put: async () => {}, env: {} });
    expect(quiet.metrics).toBeUndefined();
    const failing: OtlpFetch = async () => ({ ok: false, status: 503, text: async () => "busy" });
    const loud = await writeEstate(built, { put: async () => {}, env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:4318/m" }, fetch: failing });
    expect(loud.metrics).toEqual({ problem: "http://127.0.0.1:4318/m answered 503: busy" });
  });

  test("the metrics settings follow the OTLP variables", () => {
    expect(otlpMetricsFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_METRICS_EXPORTER: "none" })).toBeUndefined();
    expect(otlpMetricsFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_SDK_DISABLED: "true" })).toBeUndefined();
    expect(otlpMetricsFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" })?.skipped[0]).toMatch(/grpc/);
    const body = otlpMetricsBody([{ name: "a", unit: "s", description: "d", value: 1.5, attributes: { project: "*" } }], { "service.name": "x" }, 7n, "0.0.0") as { resourceMetrics: { scopeMetrics: { metrics: unknown[] }[] }[] };
    expect(body.resourceMetrics[0]!.scopeMetrics[0]!.metrics).toEqual([{ name: "a", unit: "s", description: "d", gauge: { dataPoints: [{ attributes: [{ key: "project", value: { stringValue: "*" } }], timeUnixNano: "7", asDouble: 1.5 } ] } }]);
  });
});

function emptyData() {
  return { resources: [], snapshots: [], runs: [], gates: [], deploys: [], releases: [], cuts: [], applies: [], pr_envs: [], control_entries: [], release_status: [] };
}

function emptyMalformed() {
  return { resources: 0, snapshots: 0, runs: 0, gates: 0, deploys: 0, releases: 0, cuts: 0, applies: 0, pr_envs: 0, control_entries: 0, release_status: 0 };
}
