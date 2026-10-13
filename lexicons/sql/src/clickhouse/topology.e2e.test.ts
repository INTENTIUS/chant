/**
 * The single-node rendering against a server (#3645): one migration source
 * written for a cluster (`ON CLUSTER`, `Replicated*MergeTree` with Keeper
 * paths, a `Replicated` database) is refused by a single node as written
 * and applies once rendered for it, with the plain MergeTree family: as
 * statements, and through the applier with `CLICKHOUSE_TOPOLOGY=single`,
 * which then finds nothing left to change.
 *
 * Runs against `CLICKHOUSE_URL` when it is set (the emulator, `chant
 * emulator up --lexicon sql`), else a scratch server of the pinned image.
 * Everything it writes is in the database `yodel_3645`. Needs one or the
 * other; skips cleanly without Docker.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { clickhouseApply } from "../op/activities/clickhouse-apply";
import { dockerAvailable, startScratchServer, type ScratchServer } from "./container";
import { clickhouseQuery, type ClickHouseEndpoint } from "./http";
import { clickhouseImage } from "../spec/pin";
import { renderStatement, type Topology } from "./topology";

const DB = "yodel_3645";
const fromEnv = process.env.CLICKHOUSE_URL;
const enabled = fromEnv !== undefined || (await dockerAvailable());
let server: ScratchServer | undefined;
let endpoint: ClickHouseEndpoint;

const q = <T = Record<string, unknown>>(sql: string) => clickhouseQuery<T>(endpoint, sql);

beforeAll(async () => {
  if (!enabled) return;
  if (fromEnv !== undefined) {
    endpoint = {
      url: fromEnv,
      ...(process.env.CLICKHOUSE_USER ? { user: process.env.CLICKHOUSE_USER } : {}),
      ...(process.env.CLICKHOUSE_PASSWORD ? { password: process.env.CLICKHOUSE_PASSWORD } : {}),
    };
  } else {
    server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-topology" });
    endpoint = server.endpoint;
  }
  await q(`DROP DATABASE IF EXISTS ${DB} SYNC`);
}, 600_000);

const dir = mkdtempSync(join(tmpdir(), "chant-sql-topology-"));

afterAll(async () => {
  if (enabled) await q(`DROP DATABASE IF EXISTS ${DB} SYNC`).catch(() => undefined);
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const SINGLE: Topology = { kind: "single" };

/** One migration, written for a cluster named `main`. */
const SOURCE = [
  `CREATE DATABASE ${DB} ON CLUSTER main ENGINE = Replicated('/clickhouse/databases/${DB}', '{shard}', '{replica}') COMMENT 'topology e2e'`,
  `CREATE TABLE ${DB}.events ON CLUSTER main (
    id UInt64,
    ts DateTime,
    kind LowCardinality(String)
  ) ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DB}/events', '{replica}', ts)
  ORDER BY id`,
  `CREATE MATERIALIZED VIEW ${DB}.by_kind ON CLUSTER main
  ENGINE = ReplicatedSummingMergeTree('/clickhouse/tables/{shard}/${DB}/by_kind', '{replica}')
  ORDER BY kind
  AS SELECT kind, count() AS n FROM ${DB}.events GROUP BY kind`,
  `CREATE TABLE ${DB}.staging ON CLUSTER main (id UInt64, ts DateTime, kind LowCardinality(String)) ENGINE = ReplicatedReplacingMergeTree(ts) ORDER BY id`,
  `ALTER TABLE ${DB}.events ON CLUSTER main ADD COLUMN source String DEFAULT 'web' AFTER kind`,
  `ALTER TABLE ${DB}.staging ON CLUSTER main ADD COLUMN source String DEFAULT 'web' AFTER kind`,
  `ALTER TABLE ${DB}.events ON CLUSTER main MODIFY COMMENT 'events'`,
  `EXCHANGE TABLES ${DB}.events AND ${DB}.staging ON CLUSTER main`,
  `RENAME TABLE ${DB}.staging TO ${DB}.events_old ON CLUSTER main`,
  `DROP TABLE ${DB}.events_old ON CLUSTER main SYNC`,
];

describe.skipIf(!enabled)("the single-node rendering against a server (#3645)", () => {
  test("the source as written for a cluster is refused by a single node", async () => {
    await expect(q(SOURCE[0]!)).rejects.toThrow();
    await expect(q(renderStatement(SOURCE[0]!, SINGLE))).resolves.toEqual([]);
    // The database is there now; the table as written still fails, on its ON CLUSTER or its Keeper path.
    await expect(q(SOURCE[1]!)).rejects.toThrow();
    await q(`DROP DATABASE ${DB} SYNC`);
  });

  test("every statement rendered for a single node applies, with the plain MergeTree family", async () => {
    for (const sql of SOURCE) {
      const rendered = renderStatement(sql, SINGLE);
      expect(rendered).not.toMatch(/ON CLUSTER|Replicated/);
      await q(rendered);
    }
    const db = await q<{ engine: string }>(`SELECT engine FROM system.databases WHERE name = '${DB}'`);
    expect(db).toEqual([{ engine: "Atomic" }]);
    const tables = await q<{ name: string; engine: string }>(
      `SELECT name, engine FROM system.tables WHERE database = '${DB}' AND NOT startsWith(name, '.inner') ORDER BY name`,
    );
    expect(tables).toEqual([
      { name: "by_kind", engine: "MaterializedView" },
      { name: "events", engine: "ReplacingMergeTree" },
    ]);
    const inner = await q<{ engine: string }>(`SELECT engine FROM system.tables WHERE database = '${DB}' AND startsWith(name, '.inner')`);
    expect(inner).toEqual([{ engine: "SummingMergeTree" }]);
    const cols = await q<{ name: string }>(`SELECT name FROM system.columns WHERE database = '${DB}' AND table = 'events' ORDER BY position`);
    expect(cols.map((c) => c.name)).toEqual(["id", "ts", "kind", "source"]);
  });
});

describe.skipIf(!enabled)("the applier with a single-node topology (#3645)", () => {
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
    { export: "db", type: "ClickHouse::Database", ddl: `CREATE DATABASE ${DB} ON CLUSTER main ENGINE = Replicated('/clickhouse/databases/${DB}', '{shard}', '{replica}')` },
    {
      export: "events",
      type: "ClickHouse::Table",
      dependsOn: ["db"],
      ddl: `CREATE TABLE ${DB}.events ON CLUSTER main (id UInt64, ts DateTime, kind String${extraColumn}) ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DB}/events', '{replica}', ts) ORDER BY id`,
    },
    {
      export: "byKind",
      type: "ClickHouse::MaterializedView",
      dependsOn: ["events"],
      ddl: `CREATE MATERIALIZED VIEW ${DB}.by_kind ON CLUSTER main ENGINE = ReplicatedSummingMergeTree ORDER BY kind AS SELECT kind, count() AS n FROM ${DB}.events GROUP BY kind`,
    },
  ];
  const apply = async (buildPath: string, topology?: string) => {
    const sent: string[] = [];
    const env: Record<string, string> = { CLICKHOUSE_URL: endpoint.url, ...(topology ? { CLICKHOUSE_TOPOLOGY: topology } : {}) };
    if (endpoint.user) env.CLICKHOUSE_USER = endpoint.user;
    if (endpoint.password) env.CLICKHOUSE_PASSWORD = endpoint.password;
    const outcome = await clickhouseApply({ buildPath, environment: "test" }, undefined, {
      config: { ownership: { stack: "yodel", env: "e2e" } },
      env,
      // The statements it sent; the log's other lines report each object.
      log: (l) => void (/^[A-Z]+ /.test(l) && sent.push(l)),
    }).catch((err: unknown) => ({ error: err as Error }));
    return { outcome, sent };
  };

  test("as declared, the cluster's source fails on a single node; rendered for it, it applies and converges", async () => {
    await q(`DROP DATABASE IF EXISTS ${DB} SYNC`);
    const v1 = writeBuild("v1.json", objects());

    const asDeclared = await apply(v1);
    expect("error" in asDeclared.outcome || asDeclared.outcome.failed.length > 0).toBe(true);
    await q(`DROP DATABASE IF EXISTS ${DB} SYNC`);

    const first = await apply(v1, "single");
    expect("error" in first.outcome).toBe(false);
    expect(first.sent.join("\n")).not.toMatch(/ON CLUSTER|Replicated/);
    expect(first.sent).toHaveLength(3);
    const tables = await q<{ name: string; engine: string }>(`SELECT name, engine FROM system.tables WHERE database = '${DB}' ORDER BY name`);
    expect(tables.map((t) => [t.name.startsWith(".inner") ? ".inner" : t.name, t.engine])).toEqual([
      [".inner", "SummingMergeTree"],
      ["by_kind", "MaterializedView"],
      ["events", "ReplacingMergeTree"],
    ]);

    // Again: the server's plain engines are what the source renders to on a single node, so nothing is sent.
    const again = await apply(v1, "single");
    expect(again.sent).toEqual([]);
    expect("error" in again.outcome ? again.outcome.error : again.outcome.notAttempted).toEqual([]);

    // A change to the cluster's source applies as a single node's ALTER.
    const v2 = writeBuild("v2.json", objects(", source String DEFAULT 'web'"));
    const change = await apply(v2, "single");
    expect(change.sent).toEqual([`ALTER TABLE \`${DB}\`.\`events\` ADD COLUMN source String DEFAULT 'web' AFTER \`kind\``]);
    const cols = await q<{ name: string }>(`SELECT name FROM system.columns WHERE database = '${DB}' AND table = 'events' ORDER BY position`);
    expect(cols.map((c) => c.name)).toEqual(["id", "ts", "kind", "source"]);
  });
});
