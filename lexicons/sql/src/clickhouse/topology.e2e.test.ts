/**
 * The single-node rendering against a server (#3645): one migration source
 * written for a cluster (`ON CLUSTER`, `Replicated*MergeTree` with Keeper
 * paths, a `Replicated` database) is refused by a single node as written
 * and applies once rendered for it, with the plain MergeTree family.
 *
 * Runs against `CLICKHOUSE_URL` when it is set (the emulator, `chant
 * emulator up --lexicon sql`), else a scratch server of the pinned image.
 * Everything it writes is in the database `yodel_3645`. Needs one or the
 * other; skips cleanly without Docker.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
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

afterAll(async () => {
  if (enabled) await q(`DROP DATABASE IF EXISTS ${DB} SYNC`).catch(() => undefined);
  await server?.stop();
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
