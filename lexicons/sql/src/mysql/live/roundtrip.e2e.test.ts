/**
 * The MySQL live round trip (#5449): a schema declared with the MySQL tags is
 * planned against an empty MySQL 8.0 server, applied, and planned again with
 * no change, so the canonical form of each declaration equals the canonical
 * form of the server's real `SHOW CREATE`. A change is then planned, classed,
 * applied and planned again with no change; every declared object is present;
 * and the server's schema imported back as declarations plans no change
 * against the server it came from.
 *
 * Needs Docker and the `mysql2` package; skips cleanly without either. One
 * throwaway `mysql` container at the pin (8.0.40, by tag and digest), removed
 * afterwards even on failure. Nothing is written to the working tree.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SerializerResult } from "@intentius/chant/serializer";
import { normalizeObservation } from "@intentius/chant/observation";
import { dockerAvailable, startScratchContainer, type ScratchContainer } from "../../core/container";
import { mysqlPin } from "../../spec/mysql-pin";
import { sqlSerializer } from "../../serializer";
import { sqlFileEntities } from "../../sql-files";
import { database, table, view } from "../entities";
import { applyMysql, declaredObjects, planAgainstClient } from "../apply/apply";
import { canonicalObject, objectKey } from "../canonical";
import { connectMysql, type MysqlClient } from "./client";
import { readLiveSchema } from "./catalog";
import { describeMysqlResources } from "./describe-resources";
import { exportMysqlResources } from "../import/live-export";
import { MysqlGenerator } from "../import/generator";

/** The pinned server: the MySQL 8.0 minor the catalog is for, by tag and by its multi-arch index digest. */
const MYSQL_VERSION = "8.0.40";
const MYSQL_IMAGE = `mysql:${MYSQL_VERSION}@sha256:d58ac93387f644e4e040c636b8f50494e78e5afc27ca0a87348b2f577da2b7ff`;
const ROOT_PASSWORD = "chant-roundtrip";
const DB = "rt";

async function mysql2Available(): Promise<boolean> {
  const specifier = "mysql2/promise";
  try {
    await import(/* @vite-ignore */ specifier);
    return true;
  } catch {
    return false;
  }
}

const docker = await dockerAvailable();
const driver = await mysql2Available();
const enabled = docker && driver;
if (!enabled) {
  console.warn(`mysql round trip skipped: ${!docker ? "no Docker daemon answers" : "the mysql2 package is not installed (npm install mysql2)"}`);
}

let container: ScratchContainer | undefined;
let client: MysqlClient | undefined;
const url = (port: string) => `mysql://127.0.0.1:${port}/${DB}`;
const endpoint = (port: string) => ({ url: url(port), user: "root", password: ROOT_PASSWORD });

beforeAll(async () => {
  if (!enabled) return;
  container = await startScratchContainer({
    image: MYSQL_IMAGE,
    namePrefix: "chant-mysql-roundtrip",
    containerPort: 3306,
    env: { MYSQL_ROOT_PASSWORD: ROOT_PASSWORD },
    removeVolumes: true,
    readyTimeoutMs: 240_000,
    notReady: "did not accept a connection",
    // The image starts a temporary server for its initialisation first; a query on the published port means the real one is up.
    ready: async (port) => {
      try {
        const c = await connectMysql({ url: `mysql://127.0.0.1:${port}/`, user: "root", password: ROOT_PASSWORD });
        try {
          await c.query("SELECT 1");
          return true;
        } finally {
          await c.end();
        }
      } catch {
        return false;
      }
    },
  });
  client = await connectMysql({ url: `mysql://127.0.0.1:${container.port}/`, user: "root", password: ROOT_PASSWORD });
}, 900_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

const tag = (fn: (s: TemplateStringsArray) => unknown, sql: string) => fn(Object.assign([sql], { raw: [sql] }) as unknown as TemplateStringsArray);

/** A build's primary output for `entities`, as `chant build` writes it. */
const buildOf = (entities: Map<string, unknown>): string => (sqlSerializer.serialize(entities as never) as SerializerResult).primary;

/** The declared schema: every kind of column default, key, foreign key and check the canonical form normalises. */
function schema(extra: { usersColumns?: string; usersKeys?: string; activeDefault?: string } = {}): Map<string, unknown> {
  const rt = database`CREATE DATABASE rt DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`;
  const users = tag(
    table,
    `CREATE TABLE rt.users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(100),
      active BOOLEAN NOT NULL DEFAULT ${extra.activeDefault ?? "TRUE"},
      score INTEGER DEFAULT 0,
      balance DECIMAL(12,2) NOT NULL DEFAULT 0,
      kind ENUM('person', 'company') NOT NULL DEFAULT 'person',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW() ON UPDATE NOW(),
      email_lower VARCHAR(255) AS (lower(email)) VIRTUAL,${extra.usersColumns ?? ""}
      UNIQUE KEY users_email (email),
      KEY (created_at),
      CHECK (balance >= 0)${extra.usersKeys ?? ""}
    ) ENGINE = InnoDB COMMENT = 'people who buy'`,
  );
  const orders = tag(
    table,
    `CREATE TABLE rt.orders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      total DECIMAL(10,2) NOT NULL DEFAULT 0,
      note TEXT,
      PRIMARY KEY (id),
      CONSTRAINT orders_user FOREIGN KEY (user_id) REFERENCES rt.users (id) ON DELETE CASCADE,
      CONSTRAINT orders_total CHECK (total >= 0)
    )`,
  );
  const paid = tag(view, "CREATE VIEW rt.big_orders AS SELECT id, user_id, total FROM rt.orders WHERE total > 100");
  return new Map<string, unknown>([["rt", rt], ["users", users], ["orders", orders], ["bigOrders", paid]]);
}

const target = () => ({ endpoint: endpoint(container!.port), source: "sql.profiles.rt", defaultDatabase: DB });
const marker = { stack: "rt", env: "e2e" };
const profile = () => ({ config: { sql: { profiles: { rt: { url: url(container!.port), user: { env: "MYSQL_RT_USER" }, password: { env: "MYSQL_RT_PASSWORD" } } } } }, env: { MYSQL_RT_USER: "root", MYSQL_RT_PASSWORD: ROOT_PASSWORD } });

describe.skipIf(!enabled)("a MySQL 8.0 server: plan, apply, plan again, import back", () => {
  test("the pin is the catalog's minor", () => {
    expect(MYSQL_VERSION).toBe(mysqlPin("8.0").version);
  });

  test("an empty server plans a create for every object, and the apply creates them in dependency order", async () => {
    const declared = declaredObjects(buildOf(schema()), DB);
    const plan = await planAgainstClient(client!, target(), declared);
    expect(plan.changes.map((c) => [c.object, c.rule])).toEqual(declared.map((o) => [o.key, "SQLMY200"]));
    const outcome = await applyMysql(client!, target(), declared, { marker });
    expect(outcome.failed).toEqual([]);
    expect(outcome.applied.map((a) => [a.name, a.action])).toEqual([
      ["database rt", "created"],
      ["table rt.users", "created"],
      ["table rt.orders", "created"],
      ["view rt.big_orders", "created"],
    ]);
  }, 120_000);

  test("each declaration's canonical form is the canonical form of the server's SHOW CREATE", async () => {
    const declared = declaredObjects(buildOf(schema()), DB);
    const live = await readLiveSchema(client!, { databases: [DB] });
    const liveByKey = new Map(live.map((o) => {
      const c = canonicalObject(o.statement, o.database ?? DB);
      return [objectKey(c), c] as const;
    }));
    // The SQL text a canonical form carries for statements is never compared; everything else is.
    const compared = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x: unknown) => (k === "definition" || k === "defaultSql" || k === "primaryKeySql" || k === "rawComment" ? undefined : x))) as unknown;
    for (const o of declared) {
      const l = liveByKey.get(o.key);
      expect(l, `${o.key} is on the server`).toBeDefined();
      const d = compared(o.canonical) as Record<string, unknown>;
      const s = compared(l) as Record<string, unknown>;
      // What the declaration leaves to the server (engine, character set, collation, a view's algorithm) is not compared.
      for (const k of Object.keys(s)) if (d[k] === undefined && ["engine", "charset", "collate", "rowFormat", "algorithm", "security"].includes(k)) delete s[k];
      if (o.canonical.kind === "view") {
        expect(s.query, `${o.key} query`).toBe(d.query);
        continue;
      }
      if (o.canonical.kind === "table") {
        const strip = (t: Record<string, unknown>) => ({ ...t, columns: (t.columns as Array<Record<string, unknown>>).map(({ charset: _c, collate: _l, ...c }) => c) });
        expect(strip(s), o.key).toEqual(strip(d));
        continue;
      }
      expect(s, o.key).toEqual(d);
    }
    // And the plan says the same: no change.
    expect((await planAgainstClient(client!, target(), declared)).changes).toEqual([]);
  }, 120_000);

  test("a second apply changes nothing, and every declared object is present and owned where it can carry a marker", async () => {
    const outcome = await applyMysql(client!, target(), declaredObjects(buildOf(schema()), DB), { marker });
    expect(outcome.applied.map((a) => a.action)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
    const entities = schema();
    const described = normalizeObservation(await describeMysqlResources({
      environment: "rt",
      entityNames: [...entities.keys()],
      entities: new Map([...entities].map(([n, e]) => [n, { entityType: (e as { entityType: string }).entityType, props: (e as { props: Record<string, unknown> }).props }])),
      ...profile(),
    }));
    expect(described.unobserved).toEqual({});
    expect(Object.keys(described.resources).sort()).toEqual([...entities.keys()].sort());
    expect(described.resources.users?.ownership).toBe("owned");
  }, 120_000);

  test("a change is classed, applied, and then plans no change", async () => {
    const changed = declaredObjects(buildOf(schema({ usersColumns: "\n      nickname VARCHAR(50),", usersKeys: ",\n      KEY users_name (name)", activeDefault: "FALSE" })), DB);
    const plan = await planAgainstClient(client!, target(), changed);
    expect(plan.changes.map((c) => [c.field, c.rule, c.class])).toEqual([
      ["columns.active.default", "SQLMY205", "instant"],
      ["columns.nickname", "SQLMY201", "instant"],
      ["indexes.users_name", "SQLMY209", "inplace"],
    ]);
    const outcome = await applyMysql(client!, target(), changed, { marker });
    expect(outcome.applied.find((a) => a.name === "table rt.users")?.action).toBe("updated");
    expect((await planAgainstClient(client!, target(), changed)).changes).toEqual([]);
  }, 120_000);

  test("the server imported back as declarations plans no change against it", async () => {
    const exported = await exportMysqlResources({ environment: "rt", ...profile() });
    expect(exported.resources.map((r) => r.type).sort()).toEqual(["MySQL::Database", "MySQL::Table", "MySQL::Table", "MySQL::View"]);
    const [file] = new MysqlGenerator().generate(exported);
    expect(file!.content).toContain('from "@intentius/chant-lexicon-sql/mysql"');
    expect(file!.content).not.toContain("[chant");
    // The imported statements read as declarations, references between them included, and build.
    const entities = sqlFileEntities("mysql", [{ origin: "imported", ddl: exported.resources.map((r) => String(r.properties.ddl)).join(";\n") }]);
    const imported = declaredObjects(buildOf(entities), DB);
    expect((await planAgainstClient(client!, target(), imported)).changes).toEqual([]);
  }, 120_000);
});
