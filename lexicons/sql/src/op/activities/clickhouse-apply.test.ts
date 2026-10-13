import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { describeApplyConformance } from "@intentius/chant-test-utils";
import { normalizeApply } from "@intentius/chant/apply";
import { clickhouseApply, resolveMarker, toApplyResult, type ClickHouseApplyDeps } from "./clickhouse-apply";
import { writableClickHouse, type StoredObject, type WritableServer } from "../../clickhouse/testing/writable-server";
import { ClickHouseApplyError } from "../../clickhouse/apply/apply";

const dirs: string[] = [];
const servers: WritableServer[] = [];
afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const s of servers) await s.close();
});

interface Obj {
  export: string;
  type: string;
  ddl: string;
  dependsOn?: string[];
}

const DB: Obj = { export: "analytics", type: "ClickHouse::Database", ddl: "CREATE DATABASE analytics ENGINE = Atomic" };
const EVENTS: Obj = {
  export: "events",
  type: "ClickHouse::Table",
  ddl: "CREATE TABLE analytics.events (ts DateTime, user_id UInt64, kind String) ENGINE = MergeTree ORDER BY (ts, user_id) COMMENT 'Raw events'",
  dependsOn: ["analytics"],
};
const BY_KIND: Obj = { export: "byKind", type: "ClickHouse::View", ddl: "CREATE VIEW analytics.by_kind AS SELECT kind, count() AS n FROM analytics.events GROUP BY kind", dependsOn: ["events"] };

/** A build output the way `chant build -o dist/schema.json` writes it. */
function buildOutput(objects: Obj[]): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-clickhouse-apply-"));
  dirs.push(dir);
  const path = join(dir, "schema.json");
  writeFileSync(path, JSON.stringify({ dialect: "clickhouse", applyOrder: objects.map((o) => o.export), objects: objects.map((o) => ({ dependsOn: [], ...o })) }));
  return path;
}

async function server(objects: StoredObject[] = []): Promise<WritableServer> {
  const s = await writableClickHouse(objects);
  servers.push(s);
  return s;
}

const OURS = "[chant managed-by=chant stack=shop env=prod]";
const deps = (s: WritableServer | undefined, extra: Partial<ClickHouseApplyDeps> = {}): ClickHouseApplyDeps => ({
  config: { ownership: { stack: "shop", env: "prod" } },
  env: s ? { CLICKHOUSE_URL: s.url } : {},
  log: () => undefined,
  ...extra,
});

const run = async (s: WritableServer | undefined, objects: Obj[], args: { prune?: boolean } = {}, extra: Partial<ClickHouseApplyDeps> = {}) =>
  toApplyResult(await clickhouseApply({ buildPath: buildOutput(objects), environment: "test", ...args }, undefined, deps(s, extra)));

/** A live object as `SHOW CREATE` prints it, marked or not. */
function live(database: string | undefined, name: string, statement: string, comment?: string): StoredObject {
  const engine = /^CREATE DATABASE/.test(statement) ? "Atomic" : /^CREATE VIEW/.test(statement) ? "View" : "MergeTree";
  return { ...(database ? { database } : {}), name, engine, statement: comment ? `${statement}\nCOMMENT '${comment}'` : statement, ...(comment ? { comment } : {}) };
}
const liveDb = (comment = OURS) => live(undefined, "analytics", "CREATE DATABASE analytics\nENGINE = Atomic", comment);
const liveEvents = (comment = `Raw events ${OURS}`) =>
  live("analytics", "events", "CREATE TABLE analytics.events\n(\n    `ts` DateTime,\n    `user_id` UInt64,\n    `kind` String\n)\nENGINE = MergeTree\nORDER BY (ts, user_id)\nSETTINGS index_granularity = 8192", comment);

describe("creating", () => {
  test("an empty server gets every object, each created with chant's marker in its comment", async () => {
    const s = await server();
    const r = normalizeApply(await run(s, [DB, EVENTS, BY_KIND]));
    expect(r.applied.map((a) => [a.name, a.action])).toEqual([
      ["analytics", "created"],
      ["analytics.events", "created"],
      ["analytics.by_kind", "created"],
    ]);
    expect(s.writes[0]).toBe(`CREATE DATABASE analytics ENGINE = Atomic COMMENT '${OURS}'`);
    expect(s.writes[1]).toContain(`COMMENT 'Raw events ${OURS}'`);
    expect(s.writes[2]).toMatch(/GROUP BY kind COMMENT '\[chant managed-by=chant stack=shop env=prod\]'$/);
  });

  test("without an ownership stack the marker says managed-by alone", async () => {
    const s = await server();
    await run(s, [DB], {}, { config: {} });
    expect(s.writes[0]).toBe("CREATE DATABASE analytics ENGINE = Atomic COMMENT '[chant managed-by=chant]'");
  });
});

describe("updating", () => {
  test("an added column goes in at its declared place", async () => {
    const s = await server([liveDb(), liveEvents()]);
    const withRegion = { ...EVENTS, ddl: EVENTS.ddl.replace("user_id UInt64,", "user_id UInt64, region LowCardinality(String) DEFAULT 'eu',") };
    const r = normalizeApply(await run(s, [DB, withRegion]));
    expect(r.applied.map((a) => [a.name, a.action])).toEqual([
      ["analytics", "unchanged"],
      ["analytics.events", "updated"],
    ]);
    expect(s.writes).toEqual(["ALTER TABLE `analytics`.`events` ADD COLUMN region LowCardinality(String) DEFAULT 'eu' AFTER `user_id`"]);
  });

  test("a column type change waits on its mutation", async () => {
    const s = await server([liveDb(), liveEvents()]);
    s.mutations.push({ database: "analytics", table: "events", mutation_id: "mutation_7.txt" });
    setTimeout(() => (s.mutations.length = 0), 150);
    const r = normalizeApply(await run(s, [DB, { ...EVENTS, ddl: EVENTS.ddl.replace("kind String", "kind LowCardinality(String)") }]));
    expect(r.applied.find((a) => a.name === "analytics.events")?.action).toBe("updated");
    expect(s.writes).toEqual(["ALTER TABLE `analytics`.`events` MODIFY COLUMN `kind` LowCardinality(String)"]);
  });

  test("a mutation still running at the timeout fails the apply, naming the mutation", async () => {
    const s = await server([liveDb(), liveEvents()]);
    s.mutations.push({ database: "analytics", table: "events", mutation_id: "mutation_9.txt" });
    const err = await clickhouseApply(
      { buildPath: buildOutput([DB, { ...EVENTS, ddl: EVENTS.ddl.replace("kind String", "kind LowCardinality(String)") }]), environment: "test", mutationTimeoutMs: 300 },
      undefined,
      deps(s),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClickHouseApplyError);
    expect((err as Error).message).toMatch(/mutation_9\.txt was still running/);
    expect((err as ClickHouseApplyError).outcome.applied.map((a) => a.name)).toEqual(["analytics"]);
  });

  test("a refused rebuild is not attempted, with the restriction and the rebuild Op named", async () => {
    const s = await server([liveDb(), liveEvents()]);
    const r = normalizeApply(await run(s, [DB, { ...EVENTS, ddl: EVENTS.ddl.replace("ORDER BY (ts, user_id)", "ORDER BY (user_id, ts)") }]));
    expect(r.notAttempted).toHaveLength(1);
    expect(r.notAttempted[0]).toMatchObject({ kind: "ClickHouse::Table", name: "analytics.events", reason: "unsupported-kind" });
    expect(r.notAttempted[0]!.detail).toMatch(/SQLCH220 Change the sorting key/);
    expect(r.notAttempted[0]!.detail).toMatch(/clickhouse\.com\/docs/);
    expect(r.notAttempted[0]!.detail).toContain('ClickHouseRebuildOp({ table: "analytics.events"');
    expect(s.writes).toEqual([]);
  });

  test("a column drop is withheld unless the apply may delete", async () => {
    const s = await server([liveDb(), liveEvents()]);
    const without = { ...EVENTS, ddl: EVENTS.ddl.replace(", kind String", "") };
    const withheld = normalizeApply(await run(s, [DB, without]));
    expect(withheld.notAttempted[0]).toMatchObject({ name: "analytics.events", reason: "filtered" });
    expect(s.writes).toEqual([]);
    await run(s, [DB, without], { prune: true });
    expect(s.writes).toEqual(["ALTER TABLE `analytics`.`events` DROP COLUMN `kind`"]);
  });

  test("an object whose comment lost the marker is stamped again, its own comment kept", async () => {
    const s = await server([liveDb(), liveEvents("Raw events")]);
    const r = normalizeApply(await run(s, [DB, EVENTS]));
    expect(r.applied.find((a) => a.name === "analytics.events")?.action).toBe("updated");
    expect(s.writes).toEqual([`ALTER TABLE \`analytics\`.\`events\` MODIFY COMMENT 'Raw events ${OURS}'`]);
  });

  test("a statement the server refuses fails the apply and the objects depending on it are not attempted", async () => {
    const s = await server();
    s.refuse = /CREATE TABLE/;
    const err = (await clickhouseApply({ buildPath: buildOutput([DB, EVENTS, BY_KIND]), environment: "test" }, undefined, deps(s)).catch((e: unknown) => e)) as ClickHouseApplyError;
    expect(err).toBeInstanceOf(ClickHouseApplyError);
    expect(err.outcome.failed.map((f) => f.name)).toEqual(["analytics.events"]);
    expect(err.outcome.notAttempted).toMatchObject([{ name: "analytics.by_kind", reason: "dependency-failed" }]);
  });
});

describe("resolveMarker", () => {
  test("the arguments win over the config, and a parameter-reference env needs ownershipEnv", () => {
    expect(resolveMarker({ stack: "a" }, { ownership: { stack: "b", env: "prod" } })).toEqual({ stack: "a", env: "prod" });
    expect(resolveMarker({}, { ownership: { stack: "b", enabled: false } })).toBeUndefined();
    expect(() => resolveMarker({}, { ownership: { stack: "b", env: { param: "env" } } as never })).toThrow(/ownershipEnv/);
  });
});

describeApplyConformance({
  lexicon: "sql",
  scenarios: [
    {
      name: "a database, a table and a view on an empty server",
      plan: [
        { kind: "ClickHouse::Database", name: "analytics" },
        { kind: "ClickHouse::Table", name: "analytics.events" },
        { kind: "ClickHouse::View", name: "analytics.by_kind" },
      ],
      run: async () => run(await server(), [DB, EVENTS, BY_KIND]),
      expectApplied: ["ClickHouse::Database/analytics", "ClickHouse::Table/analytics.events", "ClickHouse::View/analytics.by_kind"],
    },
    {
      name: "a sorting-key change refused as a rebuild beside an unchanged database",
      plan: [
        { kind: "ClickHouse::Database", name: "analytics" },
        { kind: "ClickHouse::Table", name: "analytics.events" },
      ],
      run: async () => run(await server([liveDb(), liveEvents()]), [DB, { ...EVENTS, ddl: EVENTS.ddl.replace("ORDER BY (ts, user_id)", "ORDER BY ts") }]),
      expectApplied: ["ClickHouse::Database/analytics"],
      expectNotAttempted: ["ClickHouse::Table/analytics.events"],
    },
    {
      name: "no server bound",
      plan: [
        { kind: "ClickHouse::Database", name: "analytics" },
        { kind: "ClickHouse::Table", name: "analytics.events" },
      ],
      run: () => run(undefined, [DB, EVENTS]),
      expectNotAttempted: ["ClickHouse::Database/analytics", "ClickHouse::Table/analytics.events"],
    },
    {
      name: "prune without an ownership stack",
      plan: [{ kind: "ClickHouse::Database", name: "analytics" }],
      run: async () => run(await server([liveDb("[chant managed-by=chant]"), liveEvents("[chant managed-by=chant]")]), [DB], { prune: true }, { config: {} }),
      expectApplied: ["ClickHouse::Database/analytics"],
      expectNotAttempted: ["ClickHouse::Table/analytics.events"],
    },
  ],
  pruneScenarios: [
    {
      name: "an owned orphan table beside one created by hand",
      ownedOrphan: "analytics.events",
      foreign: "analytics.handmade",
      run: async () => {
        const s = await server([liveDb(), liveEvents(), live("analytics", "handmade", "CREATE TABLE analytics.handmade\n(\n    `id` UInt64\n)\nENGINE = Log", "made by hand")]);
        return { result: await run(s, [DB], { prune: true }), deletes: s.deletes };
      },
    },
    {
      name: "an owned orphan table beside another stack's",
      ownedOrphan: "analytics.events",
      foreign: "analytics.theirs",
      run: async () => {
        const s = await server([
          liveDb(),
          liveEvents(),
          live("analytics", "theirs", "CREATE TABLE analytics.theirs\n(\n    `id` UInt64\n)\nENGINE = Log", "[chant managed-by=chant stack=other env=prod]"),
        ]);
        return { result: await run(s, [DB], { prune: true }), deletes: s.deletes };
      },
    },
  ],
  idempotenceScenarios: [
    {
      name: "the same build applied twice",
      run: async () => {
        const s = await server();
        const first = await run(s, [DB, EVENTS, BY_KIND]);
        const second = await run(s, [DB, EVENTS, BY_KIND]);
        return { first, second };
      },
    },
  ],
});

describe("idempotence", () => {
  test("the second apply sends nothing and reports every object unchanged", async () => {
    const s = await server();
    await run(s, [DB, EVENTS, BY_KIND]);
    const writes = s.writes.length;
    const second = normalizeApply(await run(s, [DB, EVENTS, BY_KIND]));
    expect(second.applied.map((a) => a.action)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(s.writes.length).toBe(writes);
  });

  test("prune keeps a database that still holds an object it does not drop", async () => {
    const s = await server([liveDb(), live("analytics", "handmade", "CREATE TABLE analytics.handmade\n(\n    `id` UInt64\n)\nENGINE = Log")]);
    // The build declares only a table in another database, so analytics itself is an owned orphan.
    const other: Obj = { export: "o", type: "ClickHouse::Table", ddl: "CREATE TABLE analytics.other (id UInt64) ENGINE = Log" };
    const r = normalizeApply(await run(s, [other], { prune: true }));
    expect(r.notAttempted).toMatchObject([{ name: "analytics", reason: "not-prunable" }]);
    expect(s.deletes).toEqual([]);
  });
});
