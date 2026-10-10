/**
 * A project that uses only the sql lexicon runs an Op of `effect()` batches
 * with `chant run`, and its receipts are kept on the environment's server
 * (#3657), end to end on both dialects.
 *
 * For each dialect, a project in a temporary directory declares an Op of
 * three batches. Each batch is an `effect()` whose steps run SQL with
 * `sqlExec`: the batch records itself in a log table. The second batch fails
 * while a stop table holds a row. The first `chant run --env admin` runs the
 * first batch, fails on the second, and leaves one receipt. With the stop
 * row deleted, the second run skips the first batch (the log holds it once),
 * runs the other two, and leaves three receipts, in
 * `chant_receipts.receipts` under `yodel_3657/admin/`. A third run runs
 * nothing.
 *
 * The test's own objects are in the database (ClickHouse) or schema
 * (Postgres) `yodel_3657`; its receipts are the rows of
 * `chant_receipts.receipts` whose address starts `yodel_3657/`, deleted
 * afterwards.
 *
 * The servers: `CHANT_SQL_RECEIPTS_CLICKHOUSE_URL` and
 * `CHANT_SQL_RECEIPTS_POSTGRES_URL` (a `postgres://user@host:port/db` URL, with
 * `CHANT_SQL_RECEIPTS_POSTGRES_PASSWORD`) name running ones, such as the
 * servers `chant emulator up --lexicon sql` starts. Without them, each dialect
 * starts a throwaway server at the same pin, and skips cleanly when Docker is
 * not available.
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
const NAME = "yodel_3657";
const OP = "fill-batches";
const ENV = "admin";
const PREFIX = `${NAME}/${ENV}/`;

const givenClickHouse = process.env.CHANT_SQL_RECEIPTS_CLICKHOUSE_URL;
const givenPostgres = process.env.CHANT_SQL_RECEIPTS_POSTGRES_URL;
const docker = givenClickHouse && givenPostgres ? false : await dockerAvailable();

interface Run {
  code: number;
  output: string;
}

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

/** A project directory chant can run in: the repository's `node_modules` linked in, and a git repository. */
async function project(files: Record<string, string>, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "chant-sql-receipts-"));
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
  for (const [path, text] of Object.entries({
    "package.json": JSON.stringify({ name: "sql-receipts-e2e", private: true, type: "module" }),
    ".gitignore": "node_modules\ndist\n.chant\n",
    ...files,
  })) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const git = (...args: string[]) => exec("git", ["-c", "user.email=e2e@chant.invalid", "-c", "user.name=e2e", ...args], { cwd: dir });
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-qm", "the op");
  const chant = async (...args: string[]): Promise<Run> => {
    try {
      const r = await exec(join(BIN, "chant"), args, {
        cwd: dir,
        env: { ...process.env, ...env, PATH: `${BIN}:${process.env.PATH ?? ""}` },
        maxBuffer: 16 * 1024 * 1024,
      });
      return { code: 0, output: strip(`${r.stdout}${r.stderr}`) };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof e.code === "number" ? e.code : 1, output: strip(`${e.stdout ?? ""}${e.stderr ?? ""}`) };
    }
  };
  return { dir, chant };
}

const config = (sql: Record<string, unknown>) => `import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  ownership: { stack: "${NAME}", env: "${ENV}" },
  sql: ${JSON.stringify(sql, null, 2)},
} satisfies ChantConfig;
`;

/** The Op: three batches; each runs `stop` (which fails while the stop table holds a row) and then `record`. */
const opFile = (stop: string, record: (batch: string) => string) => `import { EffectReceipt } from "@intentius/chant";
import { Op, activity, effect, phase } from "@intentius/chant/op";

const batch = (b: string, steps: ReturnType<typeof activity>[]) =>
  effect(EffectReceipt(\`fill-\${b}\`, { effect: \`fill/\${b}\`, flavor: "existence" }), steps);
const record = (b: string) => activity("sqlExec", { sql: ${JSON.stringify(record("__B__"))}.replace("__B__", b) }, "atMostOnce");

const op = Op({
  name: "${OP}",
  overview: "three batches, each with its receipt",
  phases: [
    phase("Fill", [
      batch("b1", [record("b1")]),
      batch("b2", [activity("sqlExec", { sql: ${JSON.stringify(stop)} }, "atMostOnce"), record("b2")]),
      batch("b3", [record("b3")]),
    ]),
  ],
});
export default op;
`;

/**
 * The shared scenario. `log` reads the batches the log table holds, in
 * order; `receipts` the receipt addresses under the test's prefix; `unstop`
 * deletes the stop row.
 */
async function failThenResume(p: Awaited<ReturnType<typeof project>>, io: { log: () => Promise<string[]>; receipts: () => Promise<string[]>; unstop: () => Promise<void> }) {
  const first = await p.chant("run", OP, "--env", ENV);
  expect(first.code, first.output).not.toBe(0);
  expect(await io.log()).toEqual(["b1"]);
  expect(await io.receipts()).toEqual([`${PREFIX}fill/b1`]);

  await io.unstop();
  const second = await p.chant("run", OP, "--env", ENV);
  expect(second.code, second.output).toBe(0);
  // b1 ran once: the second run read its receipt and skipped it.
  expect(await io.log()).toEqual(["b1", "b2", "b3"]);
  expect(await io.receipts()).toEqual([`${PREFIX}fill/b1`, `${PREFIX}fill/b2`, `${PREFIX}fill/b3`]);

  const third = await p.chant("run", OP, "--env", ENV);
  expect(third.code, third.output).toBe(0);
  expect(await io.log()).toEqual(["b1", "b2", "b3"]);
}

// ── ClickHouse ──────────────────────────────────────────────────────────────

describe.skipIf(!givenClickHouse && !docker)("effect() batches on ClickHouse keep their receipts in chant_receipts.receipts (#3657)", () => {
  let server: ScratchServer | undefined;
  let admin: ClickHouseEndpoint;
  let p: Awaited<ReturnType<typeof project>>;
  const q = <T = Record<string, unknown>>(sql: string) => clickhouseQuery<T>(admin, sql);
  const forget = async () => {
    const [t] = await q<{ n: string }>("SELECT count() AS n FROM system.tables WHERE database = 'chant_receipts' AND name = 'receipts'");
    if (Number(t?.n ?? 0) > 0) await clickhouseQuery(admin, `ALTER TABLE chant_receipts.receipts DELETE WHERE startsWith(address, '${NAME}/')`, { settings: { mutations_sync: "1" } });
  };

  beforeAll(async () => {
    if (givenClickHouse) admin = { url: givenClickHouse };
    else {
      server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-receipts" });
      admin = server.endpoint;
    }
    await q(`DROP DATABASE IF EXISTS ${NAME} SYNC`);
    await forget();
    await q(`CREATE DATABASE ${NAME}`);
    await q(`CREATE TABLE ${NAME}.log (batch String, at DateTime64(3) DEFAULT now64(3)) ENGINE = MergeTree ORDER BY at`);
    await q(`CREATE TABLE ${NAME}.stop (x UInt8) ENGINE = MergeTree ORDER BY x`);
    await q(`INSERT INTO ${NAME}.stop VALUES (1)`);
    p = await project(
      {
        "chant.config.ts": config({ dialect: "clickhouse", profiles: { [ENV]: { url: admin.url, databases: [NAME] } } }),
        "ops/fill.op.ts": opFile(`SELECT throwIf(count() > 0, 'stopped') FROM ${NAME}.stop`, (b) => `INSERT INTO ${NAME}.log (batch) VALUES ('${b}')`),
      },
      {},
    );
  }, 600_000);

  afterAll(async () => {
    if (admin) {
      await q(`DROP DATABASE IF EXISTS ${NAME} SYNC`).catch(() => undefined);
      await forget().catch(() => undefined);
    }
    await server?.stop();
    if (p) rmSync(p.dir, { recursive: true, force: true });
  });

  test("a failed run keeps the finished batch's receipt; the rerun skips it", async () => {
    await failThenResume(p, {
      log: async () => (await q<{ batch: string }>(`SELECT batch FROM ${NAME}.log ORDER BY at, batch`)).map((r) => r.batch),
      receipts: async () =>
        (await q<{ address: string }>(`SELECT DISTINCT address FROM chant_receipts.receipts WHERE startsWith(address, '${NAME}/') ORDER BY address`)).map((r) => r.address),
      unstop: async () => {
        await q(`TRUNCATE TABLE ${NAME}.stop`);
      },
    });
    // The receipts database is chant's: its comment carries the receipts key.
    const [db] = await q<{ comment: string }>("SELECT comment FROM system.databases WHERE name = 'chant_receipts'");
    expect(db?.comment).toContain("receipts=effects");
  }, 600_000);
});

// ── Postgres ────────────────────────────────────────────────────────────────

describe.skipIf(!givenPostgres && !docker)("effect() batches on Postgres keep their receipts in chant_receipts.receipts (#3657)", () => {
  let server: TestPostgres | undefined;
  let endpoint: PostgresEndpoint;
  let admin: PostgresClient;
  let p: Awaited<ReturnType<typeof project>>;
  /** Whether chant_receipts was there before the test: the test drops it afterwards only when it made it. */
  let hadReceiptsSchema = true;
  const q = <T = Record<string, unknown>>(sql: string) => admin.query<T>(sql);
  const forget = async () => {
    const [t] = await q<{ present: boolean }>("SELECT pg_catalog.to_regclass('chant_receipts.receipts') IS NOT NULL AS present");
    if (t?.present) await q(`DELETE FROM chant_receipts.receipts WHERE starts_with(address, '${NAME}/')`);
  };

  beforeAll(async () => {
    if (givenPostgres) endpoint = { url: givenPostgres, password: process.env.CHANT_SQL_RECEIPTS_POSTGRES_PASSWORD };
    else {
      server = await startTestPostgres();
      endpoint = server.endpoint();
    }
    admin = await connectPostgres(endpoint);
    const [s] = await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname = 'chant_receipts'");
    hadReceiptsSchema = (s?.n ?? 0) > 0;
    await q(`DROP SCHEMA IF EXISTS ${NAME} CASCADE`);
    await forget();
    await q(`CREATE SCHEMA ${NAME}`);
    await q(`CREATE TABLE ${NAME}.log (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, batch text NOT NULL)`);
    await q(`CREATE TABLE ${NAME}.stop (x int)`);
    await q(`INSERT INTO ${NAME}.stop VALUES (1)`);
    p = await project(
      {
        "chant.config.ts": config({
          dialect: "postgres",
          profiles: { [ENV]: { url: endpoint.url, password: { env: "ADMIN_PASSWORD" }, schemas: [NAME] } },
        }),
        "ops/fill.op.ts": opFile(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM ${NAME}.stop) THEN RAISE EXCEPTION 'stopped'; END IF; END $$`,
          (b) => `INSERT INTO ${NAME}.log (batch) VALUES ('${b}')`,
        ),
      },
      { ADMIN_PASSWORD: endpoint.password ?? "" },
    );
  }, 600_000);

  afterAll(async () => {
    if (admin) {
      await q(`DROP SCHEMA IF EXISTS ${NAME} CASCADE`).catch(() => undefined);
      await forget().catch(() => undefined);
      if (!hadReceiptsSchema) await q("DROP SCHEMA IF EXISTS chant_receipts CASCADE").catch(() => undefined);
      await admin.end();
    }
    await server?.stop();
    if (p) rmSync(p.dir, { recursive: true, force: true });
  });

  test("a failed run keeps the finished batch's receipt; the rerun skips it", async () => {
    await failThenResume(p, {
      log: async () => (await q<{ batch: string }>(`SELECT batch FROM ${NAME}.log ORDER BY id`)).map((r) => r.batch),
      receipts: async () =>
        (await q<{ address: string }>(`SELECT address FROM chant_receipts.receipts WHERE starts_with(address, '${NAME}/') ORDER BY address`)).map((r) => r.address),
      unstop: async () => {
        await q(`DELETE FROM ${NAME}.stop`);
      },
    });
    // The schema and the table are chant's: their comments carry the receipts key.
    const [c] = await q<{ schema: string; tbl: string }>(
      "SELECT pg_catalog.obj_description('chant_receipts'::regnamespace, 'pg_namespace') AS schema, pg_catalog.obj_description('chant_receipts.receipts'::regclass, 'pg_class') AS tbl",
    );
    expect(c?.schema).toContain("receipts=effects");
    expect(c?.tbl).toContain("receipts=effects");
  }, 600_000);
});
