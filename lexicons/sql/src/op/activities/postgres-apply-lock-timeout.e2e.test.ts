/**
 * The applier's catalog read under `lock_timeout` (#3726). One session holds
 * ACCESS EXCLUSIVE on a table behind a view; `postgresApply` of a build that
 * declares the view reads its definition first, so it stops after the
 * profile's `lockTimeoutMs` instead of waiting for the lock, names the table
 * and the pid holding it, and writes nothing.
 *
 * `CHANT_SQL_E2E_POSTGRES_URL` (with `CHANT_SQL_E2E_POSTGRES_PASSWORD`) names
 * a running server, else a throwaway one, skipped when Docker is not
 * available. The test makes only the schema `chant_e2e_3726`, dropped
 * afterwards.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../../postgres/testing/server";
import { connectPostgres, type PostgresClient, type PostgresEndpoint } from "../../postgres/live/client";
import { postgresApply } from "./postgres-apply";

const SCHEMA = "chant_e2e_3726";
const given = process.env.CHANT_SQL_E2E_POSTGRES_URL;
const enabled = given ? true : await dockerAvailable();
const dir = mkdtempSync(join(tmpdir(), "chant-pg-apply-3726-"));
let server: TestPostgres | undefined;
let endpoint: PostgresEndpoint;
let admin: PostgresClient;
let holder: PostgresClient;

describe.skipIf(!enabled)("an apply whose catalog read is blocked behind ACCESS EXCLUSIVE", () => {
  beforeAll(async () => {
    if (given) endpoint = { url: given, password: process.env.CHANT_SQL_E2E_POSTGRES_PASSWORD ?? "" };
    else {
      server = await startTestPostgres();
      endpoint = server.endpoint();
    }
    admin = await connectPostgres(endpoint);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.query(`CREATE TABLE ${SCHEMA}.orders (id bigint PRIMARY KEY)`);
    await admin.query(`CREATE VIEW ${SCHEMA}.recent AS SELECT id FROM ${SCHEMA}.orders`);
    holder = await connectPostgres(endpoint, { applicationName: "chant-e2e-3726-holder" });
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ${SCHEMA}.orders IN ACCESS EXCLUSIVE MODE`);
  }, 600_000);

  afterAll(async () => {
    await holder?.query("ROLLBACK").catch(() => undefined);
    await holder?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await admin?.end();
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("stops after lockTimeoutMs, naming the table and the pid, with nothing written", async () => {
    const [{ pid }] = await holder.query<{ pid: number }>("SELECT pg_catalog.pg_backend_pid() AS pid");
    const buildPath = join(dir, "schema.json");
    writeFileSync(
      buildPath,
      JSON.stringify({
        dialect: "postgres",
        applyOrder: ["app", "orders", "recent", "audit"],
        objects: [
          { export: "app", type: "Postgres::Schema", dependsOn: [], ddl: `CREATE SCHEMA ${SCHEMA}` },
          { export: "orders", type: "Postgres::Table", dependsOn: ["app"], ddl: `CREATE TABLE ${SCHEMA}.orders (\n  id bigint PRIMARY KEY\n)` },
          { export: "recent", type: "Postgres::View", dependsOn: ["orders"], ddl: `CREATE VIEW ${SCHEMA}.recent AS SELECT id FROM ${SCHEMA}.orders` },
          { export: "audit", type: "Postgres::Table", dependsOn: ["app"], ddl: `CREATE TABLE ${SCHEMA}.audit (\n  id bigint\n)` },
        ],
      }),
    );
    const started = Date.now();
    const err = (await postgresApply({ buildPath, environment: "e2e" }, undefined, {
      config: { ownership: { stack: "e2e3726", env: "e2e" }, sql: { profiles: { e2e: { url: endpoint.url, password: { env: "PG_E2E_3726_PASSWORD" }, schemas: [SCHEMA], lockTimeoutMs: 300 } } } },
      env: { PG_E2E_3726_PASSWORD: endpoint.password ?? "" },
      log: () => undefined,
    }).catch((e: unknown) => e)) as Error;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("lock timeout: the catalog read waited 300ms for a lock");
    expect(err.message).toContain(`${SCHEMA}.orders is held in ACCESS EXCLUSIVE by pid ${pid}`);
    expect(err.message).toContain("chant-e2e-3726-holder");
    const [audit] = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename = 'audit'`, [SCHEMA]);
    expect(audit?.n).toBe(0);
  }, 60_000);
});
