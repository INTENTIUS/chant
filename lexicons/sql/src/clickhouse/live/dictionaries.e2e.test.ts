/**
 * A dictionary in a declared database (#3653): chant does not read
 * dictionaries yet, so `chant sql plan` names it and fails (exit 2) rather
 * than leave it out, and the deep read behind `chant lifecycle diff --live`
 * reports it as unobserved. A table with the `Dictionary` engine is a table,
 * and is read as one.
 *
 * The server: `CLICKHOUSE_URL` (with `CLICKHOUSE_USER` and
 * `CLICKHOUSE_PASSWORD`) names a running one, such as the one
 * `chant emulator up --lexicon sql` starts. Without it, a throwaway server at
 * the pin, skipped cleanly when Docker is not available. The test writes only
 * to the database `chant_e2e_3682`, dropped afterwards.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startScratchServer, type ScratchServer } from "../container";
import { clickhouseQuery, type ClickHouseEndpoint } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { database, table } from "../entities";
import { planAgainstServer } from "../plan/commands";
import { renderDiff } from "../plan/report";
import { observeResourcesDeep } from "../plan/deep";

const DB = "chant_e2e_3682";
const fromEnv = process.env.CLICKHOUSE_URL;
const enabled = fromEnv !== undefined || (await dockerAvailable());
let server: ScratchServer | undefined;
let endpoint: ClickHouseEndpoint;
const dir = mkdtempSync(join(tmpdir(), "chant-sql-dictionaries-"));
const q = (sql: string) => clickhouseQuery(endpoint, sql);

beforeAll(async () => {
  if (!enabled) return;
  if (fromEnv !== undefined) {
    endpoint = {
      url: fromEnv,
      ...(process.env.CLICKHOUSE_USER ? { user: process.env.CLICKHOUSE_USER } : {}),
      ...(process.env.CLICKHOUSE_PASSWORD ? { password: process.env.CLICKHOUSE_PASSWORD } : {}),
    };
  } else {
    server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-dictionaries" });
    endpoint = server.endpoint;
  }
  await q(`DROP DATABASE IF EXISTS ${DB} SYNC`);
}, 600_000);

afterAll(async () => {
  if (enabled) await q(`DROP DATABASE IF EXISTS ${DB} SYNC`).catch(() => undefined);
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const env = () => ({
  config: {},
  env: {
    CLICKHOUSE_URL: endpoint.url,
    ...(endpoint.user ? { CLICKHOUSE_USER: endpoint.user } : {}),
    ...(endpoint.password ? { CLICKHOUSE_PASSWORD: endpoint.password } : {}),
  },
});

describe.skipIf(!enabled)("a dictionary in a declared database (#3653)", () => {
  const shop = database`CREATE DATABASE chant_e2e_3682`;
  const rates = table`CREATE TABLE chant_e2e_3682.rates (code String, rate Float64) ENGINE = MergeTree ORDER BY code`;
  const declared = { shop, rates };

  test("the plan names it and fails; the deep read reports it unobserved; a Dictionary-engine table is read as a table", async () => {
    for (const e of Object.values(declared)) await q(e.props.ddl);
    await q(`CREATE DICTIONARY ${DB}.rates_dict (code String, rate Float64 DEFAULT 1) PRIMARY KEY code SOURCE(CLICKHOUSE(TABLE 'rates' DB '${DB}')) LAYOUT(COMPLEX_KEY_HASHED()) LIFETIME(MIN 0 MAX 300)`);
    await q(`CREATE TABLE ${DB}.rates_view (code String, rate Float64) ENGINE = Dictionary(${DB}.rates_dict)`);
    const buildFile = join(dir, "schema.json");
    writeFileSync(buildFile, JSON.stringify({ dialect: "clickhouse", objects: Object.entries(declared).map(([k, e]) => ({ export: k, ddl: e.props.ddl })) }));

    const diff = await planAgainstServer("e2e", buildFile, env());
    expect(diff.unreadable).toEqual([{ object: `${DB}.rates_dict`, type: "ClickHouse::Dictionary", reason: "a dictionary, which chant does not read or declare yet" }]);
    // The Dictionary-engine table is read: undeclared, it is a drop like any other.
    expect(diff.changes.map((c) => [c.object, c.rule])).toEqual([[`${DB}.rates_view`, "SQLCH250"]]);
    expect(renderDiff(diff)).toContain(`Refused: 1 object(s) in the declared databases could not be read`);
    expect(renderDiff(diff)).toContain(`${DB}.rates_dict (ClickHouse::Dictionary)`);

    const entities = new Map(Object.entries(declared).map(([k, e]) => [k, { entityType: e.entityType, props: e.props as unknown as Record<string, unknown> }]));
    const deep = await observeResourcesDeep({ environment: "e2e", entityNames: [...entities.keys()], entities, ...env() });
    expect(Object.keys(deep.resources).sort()).toEqual(["rates", "shop"]);
    expect(deep.unobserved).toEqual({
      [`${DB}.rates_dict`]: { type: "ClickHouse::Dictionary", reason: "unsupported-kind", detail: expect.stringContaining("its drift is not reported") },
    });
  }, 300_000);
});
