/**
 * Named collections against the pinned server (#4395): a plan fails naming a
 * collection the build references and the server lacks, and passes once it
 * exists, without reading its values; import from a server that holds one
 * succeeds and lists it as a prerequisite.
 *
 * Needs Docker; skips cleanly without it. One throwaway
 * `clickhouse/clickhouse-server` container at the pin, removed afterwards
 * even on failure.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SerializerResult } from "@intentius/chant/serializer";
import { dockerAvailable, startScratchServer, type ScratchServer } from "../container";
import { clickhouseQuery } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { database, table } from "../entities";
import { sqlSerializer } from "../../serializer";
import { planAgainstServer } from "../plan/commands";
import { renderDiff } from "../plan/report";
import { exportResources } from "../import/live-export";

const enabled = await dockerAvailable();
let server: ScratchServer | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-sql-named-collections-"));
const buildFile = join(dir, "lake.json");
const q = (sql: string) => clickhouseQuery(server!.endpoint, sql);

const DB = "lakehouse";
const db = database`CREATE DATABASE lakehouse`;
const lake = table`CREATE TABLE ${db}.lake (a Int32) ENGINE = S3(lake_creds, url = 'http://minio:9000/bucket/x.parquet', format = 'Parquet')`;

beforeAll(async () => {
  if (!enabled) return;
  server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-named-collections" });
  const out = sqlSerializer.serialize(new Map<string, unknown>([["db", db], ["lake", lake]]) as never) as SerializerResult;
  writeFileSync(buildFile, out.primary);
}, 600_000);

afterAll(async () => {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const env = (user?: string) => ({ config: {}, env: { CLICKHOUSE_URL: server!.endpoint.url, ...(user ? { CLICKHOUSE_USER: user } : {}) } });

describe.skipIf(!enabled)("named collections on the pinned server", () => {
  test("a plan against a server without lake_creds fails, naming it", async () => {
    const diff = await planAgainstServer("e2e", buildFile, env());
    expect(diff.namedCollections).toEqual({ referenced: ["lake_creds"], missing: ["lake_creds"] });
    expect(renderDiff(diff)).toMatch(/Refused: the build references a named collection the server does not have: lake_creds\./);
  }, 120_000);

  test("with it, the plan passes, and no query reads its values", async () => {
    await q("CREATE NAMED COLLECTION lake_creds AS access_key_id = 'AKIAEXAMPLE', secret_access_key = 'not-a-real-secret', url = 'http://minio:9000/bucket/'");
    const diff = await planAgainstServer("e2e", buildFile, env());
    expect(diff.namedCollections).toEqual({ referenced: ["lake_creds"], missing: [] });
    await q("SYSTEM FLUSH LOGS");
    const reads = await clickhouseQuery<{ query: string }>(
      server!.endpoint,
      "SELECT query FROM system.query_log WHERE type = 'QueryFinish' AND query LIKE '%chant%' AND query LIKE '%named_collections%' AND query NOT LIKE '%query_log%'",
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.query).not.toMatch(/\bcollection\b(?! \*\/)|create_query/);
  }, 120_000);

  test("a user without SHOW NAMED COLLECTIONS sees none, and the plan says so", async () => {
    await q("CREATE USER IF NOT EXISTS planner IDENTIFIED WITH no_password");
    await q("GRANT SELECT, SHOW ON *.* TO planner");
    const diff = await planAgainstServer("e2e", buildFile, env("planner"));
    expect(diff.namedCollections?.missing).toEqual(["lake_creds"]);
    expect(renderDiff(diff)).toMatch(/grant the plan's user SHOW NAMED COLLECTIONS/);
  }, 120_000);

  test("import from a server with a SQL-defined named collection succeeds and lists it as a prerequisite", async () => {
    await q(`CREATE DATABASE IF NOT EXISTS ${DB}`);
    await q(`CREATE TABLE IF NOT EXISTS ${DB}.lake (a Int32) ENGINE = S3(lake_creds, url = 'http://minio:9000/bucket/x.parquet', format = 'Parquet')`);
    const ir = await exportResources({ environment: "e2e", ...env() });
    expect(ir.resources.map((r) => r.properties.name)).toEqual([DB, "lake"]);
    expect(ir.metadata?.prerequisites).toEqual([{ kind: "named collection", name: "lake_creds", referencedBy: [`${DB}.lake`] }]);
    expect(ir.warnings).toContainEqual(expect.stringMatching(/^named collection lake_creds is a prerequisite of e2e, named by lakehouse\.lake: the server holds it/));
    // The import carries the name, never a value.
    expect(JSON.stringify(ir)).not.toMatch(/AKIAEXAMPLE|not-a-real-secret/);
  }, 120_000);
});
