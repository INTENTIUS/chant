/**
 * Token sources against a live server (#3685). A `command` source stands in
 * for the token endpoint: it prints a password from a file, and the test
 * rotates the role's password and the file together, as a cloud rotates its
 * tokens. A profile with that source connects; after the token's lifetime a
 * new one is minted and the next connection uses it; a token the server
 * refuses is forgotten, so the next attempt mints again.
 *
 * Postgres: `CHANT_SQL_E2E_POSTGRES_URL` (with
 * `CHANT_SQL_E2E_POSTGRES_PASSWORD`) names a running server, else a
 * throwaway one, skipped when Docker is not available. ClickHouse:
 * `CHANT_SQL_E2E_CLICKHOUSE_URL` (as `default`, with
 * `CHANT_SQL_E2E_CLICKHOUSE_PASSWORD`), skipped when not set. The test makes
 * only the user `chant_e2e_3685` on each, dropped afterwards.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "./postgres/testing/server";
import { connectPostgres, PostgresQueryError, type PostgresClient, type PostgresEndpoint } from "./postgres/live/client";
import { resolveBoundTarget } from "./postgres/live/bind";
import { bindClickHouse } from "./clickhouse/live/bind";
import { clickhouseQuery, ClickHouseQueryError, type ClickHouseEndpoint } from "./clickhouse/http";

const ROLE = "chant_e2e_3685";
const dir = mkdtempSync(join(tmpdir(), "chant-token-"));
const tokenFile = join(dir, "token");
const mint = (password: string) => writeFileSync(tokenFile, password);
const command = ["cat", tokenFile];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pgGiven = process.env.CHANT_SQL_E2E_POSTGRES_URL;
const pgEnabled = pgGiven ? true : await dockerAvailable();
let server: TestPostgres | undefined;
let admin: PostgresClient;
let pgUrl: string;

describe.skipIf(!pgEnabled)("a Postgres profile with a command token source", () => {
  beforeAll(async () => {
    let endpoint: PostgresEndpoint;
    if (pgGiven) endpoint = { url: pgGiven, password: process.env.CHANT_SQL_E2E_POSTGRES_PASSWORD ?? "" };
    else {
      server = await startTestPostgres();
      endpoint = server.endpoint();
    }
    admin = await connectPostgres(endpoint);
    await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
    await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD 'first-token'`);
    const url = new URL(endpoint.url);
    url.username = "";
    url.password = "";
    pgUrl = url.toString();
  }, 600_000);

  afterAll(async () => {
    await admin?.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
    await admin?.end();
    await server?.stop();
  });

  const whoami = async (endpoint: PostgresEndpoint) => {
    const client = await connectPostgres(endpoint);
    try {
      const [row] = await client.query<{ u: string }>("SELECT current_user AS u");
      return row?.u;
    } finally {
      await client.end();
    }
  };

  test("connects with the minted token, mints again after its lifetime, and forgets a refused one", async () => {
    mint("first-token");
    const config = { sql: { profiles: { e2e: { url: pgUrl, user: { env: "E2E_USER" }, password: { token: "command" as const, command, ttlSeconds: 1 } } } } };
    const target = await resolveBoundTarget({ environment: "e2e", config, env: { ...process.env, E2E_USER: ROLE } });
    expect(await whoami(target.endpoint)).toBe(ROLE);

    // Rotated: the cached token has expired by the next connect, so the new one is minted.
    await admin.query(`ALTER ROLE ${ROLE} PASSWORD 'second-token'`);
    mint("second-token");
    await sleep(1_000);
    expect(await whoami(target.endpoint)).toBe(ROLE);

    // Rotated before the cached token's lifetime is up: the server refuses it, and the retry mints.
    const long = await resolveBoundTarget({
      environment: "e2e",
      config: { sql: { profiles: { e2e: { ...config.sql.profiles.e2e, password: { token: "command" as const, command, ttlSeconds: 3600 } } } } },
      env: { ...process.env, E2E_USER: ROLE },
    });
    expect(await whoami(long.endpoint)).toBe(ROLE);
    await admin.query(`ALTER ROLE ${ROLE} PASSWORD 'third-token'`);
    mint("third-token");
    const refused = await whoami(long.endpoint).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PostgresQueryError);
    expect((refused as PostgresQueryError).code).toBe("28P01");
    expect(await whoami(long.endpoint)).toBe(ROLE);
  }, 60_000);
});

const chGiven = process.env.CHANT_SQL_E2E_CLICKHOUSE_URL;

describe.skipIf(!chGiven)("a ClickHouse profile with a command token source", () => {
  const admin: ClickHouseEndpoint = { url: chGiven ?? "", user: "default", password: process.env.CHANT_SQL_E2E_CLICKHOUSE_PASSWORD ?? "" };

  beforeAll(async () => {
    await clickhouseQuery(admin, `DROP USER IF EXISTS ${ROLE}`);
    await clickhouseQuery(admin, `CREATE USER ${ROLE} IDENTIFIED BY 'first-token'`);
  });

  afterAll(async () => {
    await clickhouseQuery(admin, `DROP USER IF EXISTS ${ROLE}`).catch(() => undefined);
  });

  test("each request carries a valid token; a refused one is minted again", async () => {
    mint("first-token");
    const config = { sql: { profiles: { e2e: { url: chGiven!, user: { env: "E2E_USER" }, password: { token: "command" as const, command, ttlSeconds: 1 } } } } };
    const target = await bindClickHouse({ environment: "e2e", config, env: { ...process.env, E2E_USER: ROLE } });
    const whoami = async () => (await clickhouseQuery<{ u: string }>(target.endpoint, "SELECT currentUser() AS u"))[0]?.u;
    expect(await whoami()).toBe(ROLE);

    await clickhouseQuery(admin, `ALTER USER ${ROLE} IDENTIFIED BY 'second-token'`);
    mint("second-token");
    await sleep(1_000);
    expect(await whoami()).toBe(ROLE);

    // Rotated before the cached token's lifetime is up: refused once, then minted again.
    const long = await bindClickHouse({
      environment: "e2e",
      config: { sql: { profiles: { e2e: { ...config.sql.profiles.e2e, password: { token: "command" as const, command, ttlSeconds: 3600 } } } } },
      env: { ...process.env, E2E_USER: ROLE },
    });
    const longWhoami = async () => (await clickhouseQuery<{ u: string }>(long.endpoint, "SELECT currentUser() AS u"))[0]?.u;
    expect(await longWhoami()).toBe(ROLE);
    await clickhouseQuery(admin, `ALTER USER ${ROLE} IDENTIFIED BY 'third-token'`);
    mint("third-token");
    await expect(longWhoami()).rejects.toBeInstanceOf(ClickHouseQueryError);
    expect(await longWhoami()).toBe(ROLE);
  }, 60_000);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
