/**
 * A scheduled drift check over a sql environment, run end to end (#3642).
 *
 * For each dialect, a project in a temporary directory declares a schema, an
 * `ApplyOp` that creates it as an admin, and a `WatchOp` with a `schedule`
 * over a second environment whose profile reads the server as a user that can
 * only read. `chant run` runs the watch, as the job `generateOpsPipeline`
 * renders does (`watch-pipeline.test.ts`), and its `Drift` outcome is read off
 * the run:
 *
 * - false on the schema as applied;
 * - false after a table the project does not own is created beside it;
 * - true after an owned object's property is changed out of band;
 * - true after an owned object is dropped.
 *
 * Everything is written to the database (ClickHouse) or schema (Postgres)
 * `yodel_3642`, and a reader user named after it.
 *
 * The servers: `CHANT_SQL_WATCH_CLICKHOUSE_URL` and
 * `CHANT_SQL_WATCH_POSTGRES_URL` (a `postgres://user@host:port/db` URL, with
 * `CHANT_SQL_WATCH_POSTGRES_PASSWORD`) name running ones, such as the servers
 * `chant emulator up --lexicon sql` starts. Without them, each dialect starts
 * a throwaway server at the same pin, and skips cleanly when Docker is not
 * available.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startScratchServer, type ScratchServer } from "../clickhouse/container";
import { clickhouseQuery, type ClickHouseEndpoint } from "../clickhouse/http";
import { clickhouseImage } from "../spec/pin";
import { startTestPostgres, type TestPostgres } from "../postgres/testing/server";
import { connectPostgres, type PostgresClient, type PostgresEndpoint } from "../postgres/live/client";

const exec = promisify(execFile);

const REPO = join(import.meta.dirname, "../../../..");
const BIN = join(REPO, "node_modules/.bin");
const NAME = "yodel_3642";
const READER = `${NAME}_reader`;
const READER_PASSWORD = "reader-3642";

const givenClickHouse = process.env.CHANT_SQL_WATCH_CLICKHOUSE_URL;
const givenPostgres = process.env.CHANT_SQL_WATCH_POSTGRES_URL;
const docker = givenClickHouse && givenPostgres ? false : await dockerAvailable();

interface Watch {
  drift: boolean;
  output: string;
}

/**
 * A project directory chant can run in: the repository's `node_modules`
 * linked in, so `@intentius/chant` and the sql lexicon resolve, and a git
 * repository, which the watch's snapshot is written to.
 */
async function project(files: Record<string, string>): Promise<{ dir: string; run(op: string, env?: Record<string, string>): Promise<Watch> }> {
  const dir = mkdtempSync(join(tmpdir(), "chant-sql-watch-"));
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
  const all: Record<string, string> = {
    "package.json": JSON.stringify({ name: "sql-watch-e2e", private: true, type: "module", scripts: { build: "chant build src --lexicon sql -o dist/schema.json" } }),
    ".gitignore": "node_modules\ndist\n.chant\n",
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const git = (...args: string[]) => exec("git", ["-c", "user.email=e2e@chant.invalid", "-c", "user.name=e2e", ...args], { cwd: dir });
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-qm", "the schema");
  return {
    dir,
    async run(op, env = {}) {
      const result = await exec(join(BIN, "chant"), ["run", op], {
        cwd: dir,
        env: { ...process.env, ...env, PATH: `${BIN}:${process.env.PATH ?? ""}` },
        maxBuffer: 16 * 1024 * 1024,
      }).catch((err: { stdout?: string; stderr?: string; message: string }) => {
        throw new Error(`chant run ${op} failed: ${err.message}\n${err.stdout ?? ""}${err.stderr ?? ""}`);
      });
      const output = `${result.stdout}${result.stderr}`.replace(/\u001b\[[0-9;]*m/g, "");
      const outcome = /\[outcome\] Drift=(true|false)/.exec(output);
      if (op === "schema-watch" && !outcome) throw new Error(`chant run ${op} reported no Drift outcome:\n${output}`);
      return { drift: outcome?.[1] === "true", output };
    },
  };
}

const OPS = (target: string) => ({
  "ops/apply.op.ts": `import { ApplyOp } from "@intentius/chant/op";
const { op } = ApplyOp({ name: "schema-apply", env: "admin", target: "${target}" });
export default op;
`,
  "ops/watch.op.ts": `import { WatchOp } from "@intentius/chant/op";
const { op } = WatchOp({ name: "schema-watch", env: "watch", schedule: "17 * * * *" });
export default op;
`,
});

const config = (sql: Record<string, unknown>) => `import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  ownership: { stack: "yodel-3642", env: "watch" },
  sql: ${JSON.stringify(sql, null, 2)},
} satisfies ChantConfig;
`;

const READER_ENV = { WATCH_USER: READER, WATCH_PASSWORD: READER_PASSWORD };

// ── ClickHouse ──────────────────────────────────────────────────────────────

describe.skipIf(!givenClickHouse && !docker)("a scheduled WatchOp over a ClickHouse environment (#3642)", () => {
  let server: ScratchServer | undefined;
  let admin: ClickHouseEndpoint;
  let p: Awaited<ReturnType<typeof project>>;
  const q = (sql: string) => clickhouseQuery(admin, sql);
  const cleanup = async () => {
    await q(`DROP DATABASE IF EXISTS ${NAME} SYNC`);
    await q(`DROP USER IF EXISTS ${READER}`);
  };

  beforeAll(async () => {
    if (givenClickHouse) admin = { url: givenClickHouse };
    else {
      server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-watch" });
      admin = server.endpoint;
    }
    await cleanup();
    p = await project({
      ...OPS("clickhouse"),
      "chant.config.ts": config({
        dialect: "clickhouse",
        profiles: {
          admin: { url: admin.url, databases: [NAME] },
          watch: { url: admin.url, user: { env: "WATCH_USER" }, password: { env: "WATCH_PASSWORD" }, databases: [NAME] },
        },
      }),
      "src/schema.ts": `import { database, table, view } from "@intentius/chant-lexicon-sql/clickhouse";

export const db = database\`CREATE DATABASE ${NAME} ENGINE = Atomic COMMENT 'drift watch'\`;

export const events = table\`
  CREATE TABLE \${db}.events (
    user_id UInt64,
    kind    LowCardinality(String),
    ts      DateTime
  )
  ENGINE = MergeTree
  ORDER BY (user_id, ts)
  TTL ts + INTERVAL 180 DAY
  COMMENT 'Raw events'\`;

export const byKind = view\`
  CREATE VIEW \${db}.by_kind AS
  SELECT \${events.columns.kind} AS kind, count() AS n FROM \${events} GROUP BY kind\`;
`,
    });
    const applied = await p.run("schema-apply");
    expect(applied.output).toMatch(/Op "schema-apply" completed/);
    // A reader: SELECT on the database and nothing else, and readonly besides.
    await q(`CREATE USER ${READER} IDENTIFIED WITH sha256_password BY '${READER_PASSWORD}' SETTINGS readonly = 1`);
    await q(`GRANT SELECT ON ${NAME}.* TO ${READER}`);
  }, 600_000);

  afterAll(async () => {
    if (admin) await cleanup().catch(() => undefined);
    await server?.stop();
    if (p) rmSync(p.dir, { recursive: true, force: true });
  });

  test("reports no drift on the schema as applied", async () => {
    const watch = await p.run("schema-watch", READER_ENV);
    expect(watch.output).toContain("No drift detected");
    expect(watch.drift).toBe(false);
  }, 120_000);

  test("reports nothing for a table the project does not own", async () => {
    await q(`CREATE TABLE ${NAME}.made_by_hand (id UInt64) ENGINE = MergeTree ORDER BY id COMMENT 'not chant'`);
    const watch = await p.run("schema-watch", READER_ENV);
    expect(watch.output).not.toContain("made_by_hand");
    expect(watch.drift).toBe(false);
  }, 120_000);

  test("reports drift when an owned table's TTL is changed out of band", async () => {
    await q(`ALTER TABLE ${NAME}.events MODIFY TTL ts + INTERVAL 30 DAY`);
    const watch = await p.run("schema-watch", READER_ENV);
    expect(watch.output).toContain("PROPERTY DRIFT");
    expect(watch.output).toMatch(/- events \(ClickHouse::Table\)\n\s+ttl: ts \+ INTERVAL 180 DAY → ts \+ toIntervalDay\(30\)/);
    expect(watch.drift).toBe(true);
    await q(`ALTER TABLE ${NAME}.events MODIFY TTL ts + INTERVAL 180 DAY`);
  }, 120_000);

  test("reports drift when an owned view is dropped", async () => {
    await q(`DROP VIEW ${NAME}.by_kind`);
    const watch = await p.run("schema-watch", READER_ENV);
    expect(watch.output).toMatch(/MISSING \(declared, provider reports not in cloud\):\n\s+- byKind /);
    expect(watch.drift).toBe(true);
  }, 120_000);
});

// ── Postgres ────────────────────────────────────────────────────────────────

describe.skipIf(!givenPostgres && !docker)("a scheduled WatchOp over a Postgres environment (#3642)", () => {
  let server: TestPostgres | undefined;
  let endpoint: PostgresEndpoint;
  let admin: PostgresClient;
  let p: Awaited<ReturnType<typeof project>>;
  const q = (sql: string) => admin.query(sql);
  const cleanup = async () => {
    await q(`DROP SCHEMA IF EXISTS ${NAME} CASCADE`);
    await q(`DROP ROLE IF EXISTS ${READER}`);
  };

  beforeAll(async () => {
    if (givenPostgres) endpoint = { url: givenPostgres, password: process.env.CHANT_SQL_WATCH_POSTGRES_PASSWORD };
    else {
      server = await startTestPostgres();
      endpoint = server.endpoint();
    }
    admin = await connectPostgres(endpoint);
    await cleanup();
    const readerUrl = new URL(endpoint.url);
    readerUrl.username = READER;
    p = await project({
      ...OPS("postgres"),
      "chant.config.ts": config({
        dialect: "postgres",
        profiles: {
          admin: { url: endpoint.url, password: { env: "ADMIN_PASSWORD" }, schemas: [NAME] },
          watch: { url: readerUrl.toString(), password: { env: "WATCH_PASSWORD" }, schemas: [NAME] },
        },
      }),
      "src/schema.ts": `import { schema, table, index } from "@intentius/chant-lexicon-sql/postgres";

export const app = schema\`CREATE SCHEMA ${NAME};
COMMENT ON SCHEMA ${NAME} IS 'drift watch'\`;

export const orders = table\`
  CREATE TABLE \${app}.orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    status text NOT NULL DEFAULT 'new',
    amount numeric(12, 2) NOT NULL
  );
  COMMENT ON TABLE \${app}.orders IS 'One row per order'\`;

export const ordersStatus = index\`CREATE INDEX orders_status_idx ON \${orders} (\${orders.columns.status})\`;
`,
    });
    const applied = await p.run("schema-apply", { ADMIN_PASSWORD: endpoint.password ?? "" });
    expect(applied.output).toMatch(/Op "schema-apply" completed/);
    // A reader: it may log in and look in the schema, and every transaction it opens is read-only.
    await q(`CREATE ROLE ${READER} LOGIN PASSWORD '${READER_PASSWORD}'`);
    await q(`ALTER ROLE ${READER} SET default_transaction_read_only = on`);
    await q(`GRANT USAGE ON SCHEMA ${NAME} TO ${READER}`);
  }, 600_000);

  afterAll(async () => {
    if (admin) {
      await cleanup().catch(() => undefined);
      await admin.end();
    }
    await server?.stop();
    if (p) rmSync(p.dir, { recursive: true, force: true });
  });

  test("reports no drift on the schema as applied", async () => {
    const watch = await p.run("schema-watch", READER_ENV);
    expect(watch.output).toContain("No drift detected");
    expect(watch.drift).toBe(false);
  }, 120_000);

  test("reports nothing for a table the project does not own", async () => {
    await q(`CREATE TABLE ${NAME}.made_by_hand (id int)`);
    const watch = await p.run("schema-watch", READER_ENV);
    expect(watch.output).not.toContain("made_by_hand");
    expect(watch.drift).toBe(false);
  }, 120_000);

  test("reports drift when an owned column's default is changed out of band", async () => {
    await q(`ALTER TABLE ${NAME}.orders ALTER COLUMN status SET DEFAULT 'pending'`);
    const watch = await p.run("schema-watch", READER_ENV);
    expect(watch.output).toContain("PROPERTY DRIFT");
    expect(watch.output).toMatch(/- orders \(Postgres::Table\)\n\s+columns\[1\]\.default: 'new' → 'pending'::text/);
    expect(watch.drift).toBe(true);
    await q(`ALTER TABLE ${NAME}.orders ALTER COLUMN status SET DEFAULT 'new'`);
  }, 120_000);

  test("reports drift when an owned index is dropped", async () => {
    await q(`DROP INDEX ${NAME}.orders_status_idx`);
    const watch = await p.run("schema-watch", READER_ENV);
    expect(watch.output).toMatch(/MISSING \(declared, provider reports not in cloud\):\n\s+- ordersStatus /);
    expect(watch.drift).toBe(true);
  }, 120_000);
});
