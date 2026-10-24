/**
 * Replay a migration directory into an empty server and read the catalog
 * (#4400). The workspace kinds for goose, golang-migrate,
 * clickhouse-migrations and Flyway list a directory's migrations without
 * running anything (`packages/core/src/workspace/migration-dirs.ts`); the
 * tables and columns they produce come from here.
 *
 *     chant sql replay <dir> --kind <kind> --env <env> [--dir-field migrationsDir=<sub>] [--check]
 *
 * The replay applies each migration's up statements in the order the kind's
 * reader lists them, then reads the tables, views and columns the server has
 * and writes them as `chant.replay.json` beside the migrations, named by the
 * contract of #3931: `<schema>.<table>` and `<schema>.<table>.<column>` for
 * Postgres, `<database>.<table>` and `<database>.<table>.<column>` for
 * ClickHouse. The file also holds a digest of the files it ran, so the
 * reader knows when a migration changed after it. `--check` replays and
 * compares instead of writing, exiting 1 when the file differs, the way
 * `chant sql types --check` does.
 *
 * What it runs per kind:
 * - goose: the `-- +goose Up` section of each file; `StatementBegin` to
 *   `StatementEnd` is one statement.
 * - golang-migrate and clickhouse-migrations: the whole up file.
 * - Flyway: the SQL files of the locations, versioned in version order and
 *   then repeatable ones, with placeholders substituted. Baseline and undo
 *   files are not run.
 *
 * The server must hold no table, view or column of its own: the replay
 * refuses a server that does, since it cannot tell what the migrations made.
 * It runs the migrations' SQL against the server `--env` binds, so point it
 * at a throwaway server or emulator.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { CommandGroupContext } from "@intentius/chant/cli/command-group";
import { LINK_READERS, type KindReadMigration, type KindReaderInput } from "@intentius/chant/workspace/kind-link-readers";
import { migrationDigest, REPLAY_FILE, replayFiles, type ReplaySnapshot } from "@intentius/chant/workspace/migration-dirs";
import { findFlywayConfig, readFlywayConfig, substitute } from "@intentius/chant/workspace/flyway-layout";
import { workingTree, type WorkspaceTree } from "@intentius/chant/workspace/tree";

export const REPLAY_KINDS = ["goose", "golang-migrate", "clickhouse-migrations", "flyway"] as const;
export type ReplayKind = (typeof REPLAY_KINDS)[number];

const READER = { goose: "goose-dir", "golang-migrate": "golang-migrate-dir", "clickhouse-migrations": "clickhouse-migrations-dir", flyway: "flyway-dir" } as const;

/** One server the replay runs on. */
export interface ReplayDb {
  dialect: "postgres" | "clickhouse";
  run(sql: string): Promise<void>;
  rows(sql: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/**
 * Split SQL text into statements at `;`. Single-quoted strings, quoted
 * identifiers, `--` and `/* *\/` comments and Postgres dollar-quoted bodies
 * hold semicolons without ending the statement. A statement of only
 * comments is dropped.
 */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const flush = (end: number) => {
    const s = text.slice(start, end).trim();
    if (s !== "" && s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim() !== "") out.push(s);
    start = end + 1;
  };
  while (i < text.length) {
    const c = text[i]!;
    const two = text.slice(i, i + 2);
    if (two === "--") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < text.length) {
        if (text[i] === "\\" && c !== '"') i += 2;
        else if (text[i] === c) {
          if (text[i + 1] === c) i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i))?.[0];
      if (tag) {
        const end = text.indexOf(tag, i + tag.length);
        i = end < 0 ? text.length : end + tag.length;
      } else i++;
    } else if (c === ";") {
      flush(i);
      i++;
    } else i++;
  }
  flush(text.length);
  return out;
}

/** goose's Up statements: the lines between `-- +goose Up` and `-- +goose Down`; a StatementBegin to StatementEnd block is one statement. */
export function gooseUpStatements(text: string): string[] {
  const out: string[] = [];
  let section: "none" | "up" | "down" = "none";
  let block: string[] | undefined;
  let plain: string[] = [];
  const annotation = (l: string) => {
    const t = l.trim();
    return t.startsWith("--") && t.includes("+goose") ? t.replace("+goose", "").replace(/^--\s*/, "").trim().toLowerCase() : undefined;
  };
  const flushPlain = () => {
    out.push(...splitStatements(plain.join("\n")));
    plain = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const a = annotation(line);
    if (a === "up") section = "up";
    else if (a === "down") {
      flushPlain();
      section = "down";
    } else if (a === "statementbegin" && section === "up") {
      flushPlain();
      block = [];
    } else if (a === "statementend" && section === "up" && block) {
      const s = block.join("\n").trim();
      if (s !== "") out.push(s);
      block = undefined;
    } else if (section === "up" && a === undefined) (block ?? plain).push(line);
  }
  flushPlain();
  return out;
}

export interface ReplayStep {
  migration: KindReadMigration;
  statements: string[];
}

/** The statements to run, per migration, in order. Throws when a Flyway placeholder has no value. */
export function replaySteps(kind: ReplayKind, tree: WorkspaceTree, dir: string, fields: KindReaderInput["fields"] = null): { steps: ReplayStep[]; files: string[]; dialect: string } {
  const read = LINK_READERS[READER[kind]]({ member: { name: "replay" } as never, dir, fields, tree });
  const migrations = (read.migrations ?? []).filter((m) => m.type === "versioned" || m.type === "repeatable");
  const config = kind === "flyway" ? readFlywayConfig(tree, findFlywayConfig(tree, dir), dir) : undefined;
  const steps = migrations.map((migration) => {
    const text = tree.read(migration.file);
    const statements = kind === "goose" ? gooseUpStatements(text) : splitStatements(config ? substitute(text, migration.file, config) : text);
    return { migration, statements };
  });
  const extra = config?.file !== undefined ? [config.file] : [];
  return { steps, files: replayFiles(tree, read.migrations ?? [], extra), dialect: read.migrations?.[0]?.dialect ?? "postgres" };
}

/** Apply each migration's statements; a failure names the migration file and the statement. */
export async function applySteps(db: ReplayDb, steps: readonly ReplayStep[]): Promise<void> {
  for (const { migration, statements } of steps) {
    for (const [i, sql] of statements.entries()) {
      try {
        await db.run(sql);
      } catch (err) {
        throw new Error(`${migration.file}: statement ${String(i + 1)} failed: ${(err as Error).message}\n${sql.slice(0, 200)}`);
      }
    }
  }
}

const POSTGRES_CATALOG = `
select n.nspname as schema, c.relname as relation, a.attname as col
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where c.relkind in ('r', 'p', 'v', 'm', 'f')
  and n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
order by 1, 2, a.attnum`;

const CLICKHOUSE_CATALOG = `
select t.database as schema, t.name as relation, c.name as col
from system.tables t
left join system.columns c on c.database = t.database and c.table = t.name
where t.database not in ('system', 'INFORMATION_SCHEMA', 'information_schema')
  and t.is_temporary = 0
order by t.database, t.name, c.position`;

/** The tables, views and columns the server has, as workspace output names (#3931). */
export async function readCatalogOutputs(db: ReplayDb): Promise<string[]> {
  const rows = await db.rows(db.dialect === "postgres" ? POSTGRES_CATALOG : CLICKHOUSE_CATALOG);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const rel = `${String(r.schema)}.${String(r.relation)}`;
    if (!seen.has(rel)) {
      seen.add(rel);
      out.push(rel);
    }
    if (r.col !== null && r.col !== undefined) out.push(`${rel}.${String(r.col)}`);
  }
  return out;
}

/** Replay a directory into `db`, which must hold nothing, and return the snapshot to record. */
export async function replayDirectory(db: ReplayDb, kind: ReplayKind, tree: WorkspaceTree, dir: string, fields: KindReaderInput["fields"] = null): Promise<ReplaySnapshot> {
  const before = await readCatalogOutputs(db);
  if (before.length > 0) throw new Error(`the server already has ${before[0]!.split(".").slice(0, 2).join(".")}${before.length > 1 ? ` and ${String(before.length - 1)} more names` : ""}; replay needs a server with no tables or views of its own, so the tables it finds are the migrations' (use a throwaway server or emulator)`);
  const { steps, files, dialect } = replaySteps(kind, tree, dir, fields);
  if (dialect !== db.dialect) throw new Error(`the migrations are ${dialect} and the server is ${db.dialect}; set the member's dialect field or bind the matching server`);
  await applySteps(db, steps);
  return { schema: 1, dialect, digest: migrationDigest((f) => tree.read(f), files), outputs: await readCatalogOutputs(db) };
}

export const renderSnapshot = (s: ReplaySnapshot): string => `${JSON.stringify(s, null, 2)}\n`;

const USAGE = "usage: chant sql replay <dir> --kind goose|golang-migrate|clickhouse-migrations|flyway --env <env> [--migrations-dir <sub>] [--dialect postgres|clickhouse] [--check]";

/** Open the server `--env` binds, of the migrations' dialect. */
async function openBound(dialect: "postgres" | "clickhouse", environment: string): Promise<ReplayDb> {
  if (dialect === "postgres") {
    const { bindPostgres } = await import("./postgres/live/bind");
    const { client } = await bindPostgres({ environment });
    return { dialect, run: async (sql) => void (await client.query(sql)), rows: (sql) => client.query(sql), close: () => client.end() };
  }
  const { bindClickHouse } = await import("./clickhouse/live/bind");
  const { clickhouseQuery } = await import("./clickhouse/http");
  const target = await bindClickHouse({ environment });
  return { dialect, run: async (sql) => void (await clickhouseQuery(target.endpoint, sql)), rows: (sql) => clickhouseQuery(target.endpoint, sql), async close() {} };
}

export async function runReplay(ctx: CommandGroupContext): Promise<number> {
  const args = ctx.rawArgs;
  let kind: string | undefined;
  let env: string | undefined;
  let sub: string | undefined;
  let dialect: string | undefined;
  const check = args.includes("--check");
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--kind") kind = args[++i];
    else if (a === "--env") env = args[++i];
    else if (a === "--migrations-dir") sub = args[++i];
    else if (a === "--dialect") dialect = args[++i];
    else if (a === "--check") continue;
    else if (a.startsWith("--")) {
      console.error(`unknown argument ${a}\n${USAGE}`);
      return 1;
    } else positional.push(a);
  }
  if (positional.length !== 1 || !kind || !(REPLAY_KINDS as readonly string[]).includes(kind) || !env) {
    console.error(USAGE);
    return 1;
  }
  const abs = resolve(process.cwd(), positional[0]!);
  const tree = workingTree(abs);
  const fields = { ...(sub ? { migrationsDir: sub } : {}), ...(dialect ? { dialect } : {}) } as KindReaderInput["fields"];
  const { steps, dialect: found } = replaySteps(kind as ReplayKind, tree, "", fields);
  if (steps.length === 0) {
    console.error(`chant sql replay: ${relative(process.cwd(), abs) || "."} lists no ${kind} migrations`);
    return 1;
  }
  const db = await openBound(found as "postgres" | "clickhouse", env);
  let snapshot: ReplaySnapshot;
  try {
    snapshot = await replayDirectory(db, kind as ReplayKind, tree, "", fields);
  } catch (err) {
    console.error(`chant sql replay: ${(err as Error).message}`);
    return 1;
  } finally {
    await db.close();
  }
  const file = join(abs, REPLAY_FILE);
  const text = renderSnapshot(snapshot);
  const current = (() => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  })();
  if (check) {
    if (current === text) return 0;
    console.error(`chant sql replay --check: ${relative(process.cwd(), file)} ${current === undefined ? "is missing" : "differs from a replay of the migrations"}; run chant sql replay and commit it`);
    return 1;
  }
  writeFileSync(file, text);
  console.log(`recorded ${String(snapshot.outputs.length)} names from ${String(steps.length)} migrations in ${relative(process.cwd(), file)}`);
  return 0;
}
