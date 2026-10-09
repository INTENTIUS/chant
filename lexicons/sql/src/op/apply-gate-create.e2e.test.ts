/**
 * An approval for a plan that creates an object does not survive an edit to
 * that object (#3652), end to end on both dialects.
 *
 * For each dialect, a project in a temporary directory declares a table that
 * does not exist yet and a gated `ApplyOp`. `chant run` stops at the gate and
 * prints the `chant approve ... --plan <digest>` that answers it; the test
 * approves that digest, adds a column to the declared table, and runs again.
 * The gate refuses with "is approved, but not for this plan" and nothing is
 * created. Approving the new plan then applies the edited table.
 *
 * Before #3652 the plan digest was taken over a diff that listed the table by
 * name only, so the second run applied the edited table under the first
 * approval.
 *
 * Everything is written to the database (ClickHouse) or schema (Postgres)
 * `yodel_3652`.
 *
 * The servers: `CHANT_SQL_GATE_CLICKHOUSE_URL` and
 * `CHANT_SQL_GATE_POSTGRES_URL` (a `postgres://user@host:port/db` URL, with
 * `CHANT_SQL_GATE_POSTGRES_PASSWORD`) name running ones, such as the servers
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
const NAME = "yodel_3652";
const OP = "schema-apply";

const givenClickHouse = process.env.CHANT_SQL_GATE_CLICKHOUSE_URL;
const givenPostgres = process.env.CHANT_SQL_GATE_POSTGRES_URL;
const docker = givenClickHouse && givenPostgres ? false : await dockerAvailable();

interface Run {
  code: number;
  output: string;
}

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

/**
 * A project directory chant can run in: the repository's `node_modules`
 * linked in, so `@intentius/chant` and the sql lexicon resolve, and a git
 * repository, which the gate ledger and snapshots are written to.
 */
async function project(files: Record<string, string>, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "chant-sql-gate-"));
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
  const write = (all: Record<string, string>) => {
    for (const [path, text] of Object.entries(all)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  write({
    "package.json": JSON.stringify({ name: "sql-gate-e2e", private: true, type: "module", scripts: { build: "chant build src --lexicon sql -o dist/schema.json" } }),
    ".gitignore": "node_modules\ndist\n.chant\n",
    ...files,
  });
  const git = (...args: string[]) => exec("git", ["-c", "user.email=e2e@chant.invalid", "-c", "user.name=e2e", ...args], { cwd: dir });
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-qm", "the schema");
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
  return {
    dir,
    chant,
    async edit(path: string, text: string) {
      write({ [path]: text });
      await git("commit", "-qam", `edit ${path}`);
    },
  };
}

/** The `--plan <digest>` the stopped run printed in its approve command. */
function approvedPlan(run: Run): string {
  const m = /chant approve \S+ \S+ .*?--plan (jcs1-sha256:[0-9a-f]{64})/.exec(run.output);
  if (!m) throw new Error(`the run printed no approve command with a plan:\n${run.output}`);
  return m[1];
}

function gateOf(run: Run): string {
  const m = /chant approve \S+ (\S+)/.exec(run.output);
  if (!m) throw new Error(`the run printed no approve command:\n${run.output}`);
  return m[1];
}

const OPS = (target: string) => ({
  "ops/apply.op.ts": `import { ApplyOp } from "@intentius/chant/op";
const { op } = ApplyOp({ name: "${OP}", env: "admin", target: "${target}", gate: { gate: "approve-schema" } });
export default op;
`,
});

const config = (sql: Record<string, unknown>) => `import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  ownership: { stack: "yodel-3652", env: "admin" },
  sql: ${JSON.stringify(sql, null, 2)},
} satisfies ChantConfig;
`;

/**
 * The shared scenario: approve a create, edit the declared object, rerun.
 * `columns` reads the live table's column names.
 */
async function approveEditRerun(
  p: Awaited<ReturnType<typeof project>>,
  edited: { path: string; text: string },
  columns: () => Promise<string[]>,
): Promise<void> {
  const first = await p.chant("run", OP);
  expect(first.output).toMatch(/MISSING \(declared, provider reports not in cloud\):[\s\S]*- events .*\[definition [0-9a-f]{64}\]/);
  const gate = gateOf(first);
  const digest = approvedPlan(first);

  const approve = await p.chant("approve", OP, gate, "--plan", digest);
  expect(approve.code, approve.output).toBe(0);

  await p.edit(edited.path, edited.text);

  const second = await p.chant("run", OP);
  expect(second.output).toContain(`Gate "${gate}" is approved, but not for this plan.`);
  expect(second.output).toContain(`approved: ${digest}`);
  expect(second.output).not.toMatch(/Op "schema-apply" completed/);
  expect(await columns()).toEqual([]);

  // Approving the plan the second run produced applies the edited table.
  const fresh = approvedPlan(second);
  expect(fresh).not.toBe(digest);
  const reapprove = await p.chant("approve", OP, gate, "--plan", fresh);
  expect(reapprove.code, reapprove.output).toBe(0);
  const third = await p.chant("run", OP);
  expect(third.output).toMatch(/Op "schema-apply" completed/);
  expect(await columns()).toContain("note");
}

// ── ClickHouse ──────────────────────────────────────────────────────────────

const CH_SCHEMA = (extra: string) => `import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const db = database\`CREATE DATABASE ${NAME} ENGINE = Atomic COMMENT 'gate binds creates'\`;

export const events = table\`
  CREATE TABLE \${db}.events (
    user_id UInt64,
    ts      DateTime${extra}
  )
  ENGINE = MergeTree
  ORDER BY (user_id, ts)
  COMMENT 'Raw events'\`;
`;

describe.skipIf(!givenClickHouse && !docker)("a gated ApplyOp over ClickHouse refuses an edited create (#3652)", () => {
  let server: ScratchServer | undefined;
  let admin: ClickHouseEndpoint;
  let p: Awaited<ReturnType<typeof project>>;
  const q = (sql: string) => clickhouseQuery(admin, sql);

  beforeAll(async () => {
    if (givenClickHouse) admin = { url: givenClickHouse };
    else {
      server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-gate" });
      admin = server.endpoint;
    }
    await q(`DROP DATABASE IF EXISTS ${NAME} SYNC`);
    p = await project(
      {
        ...OPS("clickhouse"),
        "chant.config.ts": config({ dialect: "clickhouse", profiles: { admin: { url: admin.url, databases: [NAME] } } }),
        "src/schema.ts": CH_SCHEMA(""),
      },
      {},
    );
  }, 600_000);

  afterAll(async () => {
    if (admin) await q(`DROP DATABASE IF EXISTS ${NAME} SYNC`).catch(() => undefined);
    await server?.stop();
    if (p) rmSync(p.dir, { recursive: true, force: true });
  });

  test("approve a create, add a column, rerun: the gate refuses", async () => {
    await approveEditRerun(p, { path: "src/schema.ts", text: CH_SCHEMA(",\n    note    String") }, async () => {
      const rows = await clickhouseQuery<{ name: string }>(admin, `SELECT name FROM system.columns WHERE database = '${NAME}' AND table = 'events' ORDER BY position`);
      return rows.map((r) => r.name);
    });
  }, 600_000);
});

// ── Postgres ────────────────────────────────────────────────────────────────

const PG_SCHEMA = (extra: string) => `import { schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const app = schema\`CREATE SCHEMA ${NAME};
COMMENT ON SCHEMA ${NAME} IS 'gate binds creates'\`;

export const events = table\`
  CREATE TABLE \${app}.events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind text NOT NULL${extra}
  )\`;
`;

describe.skipIf(!givenPostgres && !docker)("a gated ApplyOp over Postgres refuses an edited create (#3652)", () => {
  let server: TestPostgres | undefined;
  let endpoint: PostgresEndpoint;
  let admin: PostgresClient;
  let p: Awaited<ReturnType<typeof project>>;
  const q = (sql: string) => admin.query(sql);

  beforeAll(async () => {
    if (givenPostgres) endpoint = { url: givenPostgres, password: process.env.CHANT_SQL_GATE_POSTGRES_PASSWORD };
    else {
      server = await startTestPostgres();
      endpoint = server.endpoint();
    }
    admin = await connectPostgres(endpoint);
    await q(`DROP SCHEMA IF EXISTS ${NAME} CASCADE`);
    p = await project(
      {
        ...OPS("postgres"),
        "chant.config.ts": config({
          dialect: "postgres",
          profiles: { admin: { url: endpoint.url, password: { env: "ADMIN_PASSWORD" }, schemas: [NAME] } },
        }),
        "src/schema.ts": PG_SCHEMA(""),
      },
      { ADMIN_PASSWORD: endpoint.password ?? "" },
    );
  }, 600_000);

  afterAll(async () => {
    if (admin) {
      await q(`DROP SCHEMA IF EXISTS ${NAME} CASCADE`).catch(() => undefined);
      await admin.end();
    }
    await server?.stop();
    if (p) rmSync(p.dir, { recursive: true, force: true });
  });

  test("approve a create, add a column, rerun: the gate refuses", async () => {
    await approveEditRerun(p, { path: "src/schema.ts", text: PG_SCHEMA(",\n    note text") }, async () => {
      const rows = await admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = '${NAME}' AND table_name = 'events' ORDER BY ordinal_position`,
      );
      return rows.map((r) => r.column_name);
    });
  }, 600_000);
});
