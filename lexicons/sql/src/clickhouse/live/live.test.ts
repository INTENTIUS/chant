import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { describeObservationConformance } from "@intentius/chant-test-utils";
import { normalizeObservation } from "@intentius/chant/observation";
import { resolveClickHouseTarget, isUnresolvedTarget } from "./bind";
import { describeResources } from "./describe-resources";
import { fakeClickHouse, type FakeServer } from "../testing/fake-server";
import { database, table, view } from "../entities";
import { SQL_OWNERSHIP_CHANNEL } from "../ownership";

const analytics = database`CREATE DATABASE analytics ENGINE = Atomic`;
const events = table`CREATE TABLE ${analytics}.events (id UInt64) ENGINE = MergeTree ORDER BY id`;
const missing = table`CREATE TABLE ${analytics}.missing (id UInt64) ENGINE = Log`;
const inDefault = table`CREATE TABLE plain (id UInt64) ENGINE = Log`;
const byId = view`CREATE VIEW analytics.by_id AS SELECT id FROM ${events}`;

const LIVE = [
  { name: "analytics", engine: "Atomic", statement: "CREATE DATABASE analytics\nENGINE = Atomic" },
  {
    database: "analytics",
    name: "events",
    engine: "MergeTree",
    comment: "Raw events [chant managed-by=chant stack=shop env=prod]",
    statement: "CREATE TABLE analytics.events\n(\n    `id` UInt64\n)\nENGINE = MergeTree\nORDER BY id\nSETTINGS index_granularity = 8192\nCOMMENT 'Raw events [chant managed-by=chant stack=shop env=prod]'",
  },
  { database: "analytics", name: "by_id", engine: "View", statement: "CREATE VIEW analytics.by_id\n(\n    `id` UInt64\n)\nAS SELECT id\nFROM analytics.events" },
  { database: "default", name: "plain", engine: "Log", statement: "CREATE TABLE default.plain\n(\n    `id` UInt64\n)\nENGINE = Log" },
];

const entities = new Map(
  Object.entries({ analytics, events, missing, inDefault, byId }).map(([k, v]) => [k, { entityType: v.entityType, props: v.props as unknown as Record<string, unknown> }]),
);
const entityNames = [...entities.keys()];

let ok: FakeServer;
let refused: FakeServer;
beforeAll(async () => {
  ok = await fakeClickHouse(LIVE);
  refused = await fakeClickHouse([], { fail: { status: 516, body: "Code: 516. DB::Exception: default: Authentication failed. (AUTHENTICATION_FAILED)" } });
});
afterAll(async () => {
  await ok.close();
  await refused.close();
});

const run = (url: string | undefined, owned?: boolean) =>
  describeResources({ environment: "test", entityNames, entities, config: {}, env: url ? { CLICKHOUSE_URL: url } : {}, ...(owned ? { owned } : {}) });

describe("binding an environment to a server", () => {
  test("a profile is the server, its credentials read from the variables it names", () => {
    const t = resolveClickHouseTarget({
      environment: "prod",
      config: { sql: { profiles: { prod: { url: "https://ch:8443/", user: { env: "U" }, password: { env: "P" }, databases: ["analytics"] } } } },
      env: { U: "reader", P: "pw" },
    });
    expect(t).toEqual({
      endpoint: { url: "https://ch:8443", user: "reader", password: "pw" },
      source: "sql.profiles.prod",
      databases: ["analytics"],
      defaultDatabase: "default",
    });
  });

  test("access is managed only where the profile says so (#3716)", () => {
    const on = resolveClickHouseTarget({ environment: "prod", config: { sql: { profiles: { prod: { url: "http://ch:8123", access: true } } } } as never, env: {} });
    expect(on).toMatchObject({ access: true });
    const off = resolveClickHouseTarget({ environment: "prod", config: { sql: { profiles: { prod: { url: "http://ch:8123" } } } } as never, env: {} });
    expect(off).not.toHaveProperty("access");
    expect(resolveClickHouseTarget({ env: { CLICKHOUSE_URL: "http://ch:8123" } })).not.toHaveProperty("access");
  });

  test("a credential variable the profile names but nobody set is no-credentials", () => {
    const t = resolveClickHouseTarget({ environment: "prod", config: { sql: { profiles: { prod: { url: "x", password: { env: "P" } } } } }, env: {} });
    expect(isUnresolvedTarget(t) && t.reason).toBe("no-credentials");
  });

  test("the topology comes from the profile, or CLICKHOUSE_TOPOLOGY, and is undefined when neither names one (#3645)", () => {
    const profile = (topology: unknown) =>
      resolveClickHouseTarget({ environment: "prod", config: { sql: { profiles: { prod: { url: "http://ch:8123", topology } } } } as never, env: {} });
    expect(profile("cluster:main")).toMatchObject({ topology: { kind: "cluster", cluster: "main" } });
    expect(profile({ kind: "replicated", cluster: "all" })).toMatchObject({ topology: { kind: "replicated", cluster: "all" } });
    expect(resolveClickHouseTarget({ env: { CLICKHOUSE_URL: "http://ch:8123", CLICKHOUSE_TOPOLOGY: "cloud" } })).toMatchObject({ topology: { kind: "cloud" } });
    expect("topology" in resolveClickHouseTarget({ env: { CLICKHOUSE_URL: "http://ch:8123" } })).toBe(false);
    expect(() => resolveClickHouseTarget({ env: { CLICKHOUSE_URL: "http://ch:8123", CLICKHOUSE_TOPOLOGY: "sharded" } })).toThrow(/unknown topology/);
  });

  test("no profile and no CLICKHOUSE_URL is no-binding", () => {
    const t = resolveClickHouseTarget({ environment: "dev", config: {}, env: {} });
    expect(isUnresolvedTarget(t) && t.reason).toBe("no-binding");
  });
});

describe("describeResources", () => {
  test("reports present objects with their engine, an undeclared-on-server one absent, and where it asked", async () => {
    const r = normalizeObservation(await run(ok.url));
    expect(Object.keys(r.resources).sort()).toEqual(["analytics", "byId", "events", "inDefault"]);
    expect(r.resources.events).toMatchObject({ type: "ClickHouse::Table", status: "MergeTree", ownership: "owned" });
    expect(r.resources.byId).toMatchObject({ type: "ClickHouse::View", status: "View", ownership: "foreign" });
    expect(r.unobserved).toEqual({});
    expect(r.queried?.missing).toBe(`${ok.url} analytics.missing`);
    expect(r.queried?.inDefault).toBe(`${ok.url} default.plain`);
  });

  test("an owned object carries the marker's stack and env, and its comment without the trailer (#3208)", async () => {
    const r = normalizeObservation(await run(ok.url));
    expect(r.resources.events!.marker).toEqual({ stack: "shop", env: "prod" });
    expect(r.resources.events!.attributes).toMatchObject({ comment: "Raw events" });
    expect(r.resources.byId!.marker).toBeUndefined();
  });

  test("owned withholds a foreign object as filtered, never as absent (#3208)", async () => {
    const r = normalizeObservation(await run(ok.url, true));
    expect(Object.keys(r.resources)).toEqual(["events"]);
    expect(Object.fromEntries(Object.entries(r.unobserved).map(([k, v]) => [k, v.reason]))).toEqual({
      analytics: "filtered",
      inDefault: "filtered",
      byId: "filtered",
    });
  });

  test("reads the catalog in three queries, whatever the number of entities", async () => {
    const before = ok.queries.length;
    await run(ok.url);
    expect(ok.queries.length - before).toBe(3);
  });
});

describeObservationConformance({
  lexicon: "sql",
  ownershipChannel: SQL_OWNERSHIP_CHANNEL,
  scenarios: [
    {
      name: "owned: only what carries chant's marker",
      declared: entityNames,
      owned: true,
      run: () => run(ok.url, true),
      expectPresent: ["events"],
      expectAbsent: ["missing"],
      expectUnobserved: ["analytics", "inDefault", "byId"],
      expectMarker: { events: { stack: "shop", env: "prod" } },
    },
    {
      name: "a server holding some of the declared schema",
      declared: entityNames,
      run: () => run(ok.url),
      expectPresent: ["analytics", "events", "inDefault", "byId"],
      expectAbsent: ["missing"],
    },
    {
      name: "a server that refuses the credentials",
      declared: entityNames,
      run: () => run(refused.url),
      expectUnobserved: entityNames,
    },
    {
      name: "no server bound",
      declared: entityNames,
      run: () => run(undefined),
      expectUnobserved: entityNames,
    },
  ],
});
