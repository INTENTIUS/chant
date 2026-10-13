import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { describeApplyConformance } from "@intentius/chant-test-utils";
import { normalizeApply } from "@intentius/chant/apply";
import { buildMajor, postgresApply, type PostgresApplyArgs, type PostgresApplyDeps } from "./postgres-apply";
import { toApplyResult } from "./index";
import { writablePostgres, type StoredPgObject, type WritablePostgres } from "../../postgres/testing/writable-server";
import { PostgresApplyError } from "../../postgres/apply/apply";
import { PostgresQueryError } from "../../postgres/live/client";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Obj {
  export: string;
  type: string;
  ddl: string;
  dependsOn?: string[];
}

const APP: Obj = { export: "app", type: "Postgres::Schema", ddl: "CREATE SCHEMA app" };
const USERS: Obj = {
  export: "users",
  type: "Postgres::Table",
  dependsOn: ["app"],
  ddl: "CREATE TABLE app.users (\n  id bigint PRIMARY KEY,\n  email text NOT NULL\n);\nCOMMENT ON TABLE app.users IS 'Accounts'",
};
const EMAIL_IDX: Obj = { export: "usersEmail", type: "Postgres::Index", dependsOn: ["users"], ddl: "CREATE INDEX CONCURRENTLY users_email_idx ON app.users (email)" };
const EMAILS: Obj = { export: "emails", type: "Postgres::View", dependsOn: ["users"], ddl: "CREATE VIEW app.emails AS SELECT email FROM app.users" };
const ALL = [APP, USERS, EMAIL_IDX, EMAILS];

function buildOutput(objects: Obj[], extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-postgres-apply-"));
  dirs.push(dir);
  const path = join(dir, "schema.json");
  writeFileSync(path, JSON.stringify({ dialect: "postgres", ...extra, applyOrder: objects.map((o) => o.export), objects: objects.map((o) => ({ dependsOn: [], ...o })) }));
  return path;
}

const OURS = "[chant managed-by=chant stack=shop env=prod]";
const deps = (s: WritablePostgres | undefined, extra: Partial<PostgresApplyDeps> = {}): PostgresApplyDeps => ({
  config: { ownership: { stack: "shop", env: "prod" } },
  env: s ? { POSTGRES_URL: "postgres://fake:5432/shop" } : {},
  log: () => undefined,
  connect: async () => s!.client,
  readLive: () => s!.readLive(),
  serverNormalize: async (_client, o) => o,
  ...extra,
});

const apply = (s: WritablePostgres | undefined, objects: Obj[], args: Partial<PostgresApplyArgs> = {}, extra: Partial<PostgresApplyDeps> = {}) =>
  postgresApply({ buildPath: buildOutput(objects), environment: "test", ...args }, undefined, deps(s, extra));
const run = async (s: WritablePostgres | undefined, objects: Obj[], args: Partial<PostgresApplyArgs> = {}, extra: Partial<PostgresApplyDeps> = {}) =>
  toApplyResult(await apply(s, objects, args, extra));

/** What the server holds after a first apply of `objects`. */
async function applied(objects: Obj[] = ALL): Promise<WritablePostgres> {
  const s = writablePostgres();
  await apply(s, objects);
  s.writes.length = 0;
  s.deletes.length = 0;
  s.control.length = 0;
  return s;
}

const table = (name: string, comment?: string): StoredPgObject => ({
  type: "Postgres::Table",
  schema: "app",
  name,
  create: `CREATE TABLE app.${name} (id bigint)`,
  ...(comment !== undefined ? { comment } : {}),
});

describe("creating", () => {
  test("an empty server gets every object, each marked by COMMENT ON, the declared comment kept", async () => {
    const s = writablePostgres();
    const r = normalizeApply(await run(s, ALL));
    expect(r.applied.map((a) => [a.name, a.action])).toEqual([
      ["app", "created"],
      ["app.users", "created"],
      ["app.users_email_idx", "created"],
      ["app.emails", "created"],
    ]);
    expect(s.writes).toContain(`COMMENT ON SCHEMA app IS '${OURS}'`);
    expect(s.writes).toContain(`COMMENT ON TABLE app.users IS 'Accounts ${OURS}'`);
    expect(s.writes).not.toContain("COMMENT ON TABLE app.users IS 'Accounts'");
  });

  test("catalog-only statements share a transaction; CREATE INDEX CONCURRENTLY runs outside one", async () => {
    const s = writablePostgres();
    const outcome = await apply(s, ALL);
    const cic = outcome.statements.find((x) => x.sql.startsWith("CREATE INDEX CONCURRENTLY"))!;
    expect(cic.transaction).toBeUndefined();
    expect(outcome.statements.filter((x) => x.object === "app" || x.object === "app.users").every((x) => x.transaction === 0)).toBe(true);
    expect(outcome.transactions.map((t) => [t.objects, t.result])).toEqual([
      [["app", "app.users"], "committed"],
      [["app.users_email_idx", "app.emails"], "committed"],
    ]);
  });

  test("every statement runs with the default timeouts, recorded on the outcome", async () => {
    const lines: string[] = [];
    const outcome = await apply(writablePostgres(), ALL, {}, { log: (l) => lines.push(l) });
    expect(outcome.timeouts).toEqual({ lockTimeoutMs: 5000, statementTimeoutMs: 60000, scanTimeoutMs: 0 });
    expect(lines.slice(0, 4)).toEqual(["BEGIN", "SET LOCAL lock_timeout = '5000ms'", "SET LOCAL statement_timeout = '60000ms'", "CREATE SCHEMA app"]);
    const cic = lines.indexOf("CREATE INDEX CONCURRENTLY users_email_idx ON app.users (email)");
    // On a table created in the same apply the build is part of the create.
    expect(lines.slice(cic - 2, cic)).toEqual(["SET lock_timeout = '5000ms'", "SET statement_timeout = '60000ms'"]);
  });

  test("an index built on a table that exists runs under the scan timeout, outside a transaction", async () => {
    const s = await applied([APP, USERS]);
    const lines: string[] = [];
    const outcome = await apply(s, [APP, USERS, EMAIL_IDX], {}, { log: (l) => lines.push(l) });
    expect(lines.slice(0, 3)).toEqual(["SET lock_timeout = '5000ms'", "SET statement_timeout = '0ms'", "CREATE INDEX CONCURRENTLY users_email_idx ON app.users (email)"]);
    expect(outcome.statements[0]).toMatchObject({ class: "concurrently", statementTimeoutMs: 0 });
    expect(outcome.statements[0]!.transaction).toBeUndefined();
  });

  test("the profile's timeouts, overridden by the arguments", async () => {
    const lines: string[] = [];
    const config = { ownership: { stack: "shop", env: "prod" }, sql: { profiles: { test: { url: "postgres://fake/shop", lockTimeoutMs: 250, statementTimeoutMs: 1000 } } } };
    const outcome = await apply(writablePostgres(), [APP], { statementTimeoutMs: 2000 }, { config, env: {}, log: (l) => lines.push(l) });
    expect(outcome.timeouts).toEqual({ lockTimeoutMs: 250, statementTimeoutMs: 2000, scanTimeoutMs: 0 });
    expect(lines).toContain("SET LOCAL lock_timeout = '250ms'");
    expect(outcome.statements[0]).toMatchObject({ lockTimeoutMs: 250, statementTimeoutMs: 2000, transaction: 0 });
  });

  test("without an ownership stack the marker says managed-by alone", async () => {
    const s = writablePostgres();
    await run(s, [APP], {}, { config: {} });
    expect(s.writes).toContain("COMMENT ON SCHEMA app IS '[chant managed-by=chant]'");
  });
});

describe("updating", () => {
  test("an added column with a default is one ALTER, its table updated", async () => {
    const s = await applied();
    const withName = { ...USERS, ddl: USERS.ddl.replace("email text NOT NULL", "email text NOT NULL,\n  name text NOT NULL DEFAULT 'none'") };
    const r = normalizeApply(await run(s, [APP, withName, EMAIL_IDX, EMAILS]));
    expect(r.applied.find((a) => a.name === "app.users")?.action).toBe("updated");
    expect(s.writes).toEqual(["ALTER TABLE app.users ADD COLUMN name text DEFAULT 'none' NOT NULL"]);
  });

  test("an expand-and-contract change is not attempted, naming the rule and the migration Op", async () => {
    const s = await applied();
    const renamed = { ...USERS, ddl: USERS.ddl.replace("email text NOT NULL", "mail text NOT NULL -- previously: email") };
    const r = normalizeApply(await run(s, [APP, renamed]));
    const users = r.notAttempted.find((n) => n.name === "app.users");
    expect(users).toMatchObject({ kind: "Postgres::Table", reason: "unsupported-kind" });
    expect(users!.detail).toMatch(/SQLPG205 Rename a column/);
    expect(users!.detail).toMatch(/postgresql\.org\/docs\/18/);
    expect(users!.detail).toContain('PostgresMigrationOp({ table: "app.users", column: "mail", ... })');
    expect(s.writes).toEqual([]);
  });

  test("a column drop is withheld unless the apply may delete", async () => {
    const s = await applied([APP, USERS]);
    const without = { ...USERS, ddl: USERS.ddl.replace(",\n  email text NOT NULL", "") };
    const withheld = normalizeApply(await run(s, [APP, without]));
    expect(withheld.notAttempted[0]).toMatchObject({ name: "app.users", reason: "filtered" });
    expect(s.writes).toEqual([]);
    await run(s, [APP, without], { prune: true });
    expect(s.writes).toEqual(["ALTER TABLE app.users DROP COLUMN email"]);
  });

  test("an object whose comment lost the marker is stamped again, its own comment kept", async () => {
    const s = await applied([APP, USERS]);
    s.objects.find((o) => o.name === "users")!.comment = "Accounts";
    const r = normalizeApply(await run(s, [APP, USERS]));
    expect(r.applied.find((a) => a.name === "app.users")?.action).toBe("updated");
    expect(s.writes).toEqual([`COMMENT ON TABLE app.users IS 'Accounts ${OURS}'`]);
  });

  test("an object another tool keeps is left alone", async () => {
    const s = writablePostgres([{ ...table("_prisma_migrations"), foreign: "Prisma Migrate" }]);
    const prisma: Obj = { export: "prisma", type: "Postgres::Table", ddl: "CREATE TABLE app._prisma_migrations (id bigint)" };
    const r = normalizeApply(await run(s, [prisma]));
    expect(r.notAttempted[0]).toMatchObject({ reason: "filtered" });
    expect(r.notAttempted[0]!.detail).toMatch(/Prisma Migrate keeps/);
  });
});

describe("a statement the server refuses", () => {
  test("rolls its transaction back: its object fails, the others in it are not attempted with the statement named", async () => {
    const s = writablePostgres();
    s.refuse = /^CREATE TABLE/;
    const err = (await apply(s, ALL).catch((e: unknown) => e)) as PostgresApplyError;
    expect(err).toBeInstanceOf(PostgresApplyError);
    expect(err.outcome.failed.map((f) => f.name)).toEqual(["app.users"]);
    const app = err.outcome.notAttempted.find((n) => n.name === "app")!;
    expect(app.reason).toBe("dependency-failed");
    expect(app.detail).toMatch(/transaction that rolled back.*failed at CREATE TABLE app\.users/s);
    expect(err.outcome.notAttempted.filter((n) => n.name !== "app").map((n) => [n.name, n.reason])).toEqual([
      ["app.users_email_idx", "dependency-failed"],
      ["app.emails", "dependency-failed"],
    ]);
    expect(s.control).toEqual(["BEGIN", "ROLLBACK"]);
    expect(s.objects).toEqual([]);
  });

  test("a lock timeout says which timeout fired", async () => {
    const s = await applied([APP, USERS]);
    s.refuse = /^ALTER TABLE/;
    s.refuseCode = "55P03";
    const withName = { ...USERS, ddl: USERS.ddl.replace("email text NOT NULL", "email text NOT NULL, name text") };
    const err = (await apply(s, [APP, withName]).catch((e: unknown) => e)) as PostgresApplyError;
    expect(err.outcome.failed[0]!.error).toMatch(/lock_timeout 5000ms: another session holds a lock/);
    expect(err.outcome.transactions[0]).toMatchObject({ result: "rolled-back", failedAt: { sql: "ALTER TABLE app.users ADD COLUMN name text" } });
  });
});

describe("the catalog read before applying (#3726)", () => {
  test("runs under the profile's lockTimeoutMs, else 5000 ms, else the argument's", async () => {
    for (const [profile, arg, expected] of [[undefined, undefined, "5000ms"], [250, undefined, "250ms"], [250, 75, "75ms"]] as const) {
      const s = writablePostgres();
      const sent: unknown[][] = [];
      const config = { ownership: { stack: "shop", env: "prod" }, sql: { profiles: { test: { url: "postgres://fake/shop", ...(profile !== undefined ? { lockTimeoutMs: profile } : {}) } } } };
      const client = { query: (sql: string, p?: readonly unknown[]) => (sent.push([sql, ...(p ?? [])]), s.client.query(sql)), end: s.client.end };
      await apply(s, [APP], arg !== undefined ? { lockTimeoutMs: arg } : {}, { config, env: {}, connect: async () => client as never });
      expect(sent[0]).toEqual(["SELECT pg_catalog.set_config('lock_timeout', $1, false)", expected]);
    }
  });

  test("blocked behind ACCESS EXCLUSIVE, it stops before any write, naming the relation and the pid holding it", async () => {
    const s = writablePostgres();
    const client = {
      async query<T>(sql: string): Promise<T[]> {
        if (sql.includes("pg_get_viewdef")) throw new PostgresQueryError("canceling statement due to lock timeout", "55P03");
        if (sql.includes("pg_catalog.pg_locks")) return [{ pid: 4242, relation: "app.users", application: "psql", state: "idle in transaction", seconds: 9, query: "LOCK TABLE app.users" }] as T[];
        return s.client.query<T>(sql);
      },
      end: s.client.end,
    };
    const err = (await apply(s, ALL, {}, { connect: async () => client as never, readLive: async (c) => (await c.query("SELECT pg_catalog.pg_get_viewdef(1)"), []) }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(PostgresQueryError);
    expect(err.message).toContain("canceling statement due to lock timeout: the catalog read waited 5000ms for a lock");
    expect(err.message).toContain("app.users is held in ACCESS EXCLUSIVE by pid 4242");
    expect(s.writes).toEqual([]);
    expect(s.control).toEqual([]);
  });
});

describe("the target major", () => {
  test("is the build output's postgresMajor", () => {
    expect(buildMajor(JSON.stringify({ dialect: "postgres", postgresMajor: 16, objects: [] }))).toBe(16);
    expect(buildMajor(JSON.stringify({ sql: { dialect: "postgres", postgresMajor: 15 } }))).toBe(15);
    expect(buildMajor(JSON.stringify({ dialect: "postgres", objects: [] }))).toBeUndefined();
  });
});

const PLAN = [
  { kind: "Postgres::Schema", name: "app" },
  { kind: "Postgres::Table", name: "app.users" },
  { kind: "Postgres::Index", name: "app.users_email_idx" },
  { kind: "Postgres::View", name: "app.emails" },
];

describeApplyConformance({
  lexicon: "sql (postgres)",
  scenarios: [
    {
      name: "a schema, a table, an index and a view on an empty server",
      plan: PLAN,
      run: async () => run(writablePostgres(), ALL),
      expectApplied: PLAN.map((p) => `${p.kind}/${p.name}`),
    },
    {
      name: "a column rename refused as expand and contract beside an unchanged schema",
      plan: PLAN.slice(0, 2),
      run: async () => run(await applied([APP, USERS]), [APP, { ...USERS, ddl: USERS.ddl.replace("email text NOT NULL", "mail text NOT NULL -- previously: email") }]),
      expectApplied: ["Postgres::Schema/app"],
      expectNotAttempted: ["Postgres::Table/app.users"],
    },
    {
      name: "no server bound",
      plan: PLAN.slice(0, 2),
      run: () => run(undefined, [APP, USERS]),
      expectNotAttempted: ["Postgres::Schema/app", "Postgres::Table/app.users"],
    },
    {
      name: "prune without an ownership stack",
      plan: [{ kind: "Postgres::Schema", name: "app" }],
      run: async () => run(writablePostgres([{ type: "Postgres::Schema", name: "app", create: "CREATE SCHEMA app", comment: "[chant managed-by=chant]" }, table("old", "[chant managed-by=chant]")]), [APP], { prune: true }, { config: {} }),
      expectApplied: ["Postgres::Schema/app"],
      expectNotAttempted: ["Postgres::Table/app.old"],
    },
  ],
  pruneScenarios: [
    {
      name: "an owned orphan table beside one created by hand",
      ownedOrphan: "app.old",
      foreign: "app.handmade",
      run: async () => {
        const s = await applied([APP]);
        s.objects.push(table("old", OURS), table("handmade", "made by hand"));
        return { result: await run(s, [APP], { prune: true }), deletes: s.deletes };
      },
    },
    {
      name: "an owned orphan table beside another stack's",
      ownedOrphan: "app.old",
      foreign: "app.theirs",
      run: async () => {
        const s = await applied([APP]);
        s.objects.push(table("old", OURS), table("theirs", "[chant managed-by=chant stack=other env=prod]"));
        return { result: await run(s, [APP], { prune: true }), deletes: s.deletes };
      },
    },
  ],
  idempotenceScenarios: [
    {
      name: "the same build applied twice",
      run: async () => {
        const s = writablePostgres();
        const first = await run(s, ALL);
        const second = await run(s, ALL);
        return { first, second };
      },
    },
  ],
});

describe("idempotence", () => {
  test("the second apply sends nothing and reports every object unchanged", async () => {
    const s = await applied();
    const second = normalizeApply(await run(s, ALL));
    expect(second.applied.map((a) => a.action)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
    expect(s.writes).toEqual([]);
    expect(s.control).toEqual([]);
  });
});
