/**
 * Catalog reads under `lock_timeout` (#3678). One session holds ACCESS
 * EXCLUSIVE on a table behind a view; the observation of the view, which
 * reads its definition with `pg_get_viewdef()`, fails after the profile's
 * `lockTimeoutMs` instead of waiting for the lock, and names the table and the
 * pid holding it.
 *
 * `CHANT_SQL_E2E_POSTGRES_URL` (with `CHANT_SQL_E2E_POSTGRES_PASSWORD`) names
 * a running server, else a throwaway one, skipped when Docker is not
 * available. The test makes only the schema `chant_e2e_3678`, dropped
 * afterwards.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { normalizeObservation } from "@intentius/chant/observation";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../testing/server";
import { connectPostgres, type PostgresClient, type PostgresEndpoint } from "./client";
import { describeResources } from "./describe-resources";

const SCHEMA = "chant_e2e_3678";
const given = process.env.CHANT_SQL_E2E_POSTGRES_URL;
const enabled = given ? true : await dockerAvailable();
let server: TestPostgres | undefined;
let endpoint: PostgresEndpoint;
let admin: PostgresClient;
let holder: PostgresClient;

describe.skipIf(!enabled)("a catalog read blocked behind ACCESS EXCLUSIVE", () => {
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
    holder = await connectPostgres(endpoint, { applicationName: "chant-e2e-3678-holder" });
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ${SCHEMA}.orders IN ACCESS EXCLUSIVE MODE`);
  }, 600_000);

  afterAll(async () => {
    await holder?.query("ROLLBACK").catch(() => undefined);
    await holder?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await admin?.end();
    await server?.stop();
  });

  test("fails after lockTimeoutMs, naming the relation and the pid", async () => {
    const [{ pid }] = await holder.query<{ pid: number }>("SELECT pg_catalog.pg_backend_pid() AS pid");
    const started = Date.now();
    const r = normalizeObservation(await describeResources({
      environment: "e2e",
      config: { sql: { profiles: { e2e: { url: endpoint.url, password: { env: "PG_E2E_3678_PASSWORD" }, schemas: [SCHEMA], lockTimeoutMs: 300 } } } },
      env: { PG_E2E_3678_PASSWORD: endpoint.password ?? "" },
      entityNames: ["recent"],
      entities: new Map([["recent", { entityType: "Postgres::View", props: { schema: SCHEMA, name: "recent" } }]]),
    }));
    expect(Date.now() - started).toBeLessThan(10_000);
    const recent = r.unobserved.recent;
    expect(recent?.reason).toBe("read-failed");
    expect(recent?.detail).toContain("lock timeout");
    expect(recent?.detail).toContain(`${SCHEMA}.orders is held in ACCESS EXCLUSIVE by pid ${pid}`);
    expect(recent?.detail).toContain("chant-e2e-3678-holder");
  }, 60_000);
});
