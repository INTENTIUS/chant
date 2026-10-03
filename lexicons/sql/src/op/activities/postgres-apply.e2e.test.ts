/**
 * The Postgres applier against the pinned server (#3280): create, then a
 * column added with a default, an index built CONCURRENTLY on a table that
 * exists, a foreign key added NOT VALID and then validated; an
 * expand-and-contract change refused with the server untouched; a lock
 * timeout while another session holds a lock on the table; the same build
 * applied twice; a prune that drops an owned view and spares a table made by
 * hand.
 *
 * Needs Docker; skips cleanly without it. One throwaway `postgres` container
 * at the pin, removed afterwards even on failure.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { normalizeApply } from "@intentius/chant/apply";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../../postgres/testing/server";
import type { PostgresClient } from "../../postgres/live/client";
import { planPgAgainstServer } from "../../postgres/plan/commands";
import { PostgresApplyError } from "../../postgres/apply/apply";
import { postgresApply, type PostgresApplyArgs, type PostgresApplyDeps } from "./postgres-apply";
import { toApplyResult } from "./index";

const enabled = await dockerAvailable();
let server: TestPostgres | undefined;
let admin: PostgresClient | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-pg-apply-"));

beforeAll(async () => {
  if (!enabled) return;
  server = await startTestPostgres();
  admin = await server.connect();
}, 600_000);

afterAll(async () => {
  await admin?.end();
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
  writeFileSync(path, JSON.stringify({ dialect: "postgres", postgresMajor: 18, applyOrder: objects.map((o) => o.export), objects: objects.map((o) => ({ dependsOn: [], ...o })) }));
  return path;
}

const profile = () => ({
  config: {
    ownership: { stack: "shop", env: "e2e" },
    sql: { profiles: { e2e: { url: server!.endpoint().url, password: { env: "PG_E2E_PASSWORD" } } } },
  },
  env: { PG_E2E_PASSWORD: server!.endpoint().password },
});
const deps = (): PostgresApplyDeps => ({ ...profile(), log: () => undefined });
const apply = (objects: Obj[], args: Partial<PostgresApplyArgs> = {}) => postgresApply({ buildPath: buildFile(objects), environment: "e2e", ...args }, undefined, deps());

const APP: Obj = { export: "app", type: "Postgres::Schema", ddl: "CREATE SCHEMA app;\nCOMMENT ON SCHEMA app IS 'The shop'" };
const usersV1: Obj = {
  export: "users",
  type: "Postgres::Table",
  dependsOn: ["app"],
  ddl: "CREATE TABLE app.users (\n  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  email text NOT NULL\n);\nCOMMENT ON TABLE app.users IS 'One row per account'",
};
const ordersV1: Obj = {
  export: "orders",
  type: "Postgres::Table",
  dependsOn: ["app"],
  ddl: "CREATE TABLE app.orders (\n  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  user_id bigint NOT NULL,\n  amount numeric(12, 2) NOT NULL\n)",
};
const TOTALS: Obj = {
  export: "totals",
  type: "Postgres::View",
  dependsOn: ["orders"],
  ddl: "CREATE VIEW app.order_totals AS SELECT user_id, sum(amount) AS total FROM app.orders GROUP BY user_id",
};
const usersV2: Obj = {
  ...usersV1,
  ddl: usersV1.ddl.replace("email text NOT NULL", "email text NOT NULL,\n  status text NOT NULL DEFAULT 'active'"),
};
const ORDERS_USER_IDX: Obj = {
  export: "ordersUser",
  type: "Postgres::Index",
  dependsOn: ["orders"],
  ddl: "CREATE INDEX CONCURRENTLY orders_user_id_idx ON app.orders (user_id)",
};
const fk = (notValid: boolean): Obj => ({
  ...ordersV1,
  dependsOn: ["app", "users"],
  ddl: ordersV1.ddl.replace(
    "amount numeric(12, 2) NOT NULL\n)",
    `amount numeric(12, 2) NOT NULL,\n  CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES app.users (id)${notValid ? " NOT VALID" : ""}\n)`,
  ),
});

const one = async <T>(sql: string): Promise<T> => (await admin!.query<T>(sql))[0]!;

describe.skipIf(!enabled)("applying to the pinned Postgres server", () => {
  test("create, then each class of change, a refusal, a lock timeout, idempotence and prune", async () => {
    // Create, and the server plans no changes afterwards.
    const created = normalizeApply(toApplyResult(await apply([APP, usersV1, ordersV1, TOTALS])));
    expect(created.applied.map((a) => [a.name, a.action])).toEqual([
      ["app", "created"],
      ["app.users", "created"],
      ["app.orders", "created"],
      ["app.order_totals", "created"],
    ]);
    expect(await one<{ c: string }>("SELECT obj_description('app.users'::regclass, 'pg_class') AS c")).toEqual({ c: "One row per account [chant managed-by=chant stack=shop env=e2e]" });
    expect((await planPgAgainstServer("e2e", buildFile([APP, usersV1, ordersV1, TOTALS]), profile())).changes).toEqual([]);
    await admin!.query("INSERT INTO app.users (email) VALUES ('a@example.com'), ('b@example.com')");
    await admin!.query("INSERT INTO app.orders (user_id, amount) SELECT id, 10 FROM app.users");

    // A column added with a default: one ALTER, existing rows read the default.
    const added = await apply([APP, usersV2, ordersV1, TOTALS]);
    expect(added.applied.find((a) => a.name === "app.users")).toMatchObject({
      action: "updated",
      statements: ["ALTER TABLE app.users ADD COLUMN status text DEFAULT 'active' NOT NULL"],
    });
    expect(await admin!.query("SELECT DISTINCT status FROM app.users")).toEqual([{ status: "active" }]);

    // An index built CONCURRENTLY on a table that exists, outside any transaction.
    const indexed = await apply([APP, usersV2, ordersV1, TOTALS, ORDERS_USER_IDX]);
    expect(indexed.applied.find((a) => a.name === "app.orders_user_id_idx")?.action).toBe("created");
    const cic = indexed.statements.find((s) => s.sql.startsWith("CREATE INDEX CONCURRENTLY"))!;
    expect(cic).toMatchObject({ class: "concurrently", statementTimeoutMs: 0 });
    expect(cic.transaction).toBeUndefined();
    expect(await one("SELECT indisvalid FROM pg_index WHERE indexrelid = 'app.orders_user_id_idx'::regclass")).toEqual({ indisvalid: true });

    // A foreign key added NOT VALID, then validated when the declaration drops NOT VALID.
    await apply([APP, usersV2, fk(true), TOTALS, ORDERS_USER_IDX]);
    expect(await one("SELECT convalidated FROM pg_constraint WHERE conname = 'orders_user_fk'")).toEqual({ convalidated: false });
    const validated = await apply([APP, usersV2, fk(false), TOTALS, ORDERS_USER_IDX]);
    expect(validated.statements.find((s) => s.object === "app.orders")).toMatchObject({ sql: "ALTER TABLE app.orders VALIDATE CONSTRAINT orders_user_fk", class: "validate" });
    expect(await one("SELECT convalidated FROM pg_constraint WHERE conname = 'orders_user_fk'")).toEqual({ convalidated: true });
    const FINAL = [APP, usersV2, fk(false), TOTALS, ORDERS_USER_IDX];

    // An expand-and-contract change (a column rename) is refused and the server is untouched.
    const renamed = { ...usersV2, ddl: usersV2.ddl.replace("email text NOT NULL,", "login text NOT NULL, -- previously: email") };
    const refused = normalizeApply(toApplyResult(await apply([APP, renamed, fk(false), TOTALS, ORDERS_USER_IDX])));
    expect(refused.notAttempted.find((n) => n.name === "app.users")).toMatchObject({ reason: "unsupported-kind" });
    expect(refused.notAttempted.find((n) => n.name === "app.users")!.detail).toMatch(/SQLPG205.*#3281/s);
    expect(await one("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'users' AND column_name = 'email'")).toEqual({ n: 1 });

    // A lock timeout: another session holds a lock on orders, and the ALTER gives up after lock_timeout instead of queueing.
    const other = await server!.connect();
    try {
      await other.query("BEGIN");
      await other.query("LOCK TABLE app.orders IN ACCESS SHARE MODE");
      const withNote = { ...fk(false), ddl: fk(false).ddl.replace("amount numeric(12, 2) NOT NULL,", "amount numeric(12, 2) NOT NULL,\n  note text,") };
      const started = Date.now();
      const err = (await apply([APP, usersV2, withNote, TOTALS, ORDERS_USER_IDX], { lockTimeoutMs: 300 }).catch((e: unknown) => e)) as PostgresApplyError;
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(err).toBeInstanceOf(PostgresApplyError);
      expect(err.outcome.failed.map((f) => f.name)).toEqual(["app.orders"]);
      expect(err.outcome.failed[0]!.error).toMatch(/lock timeout.*lock_timeout 300ms.*55P03/s);
      expect(err.outcome.transactions.at(-1)).toMatchObject({ result: "rolled-back", failedAt: { sql: "ALTER TABLE app.orders ADD COLUMN note text" } });
    } finally {
      await other.query("ROLLBACK").catch(() => undefined);
      await other.end();
    }
    expect(await one("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'note'")).toEqual({ n: 0 });

    // The same build applied twice: the second sends nothing.
    await apply(FINAL);
    const again = await apply(FINAL);
    expect(again.applied.map((a) => a.action)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged", "unchanged"]);
    expect(again.statements).toEqual([]);

    // Prune drops the owned view the build no longer declares, and spares a table made by hand.
    await admin!.query("CREATE TABLE app.handmade (id int)");
    const pruned = await apply([APP, usersV2, fk(false), ORDERS_USER_IDX], { prune: true });
    expect(pruned.pruned.map((p) => [p.kind, p.name, p.deleted])).toEqual([["Postgres::View", "app.order_totals", true]]);
    expect(await one("SELECT to_regclass('app.order_totals') IS NULL AS gone, to_regclass('app.handmade') IS NOT NULL AS kept")).toEqual({ gone: true, kept: true });
  }, 600_000);
});
