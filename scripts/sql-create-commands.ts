/**
 * The `CREATE` commands each pinned ClickHouse and Postgres server has (#3911),
 * written to `lexicons/sql/src/coverage/<dialect>-commands.json`.
 *
 * The object coverage table (`lexicons/sql/src/coverage/<dialect>.json`)
 * marks every kind of object a server can create as declared, refused with a
 * reason, or out of scope, and a test fails when a pinned server lists a
 * command the table has no row for. This script is where that list comes
 * from, read from the server's own sources at the pinned tag:
 *
 * - Postgres: the SQL command reference, `doc/src/sgml/ref/create_*.sgml`,
 *   one page per command, the command being the page's `<refname>`. Read at
 *   the tag of every pinned major (`lexicons/sql/src/spec/postgres-pin.ts`).
 * - ClickHouse: the parsers, `src/Parsers/ParserCreate*.h` and
 *   `src/Parsers/Access/ParserCreate*.h`: one command per parser, named by
 *   the parser (`ParserCreateRowPolicyQuery` is `CREATE ROW POLICY`), and the
 *   commands `ParserCreateQuery.h` parses by their `getName()`. Read at the
 *   pinned release's tag (`lexicons/sql/src/spec/pin.ts`).
 *
 * Run it after moving a pin, then give each new command a row in the table:
 *
 *   npx tsx scripts/sql-create-commands.ts [postgres|clickhouse ...]
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_PINS } from "../lexicons/sql/src/spec/postgres-pin";
import { CLICKHOUSE_VERSION } from "../lexicons/sql/src/spec/pin";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(repoRoot, "lexicons", "sql", "src", "coverage");

/** The files matching `patterns` in `repo` at `tag`, fetched shallow and sparse; returns the checkout. */
function sparse(repo: string, tag: string, patterns: string[]): string {
  const dir = mkdtempSync(join(process.env.SQL_COMMANDS_WORKDIR ?? tmpdir(), "chant-sql-commands-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
  git("init", "-q");
  git("remote", "add", "origin", repo);
  git("sparse-checkout", "set", "--no-cone", ...patterns);
  git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", `refs/tags/${tag}`);
  git("checkout", "-q", "FETCH_HEAD");
  return dir;
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function postgres(): void {
  const versions: Record<string, { version: string; tag: string; commands: string[] }> = {};
  for (const pin of POSTGRES_PINS) {
    const tag = `REL_${pin.version.replace(".", "_")}`;
    const dir = join(sparse("https://github.com/postgres/postgres", tag, ["/doc/src/sgml/ref/create_*.sgml"]), "doc", "src", "sgml", "ref");
    const commands = readdirSync(dir)
      .filter((f) => /^create_.*\.sgml$/.test(f))
      .map((f) => {
        const m = /<refname>([^<]+)<\/refname>/.exec(readFileSync(join(dir, f), "utf-8"));
        if (!m) throw new Error(`${tag} ${f}: no <refname>`);
        return m[1]!.trim().replace(/\s+/g, " ");
      });
    versions[String(pin.major)] = { version: pin.version, tag, commands: sorted(commands) };
    console.error(`Postgres ${pin.version}: ${commands.length} CREATE commands`);
  }
  write("postgres", {
    source: "doc/src/sgml/ref/create_*.sgml <refname>, at each pinned major's tag",
    majors: versions,
  });
}

/** `RowPolicy` as `ROW POLICY`. */
const words = (camel: string) => camel.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();

function clickhouse(): void {
  const tag = `v${CLICKHOUSE_VERSION}-lts`;
  const root = sparse("https://github.com/ClickHouse/ClickHouse", tag, ["/src/Parsers/ParserCreate*.h", "/src/Parsers/Access/ParserCreate*.h"]);
  const commands: string[] = [];
  for (const sub of ["src/Parsers", "src/Parsers/Access"]) {
    for (const f of readdirSync(join(root, sub)).filter((x) => /^ParserCreate.*\.h$/.test(x))) {
      if (f === "ParserCreateQuery.h") {
        // The table, view, database, dictionary and named collection parsers, by the name each gives itself.
        const text = readFileSync(join(root, sub, f), "utf-8");
        for (const m of text.matchAll(/getName\(\) const override \{ return "(CREATE [A-Z ]+?)(?: query| or ATTACH .*)?"; \}/g)) commands.push(m[1]!.trim());
        continue;
      }
      const m = /^ParserCreate([A-Za-z]+?)(?:Query|Entity)\.h$/.exec(f);
      // `ParserCreateWorkloadEntity` parses both CREATE WORKLOAD and CREATE RESOURCE, which have parsers of their own.
      if (!m || m[1] === "Workload" && f.endsWith("Entity.h")) continue;
      commands.push(`CREATE ${words(m[1]!)}`);
    }
  }
  console.error(`ClickHouse ${CLICKHOUSE_VERSION}: ${sorted(commands).length} CREATE commands`);
  write("clickhouse", {
    source: "src/Parsers/ParserCreate*.h and src/Parsers/Access/ParserCreate*.h, at the pinned release's tag",
    version: CLICKHOUSE_VERSION,
    tag,
    commands: sorted(commands),
  });
}

function write(dialect: string, data: unknown): void {
  writeFileSync(join(outDir, `${dialect}-commands.json`), `${JSON.stringify(data, null, 2)}\n`);
}

const which = process.argv.slice(2);
if (which.length === 0 || which.includes("postgres")) postgres();
if (which.length === 0 || which.includes("clickhouse")) clickhouse();
