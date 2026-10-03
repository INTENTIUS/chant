/**
 * The ClickHouse applier against the pinned server (#3208): create, then a
 * column added, a TTL changed, a skip index added and a column type changed
 * as a mutation; a sorting-key change refused as a rebuild; the same build
 * applied twice; a prune that drops an owned table and spares one made by
 * hand.
 *
 * Needs Docker; skips cleanly without it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { normalizeApply } from "@intentius/chant/apply";
import { dockerAvailable, startScratchServer, type ScratchServer } from "../../clickhouse/container";
import { clickhouseQuery } from "../../clickhouse/http";
import { clickhouseImage } from "../../spec/pin";
import { planAgainstServer } from "../../clickhouse/plan/commands";
import { clickhouseApply, toApplyResult } from "./clickhouse-apply";

const enabled = await dockerAvailable();
let server: ScratchServer | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-sql-apply-"));

beforeAll(async () => {
  if (!enabled) return;
  server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-apply" });
}, 600_000);

afterAll(async () => {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

interface Obj {
  export: string;
  type: string;
  ddl: string;
  dependsOn?: string[];
}

let builds = 0;
function buildFile(objects: Obj[]): string {
  const path = join(dir, `schema-${builds++}.json`);
  writeFileSync(path, JSON.stringify({ dialect: "clickhouse", applyOrder: objects.map((o) => o.export), objects: objects.map((o) => ({ dependsOn: [], ...o })) }));
  return path;
}

const DB: Obj = { export: "shop", type: "ClickHouse::Database", ddl: "CREATE DATABASE shop ENGINE = Atomic COMMENT 'The shop'" };
const eventsV1: Obj = {
  export: "events",
  type: "ClickHouse::Table",
  dependsOn: ["shop"],
  ddl: `CREATE TABLE shop.events
(
  ts DateTime,
  user_id UInt64,
  kind String
)
ENGINE = MergeTree
ORDER BY (ts, user_id)
TTL ts + INTERVAL 180 DAY
COMMENT 'Raw events'`,
};
const eventsV2: Obj = {
  ...eventsV1,
  ddl: `CREATE TABLE shop.events
(
  ts DateTime,
  user_id UInt64,
  region LowCardinality(String) DEFAULT 'eu',
  kind LowCardinality(String),
  INDEX kind_idx kind TYPE set(100) GRANULARITY 4
)
ENGINE = MergeTree
ORDER BY (ts, user_id)
TTL ts + INTERVAL 90 DAY
COMMENT 'Raw events'`,
};
const OLD: Obj = { export: "old", type: "ClickHouse::Table", dependsOn: ["shop"], ddl: "CREATE TABLE shop.old_events (id UInt64) ENGINE = MergeTree ORDER BY id" };
const BY_KIND: Obj = {
  export: "byKind",
  type: "ClickHouse::View",
  dependsOn: ["events"],
  ddl: "CREATE VIEW shop.by_kind AS SELECT kind, count() AS n FROM shop.events GROUP BY kind",
};

const deps = () => ({ config: { ownership: { stack: "e2e", env: "test" } }, env: { CLICKHOUSE_URL: server!.endpoint.url }, log: () => undefined });
const apply = async (objects: Obj[], prune = false) => normalizeApply(toApplyResult(await clickhouseApply({ buildPath: buildFile(objects), environment: "e2e", prune }, undefined, deps())));
const q = <T = Record<string, unknown>>(sql: string) => clickhouseQuery<T>(server!.endpoint, sql);
const showCreate = async (name: string) => (await q<{ statement: string }>(`SHOW CREATE TABLE ${name}`))[0]!.statement;
const actions = (r: ReturnType<typeof normalizeApply>) => Object.fromEntries(r.applied.map((a) => [a.name, a.action]));

describe.skipIf(!enabled)("applying to a clickhouse-server", () => {
  test("an empty server gets the declared objects, each marked", async () => {
    const r = await apply([DB, eventsV1, OLD, BY_KIND]);
    expect(actions(r)).toEqual({ shop: "created", "shop.events": "created", "shop.old_events": "created", "shop.by_kind": "created" });
    expect(r.notAttempted).toEqual([]);
    const comments = await q<{ name: string; comment: string }>("SELECT name, comment FROM system.tables WHERE database = 'shop' ORDER BY name");
    expect(comments).toEqual([
      { name: "by_kind", comment: "[chant managed-by=chant stack=e2e env=test]" },
      { name: "events", comment: "Raw events [chant managed-by=chant stack=e2e env=test]" },
      { name: "old_events", comment: "[chant managed-by=chant stack=e2e env=test]" },
    ]);
    await q("INSERT INTO shop.events SELECT now() - number, number, if(number % 2, 'click', 'view') FROM numbers(10000)");
    // A table nobody declared, made by hand in the same database.
    await q("CREATE TABLE shop.handmade (id UInt64) ENGINE = Log COMMENT 'made by hand'");
  }, 120_000);

  test("a column added, a TTL changed, a skip index added and a type changed as a mutation", async () => {
    const r = await apply([DB, eventsV2, OLD, BY_KIND]);
    expect(actions(r)).toEqual({ shop: "unchanged", "shop.events": "updated", "shop.old_events": "unchanged", "shop.by_kind": "unchanged" });
    const ddl = await showCreate("shop.events");
    expect(ddl).toContain("`region` LowCardinality(String) DEFAULT 'eu'");
    expect(ddl).toContain("`kind` LowCardinality(String)");
    expect(ddl).toContain("INDEX kind_idx kind TYPE set(100) GRANULARITY 4");
    expect(ddl).toContain("TTL ts + toIntervalDay(90)");
    const pending = await q("SELECT mutation_id FROM system.mutations WHERE database = 'shop' AND NOT is_done");
    expect(pending).toEqual([]);
    const mutations = await q<{ command: string }>("SELECT command FROM system.mutations WHERE database = 'shop' AND table = 'events'");
    expect(mutations.some((m) => /MODIFY COLUMN `kind` LowCardinality\(String\)/.test(m.command))).toBe(true);
    // The server now holds the declaration: a plan finds nothing to change but
    // the table made by hand, which no build declares.
    const plan = await planAgainstServer("e2e", buildFile([DB, eventsV2, OLD, BY_KIND]), { config: {}, env: { CLICKHOUSE_URL: server!.endpoint.url } });
    expect(plan.changes.map((c) => [c.object, c.rule])).toEqual([["shop.handmade", "SQLCH250"]]);
  }, 180_000);

  test("a sorting-key change is refused as a rebuild and nothing is sent for it", async () => {
    const before = await showCreate("shop.events");
    const rebuilt = { ...eventsV2, ddl: eventsV2.ddl.replace("ORDER BY (ts, user_id)", "ORDER BY (user_id, ts)") };
    const r = await apply([DB, rebuilt, OLD, BY_KIND]);
    expect(r.notAttempted).toHaveLength(1);
    expect(r.notAttempted[0]).toMatchObject({ kind: "ClickHouse::Table", name: "shop.events", reason: "unsupported-kind" });
    expect(r.notAttempted[0]!.detail).toMatch(/SQLCH220.*clickhouse\.com\/docs.*#3198/);
    expect(await showCreate("shop.events")).toBe(before);
  }, 120_000);

  test("the same build applied a second time changes nothing", async () => {
    const r = await apply([DB, eventsV2, OLD, BY_KIND]);
    expect(Object.values(actions(r))).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
  }, 120_000);

  test("a prune drops the owned table the build no longer declares and spares the one made by hand", async () => {
    const r = await apply([DB, eventsV2, BY_KIND], true);
    expect(r.pruned.map((p) => p.name)).toEqual(["shop.old_events"]);
    const names = (await q<{ name: string }>("SELECT name FROM system.tables WHERE database = 'shop' ORDER BY name")).map((t) => t.name);
    expect(names).toEqual(["by_kind", "events", "handmade"]);
  }, 120_000);
});
