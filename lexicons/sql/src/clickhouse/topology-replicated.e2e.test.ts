/**
 * The replicated topology against a Replicated database (#3645): two
 * replicas of the pinned server, Keeper embedded in the first (the scratch
 * cluster the Replicated rebuild runs on).
 *
 * The source is written for a single node: a plain database, MergeTree
 * tables. Applied with `CLICKHOUSE_TOPOLOGY=replicated`, the database is a
 * `Replicated` one and its tables `Replicated*MergeTree` with no path, so
 * the second replica gets them from the database's log and rows written on
 * one reach the other. Applied again on the other replica, the server's
 * printed engines (with the default Keeper path filled in) compare equal to
 * the declarations, and nothing is sent; a change applies there and reaches
 * the first.
 *
 * The scratch cluster names no cluster in `remote_servers`, so the second
 * replica joins the database with the `CREATE DATABASE` the applier sent to
 * the first, as an operator would (`replicated:<cluster>` sends it `ON
 * CLUSTER` instead). Needs Docker; skips cleanly without it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startScratchCluster, type ScratchCluster } from "./container";
import { clickhouseQuery, type ClickHouseEndpoint } from "./http";
import { clickhouseImage } from "../spec/pin";
import { clickhouseApply } from "../op/activities/clickhouse-apply";
import { renderStatement } from "./topology";

const DB = "yodel_3645";
const enabled = await dockerAvailable();
let cluster: ScratchCluster | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-sql-topology-repl-"));

beforeAll(async () => {
  if (!enabled) return;
  cluster = await startScratchCluster(clickhouseImage(), { replicas: 2, namePrefix: "chant-sql-topology-repl" });
}, 600_000);

afterAll(async () => {
  await cluster?.stop();
  rmSync(dir, { recursive: true, force: true });
});

interface Obj {
  export: string;
  type: string;
  ddl: string;
  dependsOn?: string[];
}

const writeBuild = (file: string, objects: Obj[]): string => {
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify({ dialect: "clickhouse", applyOrder: objects.map((o) => o.export), objects: objects.map((o) => ({ dependsOn: [], ...o })) }));
  return path;
};

const objects = (extraColumn = ""): Obj[] => [
  { export: "db", type: "ClickHouse::Database", ddl: `CREATE DATABASE ${DB}` },
  {
    export: "events",
    type: "ClickHouse::Table",
    dependsOn: ["db"],
    ddl: `CREATE TABLE ${DB}.events (id UInt64, ts DateTime, kind String${extraColumn}) ENGINE = ReplacingMergeTree(ts) ORDER BY id`,
  },
  {
    export: "byKind",
    type: "ClickHouse::MaterializedView",
    dependsOn: ["events"],
    ddl: `CREATE MATERIALIZED VIEW ${DB}.by_kind ENGINE = SummingMergeTree ORDER BY kind AS SELECT kind, count() AS n FROM ${DB}.events GROUP BY kind`,
  },
];

const q = <T = Record<string, unknown>>(at: ClickHouseEndpoint, sql: string) => clickhouseQuery<T>(at, sql);

async function apply(at: ClickHouseEndpoint, buildPath: string) {
  const sent: string[] = [];
  const outcome = await clickhouseApply({ buildPath, environment: "test" }, undefined, {
    config: { ownership: { stack: "yodel", env: "e2e" } },
    env: { CLICKHOUSE_URL: at.url, CLICKHOUSE_TOPOLOGY: "replicated" },
    log: (l) => void (/^[A-Z]+ /.test(l) && sent.push(l)),
  });
  return { outcome, sent };
}

describe.skipIf(!enabled)("the replicated topology on a Replicated database (#3645)", () => {
  test("a single node's source becomes a Replicated database that both replicas hold, and converges on either", async () => {
    const [r1, r2] = cluster!.replicas as [ClickHouseEndpoint, ClickHouseEndpoint];
    expect(renderStatement(`CREATE DATABASE ${DB}`, { kind: "replicated" })).toBe(`CREATE DATABASE ${DB} ENGINE = Replicated('/clickhouse/databases/${DB}', '{shard}', '{replica}')`);

    const v1 = writeBuild("v1.json", objects());
    const first = await apply(r1, v1);
    expect(first.outcome.failed).toEqual([]);
    // The second replica joins the database with the statement the applier sent to the first, and replays its tables from the log.
    expect(first.sent[0]).toMatch(new RegExp(`^CREATE DATABASE ${DB} ENGINE = Replicated\\('/clickhouse/databases/${DB}', '\\{shard\\}', '\\{replica\\}'\\) COMMENT `));
    await q(r2, first.sent[0]!);
    await q(r2, `SYSTEM SYNC DATABASE REPLICA ${DB}`);
    expect(first.sent.join("\n")).not.toMatch(/ON CLUSTER/);
    expect(first.sent[1]).toMatch(/ENGINE = ReplicatedReplacingMergeTree\(ts\) ORDER BY id/);

    await q(r1, `INSERT INTO ${DB}.events (id, ts, kind) VALUES (1, now(), 'click'), (2, now(), 'view')`);
    await q(r2, `SYSTEM SYNC REPLICA ${DB}.events`);
    expect(Number((await q<{ n: string | number }>(r2, `SELECT count() AS n FROM ${DB}.events`))[0]!.n)).toBe(2);
    const engines = await q<{ name: string; engine: string }>(r2, `SELECT name, engine FROM system.tables WHERE database = '${DB}' ORDER BY name`);
    expect(engines.map((t) => [t.name.startsWith(".inner") ? ".inner" : t.name, t.engine])).toEqual([
      [".inner", "ReplicatedSummingMergeTree"],
      ["by_kind", "MaterializedView"],
      ["events", "ReplicatedReplacingMergeTree"],
    ]);
    expect((await q<{ engine: string }>(r2, `SELECT engine FROM system.databases WHERE name = '${DB}'`))[0]!.engine).toBe("Replicated");

    // On the other replica: the printed engines (default Keeper path filled in) are the declarations; nothing to send.
    const again = await apply(r2, v1);
    expect(again.sent).toEqual([]);
    expect(again.outcome.notAttempted).toEqual([]);

    // A change there reaches the first replica through the database's log.
    const change = await apply(r2, writeBuild("v2.json", objects(", source String DEFAULT 'web'")));
    expect(change.sent).toEqual([`ALTER TABLE \`${DB}\`.\`events\` ADD COLUMN source String DEFAULT 'web' AFTER \`kind\``]);
    await q(r1, `SYSTEM SYNC DATABASE REPLICA ${DB}`);
    const cols = await q<{ name: string }>(r1, `SELECT name FROM system.columns WHERE database = '${DB}' AND table = 'events' ORDER BY position`);
    expect(cols.map((c) => c.name)).toEqual(["id", "ts", "kind", "source"]);
  }, 300_000);
});
