/**
 * Import adopts a SQL function a view or a column default uses (#3745),
 * although ClickHouse stores the function's body there in place of the call.
 *
 * `CLICKHOUSE_URL` (with `CLICKHOUSE_USER` and `CLICKHOUSE_PASSWORD`) names a
 * running server, such as the one `chant emulator up --lexicon sql` starts.
 * Without it, a throwaway server at the pin, skipped cleanly when Docker is
 * not available. Functions are global to the server, so everything here is
 * named `chant_e2e_3745*` and dropped afterwards.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startScratchServer, type ScratchServer } from "../container";
import { clickhouseQuery, type ClickHouseEndpoint } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { exportResources } from "./live-export";

const PREFIX = "chant_e2e_3745";
const DB = `${PREFIX}_shop`;
const TAX = `${PREFIX}_tax`;
const NET = `${PREFIX}_net`;
const LABEL = `${PREFIX}_label`;
const UNUSED = `${PREFIX}_unused`;
const fromEnv = process.env.CLICKHOUSE_URL;
const docker = await dockerAvailable();
const enabled = fromEnv !== undefined || docker;
let server: ScratchServer | undefined;
let endpoint: ClickHouseEndpoint;
const q = (sql: string) => clickhouseQuery(endpoint, sql);

const cleanup = async () => {
  await q(`DROP DATABASE IF EXISTS ${DB} SYNC`).catch(() => undefined);
  // NET calls TAX, so it goes first.
  for (const f of [NET, TAX, LABEL, UNUSED]) await q(`DROP FUNCTION IF EXISTS ${f}`).catch(() => undefined);
};

beforeAll(async () => {
  if (!enabled) return;
  if (fromEnv !== undefined) {
    endpoint = {
      url: fromEnv,
      ...(process.env.CLICKHOUSE_USER ? { user: process.env.CLICKHOUSE_USER } : {}),
      ...(process.env.CLICKHOUSE_PASSWORD ? { password: process.env.CLICKHOUSE_PASSWORD } : {}),
    };
  } else {
    server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-inlined" });
    endpoint = server.endpoint;
  }
  await cleanup();
  await q(`CREATE FUNCTION ${TAX} AS (x) -> x * 0.2`);
  await q(`CREATE FUNCTION ${NET} AS (x, y) -> ${TAX}(x) + if(y > 1, y, 0)`);
  await q(`CREATE FUNCTION ${LABEL} AS (s) -> concat('[', lower(s), ']')`);
  await q(`CREATE FUNCTION ${UNUSED} AS (x) -> x - 42`);
  await q(`CREATE DATABASE ${DB}`);
  await q(`CREATE TABLE ${DB}.orders (id UInt64, kind String, amt Float64 DEFAULT ${TAX}(id)) ENGINE = MergeTree ORDER BY id`);
  await q(`CREATE VIEW ${DB}.net AS SELECT id, ${NET}(amt, id) AS n FROM ${DB}.orders`);
  await q(`CREATE MATERIALIZED VIEW ${DB}.labels ENGINE = MergeTree ORDER BY id AS SELECT id, ${LABEL}(kind) AS l FROM ${DB}.orders`);
}, 600_000);

afterAll(async () => {
  if (enabled) await cleanup();
  await server?.stop();
});

describe.skipIf(!enabled)("import finds a function by its body (#3745)", () => {
  test("a view, a materialized view and a column default using functions adopt them; an unused one is named with the importFunctions hint", async () => {
    // The premise: the server keeps no call to the function.
    const [view] = await q(`SELECT create_table_query AS ddl FROM system.tables WHERE database = '${DB}' AND name = 'net'`);
    expect(String(view!.ddl)).not.toContain(NET);

    const profile = {
      url: endpoint.url,
      databases: [DB],
      ...(endpoint.user !== undefined ? { user: { env: "CH_USER" } } : {}),
      ...(endpoint.password !== undefined ? { password: { env: "CH_PASSWORD" } } : {}),
    };
    const ir = await exportResources({
      environment: "e2e",
      config: { sql: { profiles: { e2e: profile } } } as never,
      env: { CH_USER: endpoint.user, CH_PASSWORD: endpoint.password },
    });
    const names = ir.resources.map((r) => String(r.properties.name));
    expect(names).toEqual(expect.arrayContaining(["orders", "net", "labels", TAX, NET, LABEL]));
    expect(names).not.toContain(UNUSED);
    expect(ir.warnings).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`not imported, since no imported object uses (it|them): .*${UNUSED}.*importFunctions`))]));
  });
});
