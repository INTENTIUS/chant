import { describe, expect, test } from "vitest";
import { describeObservationConformance } from "@intentius/chant-test-utils";
import { normalizeObservation } from "@intentius/chant/observation";
import { classifyPostgresFailure, PostgresBindingError, redactUrl, resolvePostgresTarget } from "./bind";
import { PostgresQueryError } from "./client";
import { describeResources } from "./describe-resources";
import { readLiveSchema, sequenceOptions } from "./catalog";
import { fakeClient, type FakeCatalog } from "../testing/fake-client";
import { dialectOfBinding, dialectOfEntities } from "../../live-dialect";
import { sqlPlugin } from "../../plugin";

const config = {
  sql: {
    profiles: {
      prod: { url: "postgres://db.internal:5432/shop", user: { env: "PG_USER" }, password: { env: "PG_PASSWORD" }, schemas: ["app"] },
      analytics: { url: "http://clickhouse:8123" },
    },
  },
};

describe("binding an environment to a Postgres server", () => {
  test("a postgres:// profile, with its credentials from the environment", () => {
    expect(resolvePostgresTarget({ environment: "prod", config, env: { PG_USER: "app", PG_PASSWORD: "s3cret" } })).toEqual({
      endpoint: { url: "postgres://db.internal:5432/shop", user: "app", password: "s3cret" },
      source: "sql.profiles.prod",
      schemas: ["app"],
      defaultSchema: "public",
    });
  });

  test("a profile naming an unset credential is no-credentials; nothing bound is no-binding", () => {
    expect(resolvePostgresTarget({ environment: "prod", config, env: {} })).toMatchObject({ reason: "no-credentials" });
    expect(resolvePostgresTarget({ environment: "staging", config, env: {} })).toMatchObject({ reason: "no-binding" });
    expect(resolvePostgresTarget({ environment: "staging", env: { POSTGRES_URL: "postgres://localhost/x" } })).toMatchObject({ source: "env POSTGRES_URL" });
  });

  test("a refused password is no-credentials, any other failure read-failed, and a URL is shown without its password", () => {
    expect(classifyPostgresFailure(new PostgresQueryError("password authentication failed", "28P01")).reason).toBe("no-credentials");
    expect(classifyPostgresFailure(new PostgresQueryError("connection refused")).reason).toBe("read-failed");
    expect(classifyPostgresFailure(new PostgresBindingError({ reason: "no-binding", detail: "x" })).reason).toBe("no-binding");
    expect(redactUrl("postgres://app:hunter2@db/shop")).toBe("postgres://app:***@db/shop");
  });

  test("the dialect a read is for: the declarations' type, else the binding", () => {
    expect(dialectOfEntities(new Map([["a", { entityType: "Postgres::Table" }]]))).toBe("postgres");
    expect(dialectOfEntities(new Map([["a", { entityType: "ClickHouse::Table" }]]))).toBe("clickhouse");
    expect(dialectOfBinding({ environment: "prod", config })).toBe("postgres");
    expect(dialectOfBinding({ environment: "analytics", config })).toBe("clickhouse");
    expect(dialectOfBinding({ config: { sql: { dialect: "postgres" } }, env: {} })).toBe("postgres");
    expect(dialectOfBinding({ env: { POSTGRES_URL: "postgres://x/y" } })).toBe("postgres");
    expect(dialectOfBinding({ env: {} })).toBe("clickhouse");
  });
});

describe("reading the catalog", () => {
  test("a table prints as the statement that creates it, its comment's trailer taken off", async () => {
    const [t] = await readLiveSchema(
      fakeClient({ tables: [{ schema: "app", name: "users", comment: "Accounts [chant managed-by=chant stack=shop]", columns: [{ name: "id", type: "bigint", notnull: true }] }] }),
    );
    expect(t).toMatchObject({ type: "Postgres::Table", schema: "app", name: "users", comment: "Accounts [chant managed-by=chant stack=shop]" });
    expect(t!.statement).toBe("CREATE TABLE app.users (\n    id bigint NOT NULL\n);\nCOMMENT ON TABLE app.users IS 'Accounts'");
  });

  test("an ORM's revision table is read as that tool's", async () => {
    const [t] = await readLiveSchema(fakeClient({ tables: [{ schema: "public", name: "_prisma_migrations" }] }));
    expect(t!.foreign).toBe("Prisma Migrate");
  });

  test("sequence options at their defaults are left out", () => {
    const p = { type: "bigint", start: "1", increment: "1", min: "1", max: "9223372036854775807", cache: "1", cycle: false };
    expect(sequenceOptions(p, true)).toEqual([]);
    expect(sequenceOptions({ ...p, type: "integer", max: "2147483647", start: "1000" }, true)).toEqual(["AS integer", "START WITH 1000"]);
    expect(sequenceOptions({ ...p, increment: "-1", min: "-9223372036854775808", max: "-1", start: "-1" }, true)).toEqual(["INCREMENT BY -1"]);
  });
});

const CATALOG: FakeCatalog = {
  schemas: [{ name: "app" }],
  tables: [
    { schema: "app", name: "users", comment: "[chant managed-by=chant stack=shop env=prod]" },
    { schema: "app", name: "legacy" },
    { schema: "public", name: "schema_migrations" },
  ],
};
const entity = (type: string, props: Record<string, unknown>) => ({ entityType: type, props });
const options = (names: Record<string, { entityType: string; props: Record<string, unknown> }>, owned = false) => ({
  environment: "prod",
  config,
  env: { PG_USER: "app", PG_PASSWORD: "x" },
  owned,
  entityNames: Object.keys(names),
  entities: new Map(Object.entries(names)),
  connect: async () => fakeClient(CATALOG),
});
const DECLARED = {
  app: entity("Postgres::Schema", { name: "app" }),
  users: entity("Postgres::Table", { schema: "app", name: "users" }),
  legacy: entity("Postgres::Table", { schema: "app", name: "legacy" }),
  orders: entity("Postgres::Table", { schema: "app", name: "orders" }),
  migrations: entity("Postgres::Table", { name: "schema_migrations" }),
};

describe("describeResources", () => {
  test("present with its ownership, absent with the address asked", async () => {
    const r = normalizeObservation(await describeResources(options(DECLARED)));
    expect(r.resources.users).toMatchObject({ ownership: "owned", marker: { stack: "shop", env: "prod" } });
    expect(r.resources.legacy).toMatchObject({ ownership: "foreign" });
    expect(r.resources.migrations).toMatchObject({ ownership: "foreign", attributes: { keptBy: expect.stringMatching(/migration runner/) } });
    expect(r.resources.orders).toBeUndefined();
    expect(r.queried.orders).toBe("postgres://db.internal:5432/shop app.orders");
  });

  test("with owned, a foreign object is filtered, never absent", async () => {
    const r = normalizeObservation(await describeResources(options(DECLARED, true)));
    expect(r.unobserved.legacy).toMatchObject({ reason: "filtered" });
    expect(r.unobserved.migrations?.detail).toMatch(/keeps this object/);
  });
});

describeObservationConformance({
  lexicon: "sql",
  ownershipChannel: sqlPlugin.ownershipChannel,
  scenarios: [
    {
      name: "Postgres: owned, foreign and absent",
      declared: ["users", "legacy", "orders"],
      expectPresent: ["users", "legacy"],
      expectAbsent: ["orders"],
      run: () => describeResources(options({ users: DECLARED.users, legacy: DECLARED.legacy, orders: DECLARED.orders })),
    },
    {
      name: "Postgres: owned only",
      declared: ["users", "legacy"],
      owned: true,
      expectPresent: ["users"],
      expectUnobserved: ["legacy"],
      expectMarker: { users: { stack: "shop", env: "prod" } },
      run: () => describeResources(options({ users: DECLARED.users, legacy: DECLARED.legacy }, true)),
    },
    {
      name: "Postgres: a server that refuses the password",
      declared: ["users"],
      expectUnobserved: ["users"],
      run: () =>
        describeResources({
          ...options({ users: DECLARED.users }),
          connect: async () => {
            throw new PostgresQueryError("password authentication failed for user", "28P01");
          },
        }),
    },
    {
      name: "Postgres: nothing bound",
      declared: ["users"],
      expectUnobserved: ["users"],
      run: () => describeResources({ ...options({ users: DECLARED.users }), environment: "staging", env: {} }),
    },
  ],
});
