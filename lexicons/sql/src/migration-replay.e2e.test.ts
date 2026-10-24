/**
 * Goose and golang-migrate directories replayed into a Postgres emulator
 * (#4400): the replay records the tables and columns, a dbt member links to
 * one of them, `chant workspace check` passes, and a migration that drops the
 * linked column fails it after the next replay. Also the `--check` of the
 * recorded file.
 *
 * Needs Docker; skips cleanly without it. One throwaway `postgres` container,
 * a fresh database for each replay. Not part of the unit suite.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, declaration, REPO, repo } from "../../../packages/core/src/workspace/__fixtures__/contract-repo";
import { workingTree } from "@intentius/chant/workspace/tree";
import { REPLAY_FILE } from "@intentius/chant/workspace/migration-dirs";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "./postgres/testing/server";
import { renderSnapshot, replayDirectory, type ReplayDb, type ReplayKind } from "./migration-replay";

const enabled = await dockerAvailable();
const TIMEOUT = 600_000;
const LEXICON = "@intentius/chant-lexicon-sql";
const VERSION = (JSON.parse(readFileSync(join(REPO, "lexicons", "sql", "package.json"), "utf-8")) as { version: string }).version;
let server: TestPostgres | undefined;
let databases = 0;

beforeAll(async () => {
  if (enabled) server = await startTestPostgres();
}, TIMEOUT);

afterAll(async () => {
  await server?.stop();
  cleanScratch();
});

function chant(cwd: string, ...argv: string[]) {
  return spawnSync(process.execPath, ["--import", pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href, join(REPO, "packages/core/src/cli/main.ts"), ...argv], {
    cwd,
    encoding: "utf-8",
    timeout: TIMEOUT,
    env: { ...process.env, NO_COLOR: "1", TSX_DISABLE_CACHE: "1" },
  });
}

/** An empty database on the emulator, as a {@link ReplayDb}. */
async function emptyDb(): Promise<ReplayDb> {
  const admin = await server!.connect();
  const name = `replay_${String((databases += 1))}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const client = await server!.connect(name);
  return { dialect: "postgres", run: async (sql) => void (await client.query(sql)), rows: (sql) => client.query(sql), close: () => client.end() };
}

const SOURCES = "version: 2\n\nsources:\n  - name: shop\n    schema: public\n    tables:\n      - name: orders\n        columns:\n          - name: id\n          - name: customer_id\n";

const FIXTURES: Record<"goose" | "golang-migrate", { first: Record<string, string>; drop: Record<string, string> }> = {
  goose: {
    first: {
      "db/00001_orders.sql": "-- +goose Up\nCREATE TABLE orders (id bigint PRIMARY KEY, customer_id bigint NOT NULL);\n-- +goose Down\nDROP TABLE orders;\n",
    },
    drop: { "db/00002_drop_customer.sql": "-- +goose Up\nALTER TABLE orders DROP COLUMN customer_id;\n-- +goose Down\nALTER TABLE orders ADD COLUMN customer_id bigint;\n" },
  },
  "golang-migrate": {
    first: {
      "db/1_orders.up.sql": "CREATE TABLE orders (id bigint PRIMARY KEY, customer_id bigint NOT NULL);\n",
      "db/1_orders.down.sql": "DROP TABLE orders;\n",
    },
    drop: { "db/2_drop_customer.up.sql": "ALTER TABLE orders DROP COLUMN customer_id;\n", "db/2_drop_customer.down.sql": "ALTER TABLE orders ADD COLUMN customer_id bigint;\n" },
  },
};

async function workspace(kind: "goose" | "golang-migrate", extra: Record<string, string>): Promise<string> {
  const root = repo({
    "chant.workspace.json": declaration(
      [
        { name: "db", dir: "db", kind },
        { name: "analytics", dir: "analytics", kind: "dbt", fields: { sqlMember: "db" } },
      ],
      { pins: [{ package: LEXICON, version: VERSION }] },
    ),
    "analytics/dbt_project.yml": "name: analytics\nversion: '1.0'\nprofile: analytics\n",
    "analytics/models/staging/sources.yml": SOURCES,
    ".gitignore": "node_modules\n",
    ...FIXTURES[kind].first,
    ...extra,
  });
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}

/** Replay `root/db` into a fresh database and write the snapshot beside the migrations. */
async function record(root: string, kind: ReplayKind): Promise<void> {
  const db = await emptyDb();
  try {
    const snapshot = await replayDirectory(db, kind, workingTree(join(root, "db")), "");
    writeFileSync(join(root, "db", REPLAY_FILE), renderSnapshot(snapshot));
  } finally {
    await db.close();
  }
}

describe.skipIf(!enabled)("migration directories replayed into the emulator (#4400)", () => {
  for (const kind of ["goose", "golang-migrate"] as const) {
    test(
      `${kind}: the replayed columns are outputs a dbt member links to, and a migration that drops a linked column fails workspace check`,
      async () => {
        const ok = await workspace(kind, {});
        await record(ok, kind);
        expect(JSON.parse(readFileSync(join(ok, "db", REPLAY_FILE), "utf-8")).outputs).toEqual(["public.orders", "public.orders.id", "public.orders.customer_id"]);
        const passed = chant(ok, "workspace", "check");
        expect(passed.status, passed.stdout + passed.stderr).toBe(0);

        const dropped = await workspace(kind, FIXTURES[kind].drop);
        await record(dropped, kind);
        const failed = chant(dropped, "workspace", "check");
        expect(failed.status).toBe(1);
        const text = failed.stdout + failed.stderr;
        expect(text).toContain("analytics/models/staging/sources.yml:10");
        expect(text).toContain("WSP093");
        expect(text).toMatch(/link to db output public\.orders\.customer_id .*does not resolve/);
      },
      TIMEOUT,
    );

    test(
      `${kind}: a migration added after the replay leaves the outputs unresolved until the replay runs again`,
      async () => {
        const root = await workspace(kind, {});
        await record(root, kind);
        for (const [path, text] of Object.entries(FIXTURES[kind].drop)) writeFileSync(join(root, path), text);
        const stale = chant(root, "workspace", "check");
        expect(stale.stdout + stale.stderr).toContain("changed since chant.replay.json was recorded");
      },
      TIMEOUT,
    );
  }

  test(
    "a migration that fails stops the replay and names its file",
    async () => {
      const root = await workspace("golang-migrate", { "db/2_bad.up.sql": "ALTER TABLE nowhere ADD COLUMN x int;\n" });
      const db = await emptyDb();
      try {
        await expect(replayDirectory(db, "golang-migrate", workingTree(join(root, "db")), "")).rejects.toThrow(/2_bad\.up\.sql: statement 1 failed/);
      } finally {
        await db.close();
      }
    },
    TIMEOUT,
  );
});
