/**
 * `describeResources` (#3371) against a fake Mimir ruler and a fake
 * Alertmanager behind real HTTP servers on localhost (./api/fake-servers.ts),
 * so the default fetch transport, the tenant header and the token are on
 * the path; and the shared observation conformance suite over the same
 * fakes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeObservationConformance } from "@intentius/chant-test-utils";
import { normalizeObservation } from "@intentius/chant/observation";
import { describeResources, type PrometheusObserveOptions } from "./describe-resources";
import { fakeAlertmanager, fakeHttp, fakeRuler, serveFake, type FakeAlertmanagerState, type FakeRulerState } from "./api/fake-servers";
import { prometheusPlugin } from "./plugin";
import { RuleGroup, ruleGroupConfig, type RuleGroupEntity } from "./rules";
import { InhibitRule, Receiver, Route, TimeInterval, AlertmanagerSettings } from "./alertmanager";
import { SCRAPE_CONFIG_TYPE } from "./prometheus-config";
import type { RawRuleGroup } from "./api/ruler";

type Entities = PrometheusObserveOptions["entities"];

const api = new RuleGroup({
  name: "api",
  interval: "30s",
  rules: [
    { record: "job:http_requests:rate5m", expr: "sum by (job) (rate(http_requests_total[5m]))" },
    { alert: "ApiDown", expr: "up{job=\"api\"} == 0", for: "5m", labels: { severity: "page" } },
  ],
});
const infra = new RuleGroup({ name: "infra", rules: [{ record: "node:up:sum", expr: "sum(up{job=\"node\"})" }] });
const missing = new RuleGroup({ name: "missing", rules: [{ record: "x:y", expr: "sum(x)" }] });

const team = new Receiver({ name: "team", webhook_configs: [{ url: "http://hooks.example.com/team" }] });
const pager = new Receiver({ name: "pager", email_configs: [{ to: "oncall@example.com" }] });
const ghost = new Receiver({ name: "ghost" });
const weekends = new TimeInterval({ name: "weekends", time_intervals: [{ weekdays: ["saturday", "sunday"] }] });
const pageRoute = new Route({ receiver: "pager", matchers: ['severity = "page"'], mute_time_intervals: [weekends] });
const root = new Route({ receiver: team, group_by: ["alertname"], routes: [pageRoute] });
const inhibit = new InhibitRule({ source_matchers: ['severity="page"'], target_matchers: ['severity="ticket"'], equal: ["alertname"] });
const settings = new AlertmanagerSettings({ global: { smtp_from: "am@example.com", smtp_smarthost: "smtp.example.com:587" } });

function entities(pairs: Record<string, { entityType: string; props: unknown }>): Entities {
  return new Map(Object.entries(pairs).map(([n, e]) => [n, { entityType: e.entityType, props: e.props as Record<string, unknown> }]));
}

const ALL = entities({
  api,
  infra,
  missing,
  team,
  pager,
  ghost,
  weekends,
  pageRoute,
  root,
  inhibit,
  settings,
  scrape: { entityType: SCRAPE_CONFIG_TYPE, props: { job_name: "node" } },
});

const raw = (g: RuleGroupEntity) => ruleGroupConfig(g) as unknown as RawRuleGroup;

function rulerState(overrides: Partial<FakeRulerState> = {}): FakeRulerState {
  return {
    kind: "mimir",
    tenant: "shop",
    namespaces: {
      shop: [raw(api), { name: "checkout", rules: [] }],
      platform: [raw(infra)],
      // Not declared by the project: never read.
      other: [{ name: "foreign", rules: [{ record: "a:b", expr: "sum(a)" }] }],
    },
    evaluated: [
      {
        name: "api",
        file: "shop",
        interval: 30,
        rules: [
          { type: "recording", name: "job:http_requests:rate5m", query: "sum by (job) (rate(http_requests_total[5m]))", health: "err", lastError: "many-to-many matching not allowed" },
          { type: "alerting", name: "ApiDown", query: 'up{job="api"} == 0', duration: 300, health: "ok", state: "firing" },
        ],
      },
      { name: "infra", file: "platform", interval: 60, rules: [{ type: "recording", name: "node:up:sum", query: 'sum(up{job="node"})', health: "ok" }] },
    ],
    ...overrides,
  };
}

const original = readFileSync(join(import.meta.dirname, "api", "testdata", "am-status-original.yml"), "utf8");
const amState = (overrides: Partial<FakeAlertmanagerState> = {}): FakeAlertmanagerState => ({ kind: "alertmanager", original, version: "0.34.1", ...overrides });

const ENV = { MIMIR_TOKEN: "t0k" };
let rulerUrl = "";
let amUrl = "";
let closeRuler: () => Promise<void>;
let closeAm: () => Promise<void>;
const rulerCalls: string[] = [];
let ruler = rulerState();

beforeAll(async () => {
  // The handler reads `ruler` on every request, so a test can swap the state.
  const r = await serveFake((req) => {
    if (req.headers.authorization !== "Bearer t0k") return { status: 401, text: "bad token" };
    return fakeRuler(ruler, rulerCalls)(req);
  });
  const a = await serveFake(fakeAlertmanager(amState()));
  rulerUrl = r.url;
  amUrl = a.url;
  closeRuler = r.close;
  closeAm = a.close;
});
afterAll(async () => {
  await closeRuler?.();
  await closeAm?.();
});

function config(over: { tenant?: string; withAlertmanager?: boolean } = {}) {
  return {
    prometheus: {
      profiles: {
        prod: {
          ruler: {
            kind: "mimir" as const,
            url: rulerUrl,
            tenant: over.tenant ?? "shop",
            namespace: "shop",
            groupNamespaces: { infra: "platform" },
            token: { env: "MIMIR_TOKEN" },
          },
          ...(over.withAlertmanager === false ? {} : { alertmanager: { url: amUrl } }),
        },
      },
    },
  };
}

function run(opts: Partial<PrometheusObserveOptions> = {}, over: Parameters<typeof config>[0] = {}) {
  return describeResources({
    environment: "prod",
    entityNames: [...ALL.keys()],
    entities: ALL,
    config: config(over),
    env: ENV,
    ...opts,
  });
}

describe("describeResources: rule groups", () => {
  it("reads each group in the namespace the profile gives it, over the config API, with the tenant header", async () => {
    ruler = rulerState();
    const { resources, queried, unobserved } = normalizeObservation(await run());
    expect(resources.api).toMatchObject({ type: "Prometheus::Rules::RuleGroup", physicalId: "shop/api", status: "PRESENT", ownership: "unknown" });
    expect(resources.infra).toMatchObject({ physicalId: "platform/infra", attributes: { namespace: "platform", rules: 1, health: "ok" } });
    expect(queried.api).toBe("/prometheus/config/v1/rules/shop/api");
    expect(queried.infra).toBe("/prometheus/config/v1/rules/platform/infra");
    expect(resources.missing).toBeUndefined();
    expect(unobserved.missing).toBeUndefined();
    expect(queried.missing).toBe("/prometheus/config/v1/rules/shop/missing");
  });

  it("reports each group's health from /api/v1/rules: err with the first rule error, firing and pending counted", async () => {
    ruler = rulerState();
    const { resources } = normalizeObservation(await run());
    expect(resources.api.attributes).toMatchObject({
      namespace: "shop",
      rules: 2,
      interval: "30s",
      health: "err",
      lastError: "job:http_requests:rate5m: many-to-many matching not allowed",
      failing: 1,
      firing: 1,
      pending: 0,
    });
  });

  it("never reads a namespace the project does not declare", async () => {
    ruler = rulerState();
    rulerCalls.length = 0;
    await run();
    expect(rulerCalls.length).toBeGreaterThan(0);
    expect(rulerCalls.filter((c) => c.includes("/other"))).toEqual([]);
    // No list of every namespace, either.
    expect(rulerCalls).not.toContain("GET /prometheus/config/v1/rules");
  });

  it("a group the ruler has not evaluated yet, or a health API that is down, leaves the group present with health unknown", async () => {
    ruler = rulerState({ evaluated: [] });
    let { resources } = normalizeObservation(await run());
    expect(resources.api.attributes).toMatchObject({ health: "unknown" });
    ruler = rulerState({ evaluatedStatus: 503 });
    ({ resources } = normalizeObservation(await run()));
    expect(resources.api).toMatchObject({ status: "PRESENT", attributes: { health: "unknown" } });
    expect(String(resources.api.attributes?.healthDetail)).toContain("returned 503");
  });

  it("a wrong tenant is no-credentials and a 500 is read-failed, never absent; the Alertmanager entities are still read", async () => {
    ruler = rulerState();
    let { unobserved, resources } = normalizeObservation(await run({}, { tenant: "someone-else" }));
    expect(unobserved.api.reason).toBe("no-credentials");
    expect(unobserved.missing.reason).toBe("no-credentials");
    expect(resources.team).toBeDefined();
    ruler = rulerState({ status: 500 });
    ({ unobserved } = normalizeObservation(await run()));
    expect(unobserved.api.reason).toBe("read-failed");
  });

  it("a token variable that is not set makes every group no-credentials", async () => {
    ruler = rulerState();
    const { unobserved } = normalizeObservation(await run({ env: {} }));
    expect(unobserved.api).toMatchObject({ reason: "no-credentials" });
    expect(unobserved.api.detail).toContain("MIMIR_TOKEN");
  });

  it("on a plain Prometheus, groups are read from /api/v1/rules by name", async () => {
    const state: FakeRulerState = {
      kind: "prometheus",
      namespaces: { "/etc/prometheus/rules.yml": [raw(api)] },
    };
    const { resources, queried } = normalizeObservation(
      await describeResources({
        environment: "prod",
        entityNames: ["api", "missing"],
        entities: ALL,
        config: { prometheus: { profiles: { prod: { ruler: { kind: "prometheus", url: "http://prometheus.test" } } } } },
        env: {},
        http: { ruler: fakeHttp(fakeRuler(state)) },
      }),
    );
    expect(resources.api).toMatchObject({ physicalId: "/etc/prometheus/rules.yml/api", attributes: { file: "/etc/prometheus/rules.yml", rules: 2, health: "ok" } });
    expect(resources.missing).toBeUndefined();
    expect(queried.missing).toBe("/api/v1/rules");
  });
});

describe("describeResources: Alertmanager", () => {
  it("finds receivers and time intervals by name, routes by receiver and matchers, inhibit rules by matchers", async () => {
    ruler = rulerState();
    const { resources, queried } = normalizeObservation(await run());
    expect(resources.team).toMatchObject({ type: "Prometheus::Alertmanager::Receiver", physicalId: "receiver/team", attributes: { integrations: ["webhook_configs"] } });
    expect(resources.pager.attributes).toMatchObject({ integrations: ["email_configs", "pagerduty_configs"] });
    expect(resources.ghost).toBeUndefined();
    expect(queried.ghost).toBe("/api/v2/status");
    expect(resources.weekends).toMatchObject({ physicalId: "time_interval/weekends" });
    expect(resources.root).toMatchObject({ physicalId: "route/team{}", attributes: { receiver: "team", routes: 1 } });
    // Declared with spaces around the operator; Alertmanager writes severity="page".
    expect(resources.pageRoute).toMatchObject({ physicalId: 'route/pager{severity="page"}' });
    expect(resources.inhibit).toMatchObject({ physicalId: "inhibit_rule/0" });
  });

  it("carries the cluster status and version on every entity, and a config digest on the settings", async () => {
    ruler = rulerState();
    const { resources } = normalizeObservation(await run());
    expect(resources.team.attributes).toMatchObject({ cluster: "ready", version: "0.34.1", peers: 1 });
    expect(resources.settings).toMatchObject({ physicalId: "alertmanager" });
    expect(String(resources.settings.attributes?.configDigest)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("no Alertmanager in the profile is no-binding for its entities only", async () => {
    ruler = rulerState();
    const { unobserved, resources } = normalizeObservation(await run({}, { withAlertmanager: false }));
    expect(unobserved.team.reason).toBe("no-binding");
    expect(unobserved.settings.reason).toBe("no-binding");
    expect(resources.api).toBeDefined();
  });

  it("a Mimir tenant with no Alertmanager config has every entity absent", async () => {
    const state = amState({ kind: "mimir", tenant: "shop" });
    const { resources, unobserved } = normalizeObservation(
      await describeResources({
        environment: "prod",
        entityNames: ["team", "settings"],
        entities: ALL,
        config: { prometheus: { profiles: { prod: { alertmanager: { kind: "mimir", url: "http://mimir.test", tenant: "shop" } } } } },
        env: {},
        http: { alertmanager: fakeHttp(fakeAlertmanager(state), { "x-scope-orgid": "shop" }) },
      }),
    );
    expect(resources).toEqual({});
    expect(unobserved).toEqual({});
  });

  it("prometheus.yml entities are unsupported-kind", async () => {
    ruler = rulerState();
    expect(normalizeObservation(await run()).unobserved.scrape.reason).toBe("unsupported-kind");
  });
});

it("owned: true withholds everything present as filtered, since nothing carries a marker", async () => {
  ruler = rulerState();
  const { resources, unobserved } = normalizeObservation(await run({ owned: true }));
  expect(resources).toEqual({});
  expect(unobserved.api.reason).toBe("filtered");
  expect(unobserved.team.reason).toBe("filtered");
});

describeObservationConformance({
  lexicon: "prometheus",
  ownershipChannel: prometheusPlugin.ownershipChannel,
  scenarios: [
    {
      name: "a Mimir ruler and an Alertmanager",
      declared: [...ALL.keys()],
      run: () => {
        ruler = rulerState();
        return run();
      },
      expectPresent: ["api", "infra", "team", "pager", "weekends", "pageRoute", "root", "inhibit", "settings"],
      expectAbsent: ["missing", "ghost"],
      expectUnobserved: ["scrape"],
    },
    {
      name: "owned: true withholds what carries no marker",
      declared: [...ALL.keys()],
      owned: true,
      run: () => {
        ruler = rulerState();
        return run({ owned: true });
      },
      expectAbsent: ["missing", "ghost"],
      expectUnobserved: ["api", "infra", "team", "settings", "scrape"],
    },
  ],
});
