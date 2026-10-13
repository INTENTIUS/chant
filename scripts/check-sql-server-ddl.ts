/**
 * The DDL each new ClickHouse and Postgres release can write that the sql
 * lexicon's parser does not read (#3872).
 *
 * A clause the parser does not know no longer fails a build: it is kept as
 * written, with a warning. This check is how chant hears about one before a
 * user does. For each dialect it takes the newest release, reads the
 * server's own tests at that tag (ClickHouse's `tests/queries/0_stateless`,
 * Postgres's `src/test/regress/sql`), parses every `CREATE` statement chant
 * declares with chant's parser, and collects:
 *
 * - each clause the parser keeps unread (`unknown` on the parsed statement),
 *   by name;
 * - each statement the parser refuses, by its error with positions left out.
 *
 * The server's tests hold statements that are wrong on purpose, and clauses
 * chant will never read, so the result is compared with a committed
 * baseline (`lexicons/sql/src/<dialect>/testdata/server-ddl-baseline.json`)
 * and only what is new is reported. Advisory: it exits 0 either way, and 1
 * only when it cannot run (network, git). In CI it writes `found` and a
 * Markdown `body` per dialect to `$GITHUB_OUTPUT`, so the weekly workflow
 * (`.github/workflows/sql-server-ddl.yml`) opens or refreshes one issue per
 * release. Whoever triages it teaches the parser the clause, or records it in
 * the baseline with `--write-baseline`.
 *
 *   npx tsx scripts/check-sql-server-ddl.ts [clickhouse|postgres ...] [--write-baseline] [--tag <tag>]
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isTrivia as chTrivia, tokenizeText as chTokens } from "../lexicons/sql/src/clickhouse/tokens";
import { parseCreate } from "../lexicons/sql/src/clickhouse/parser";
import { isAccessStatement, parseAccess } from "../lexicons/sql/src/clickhouse/access";
import { isTrivia as pgTrivia, tokenizeText as pgTokens } from "../lexicons/sql/src/postgres/tokens";
import { parseStatements } from "../lexicons/sql/src/postgres/parser";
import { splitTokens, tokensText } from "../lexicons/sql/src/files/common";
import type { UnknownClause } from "../lexicons/sql/src/core/cursor";
import type { Token } from "../lexicons/sql/src/core/tokens";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

type Dialect = "clickhouse" | "postgres";

interface DialectSpec {
  label: string;
  repo: string;
  /** The directory of the server's own SQL tests, in its repository. */
  testsDir: string;
  newestTag(): string;
  /** The `CREATE` statements chant declares, by what they start with. */
  declares: RegExp;
  tokens(sql: string): Token[];
  isTrivia(t: Token): boolean;
  /** Parse one statement: its unknown clauses, or throw. */
  parse(tokens: Token[]): UnknownClause[];
}

const SPECS: Record<Dialect, DialectSpec> = {
  clickhouse: {
    label: "ClickHouse",
    repo: "https://github.com/ClickHouse/ClickHouse",
    testsDir: "tests/queries/0_stateless",
    newestTag: () => {
      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      const out = execFileSync("curl", ["-fsSL", ...(token ? ["-H", `Authorization: Bearer ${token}`] : []), "https://api.github.com/repos/ClickHouse/ClickHouse/releases/latest"], { encoding: "utf-8" });
      return (JSON.parse(out) as { tag_name: string }).tag_name;
    },
    // Quotas and settings profiles (#3911) are read by the access parser, which keeps no unknown clauses.
    declares: /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|DATABASE|DICTIONARY|FUNCTION|(?:MATERIALIZED\s+)?VIEW|QUOTA|(?:SETTINGS\s+)?PROFILE)\b/i,
    tokens: (sql) => chTokens(sql, 0),
    isTrivia: chTrivia,
    parse: (tokens) => {
      if (isAccessStatement(tokens.map((t) => t.text).join(""))) {
        parseAccess(tokens);
        return [];
      }
      return parseCreate(tokens).unknown ?? [];
    },
  },
  postgres: {
    label: "Postgres",
    repo: "https://github.com/postgres/postgres",
    testsDir: "src/test/regress/sql",
    newestTag: () => {
      const out = execFileSync("git", ["ls-remote", "--tags", "https://github.com/postgres/postgres", "REL_*"], { encoding: "utf-8" });
      const tags = [...out.matchAll(/refs\/tags\/(REL_(\d+)_(\d+))$/gm)].map((m) => ({ tag: m[1]!, major: Number(m[2]), minor: Number(m[3]) }));
      tags.sort((a, b) => a.major - b.major || a.minor - b.minor);
      const newest = tags.at(-1);
      if (!newest) throw new Error("no Postgres release tag found");
      return newest.tag;
    },
    declares: /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:UNLOGGED\s+)?TABLE|(?:UNIQUE\s+)?INDEX|(?:MATERIALIZED\s+)?VIEW|SEQUENCE|DOMAIN|EXTENSION|SCHEMA)\b/i,
    tokens: (sql) => pgTokens(sql, 0),
    isTrivia: pgTrivia,
    parse: (tokens) => parseStatements(tokens).flatMap((n) => ("unknown" in n && n.unknown ? n.unknown : [])),
  },
};

interface Baseline {
  /** The release the baseline was written from. */
  release: string;
  /** Clause names the parser keeps unread, upper case. */
  unknownClauses: string[];
  /** Parse errors, positions left out. */
  failures: string[];
}

interface Finding {
  key: string;
  example: string;
  file: string;
}

interface Result {
  release: string;
  statements: number;
  unknownClauses: Map<string, Finding>;
  failures: Map<string, Finding>;
}

const baselinePath = (d: Dialect) => join(repoRoot, "lexicons", "sql", "src", d, "testdata", "server-ddl-baseline.json");

/** The server's test directory at `tag`, fetched shallow and sparse. */
function fetchTests(spec: DialectSpec, tag: string): string {
  const dir = mkdtempSync(join(process.env.SQL_DDL_WORKDIR ?? tmpdir(), `chant-sql-ddl-${spec.label.toLowerCase()}-`));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
  git("init", "-q");
  git("remote", "add", "origin", spec.repo);
  git("sparse-checkout", "set", "--no-cone", `/${spec.testsDir}/*.sql`);
  git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", `refs/tags/${tag}`);
  git("checkout", "-q", "FETCH_HEAD");
  return join(dir, spec.testsDir);
}

/** An error message without its token positions, so one error in two tests is one finding. */
const signature = (message: string) => message.replace(/\s+\(on template line \d+\)/, "").replace(/\s+/g, " ").trim();

function check(d: Dialect, tag: string): Result {
  const spec = SPECS[d];
  const dir = fetchTests(spec, tag);
  const result: Result = { release: tag, statements: 0, unknownClauses: new Map(), failures: new Map() };
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const file = join(dir, name);
    let tokens: Token[];
    try {
      tokens = spec.tokens(readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    for (const stmt of splitTokens(tokens, spec.isTrivia)) {
      const sql = tokensText(stmt).replace(/^(?:\s*--[^\n]*\n)+/, "").trim();
      // A test's placeholders (`{CLICKHOUSE_DATABASE:Identifier}`) and psql variables are not DDL.
      if (!spec.declares.test(sql) || /\{[A-Za-z_]+:[A-Za-z]+\}|(?<![:\w]):(?!:)'?[a-z_]+|\\gset/.test(sql)) continue;
      result.statements++;
      const example = sql.replace(/\s+/g, " ").slice(0, 240);
      const where = relative(dirname(dir), file);
      try {
        for (const u of spec.parse(spec.tokens(sql))) {
          if (!result.unknownClauses.has(u.clause)) result.unknownClauses.set(u.clause, { key: u.clause, example, file: where });
        }
      } catch (err) {
        const key = signature(err instanceof Error ? err.message : String(err));
        if (!result.failures.has(key)) result.failures.set(key, { key, example, file: where });
      }
    }
  }
  return result;
}

function issueBody(spec: DialectSpec, r: Result, clauses: Finding[], failures: Finding[]): string {
  const show = (f: Finding) => `- \`${f.key}\` (${f.file}): \`${f.example.replace(/`/g, "'")}\``;
  return [
    `${spec.label} ${r.release}'s own tests hold DDL that chant's parser does not read and the baseline does not list (${String(r.statements)} statements read).`,
    "",
    ...(clauses.length > 0 ? ["Clauses kept unread (a build warns on each):", "", ...clauses.map(show), ""] : []),
    ...(failures.length > 0 ? ["Statements the parser refuses:", "", ...failures.slice(0, 50).map(show), ...(failures.length > 50 ? [`- and ${String(failures.length - 50)} more`] : []), ""] : []),
    "For each: teach the parser the clause (`lexicons/sql/src/<dialect>/parser.ts`), or, when chant should leave it unread or the test statement is wrong on purpose, record it with",
    "`npx tsx scripts/check-sql-server-ddl.ts " + (spec.label === "ClickHouse" ? "clickhouse" : "postgres") + " --write-baseline`. Written by `scripts/check-sql-server-ddl.ts` (#3872).",
  ].join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const write = args.includes("--write-baseline");
  const tagAt = args.indexOf("--tag");
  const tagArg = tagAt >= 0 ? args[tagAt + 1] : undefined;
  const dialects = args.filter((a, i) => (a === "clickhouse" || a === "postgres") && (tagAt < 0 || i !== tagAt + 1)) as Dialect[];
  const which: Dialect[] = dialects.length > 0 ? dialects : ["clickhouse", "postgres"];
  let found = false;
  const bodies: string[] = [];
  const titles: string[] = [];
  for (const d of which) {
    const spec = SPECS[d];
    const tag = tagArg ?? spec.newestTag();
    console.error(`${spec.label}: reading ${spec.testsDir} at ${tag}`);
    const r = check(d, tag);
    const path = baselinePath(d);
    if (write) {
      const baseline: Baseline = { release: tag, unknownClauses: [...r.unknownClauses.keys()].sort(), failures: [...r.failures.keys()].sort() };
      writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
      console.error(`${spec.label}: wrote ${relative(repoRoot, path)} (${String(baseline.unknownClauses.length)} clauses, ${String(baseline.failures.length)} errors)`);
      continue;
    }
    const baseline: Baseline = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Baseline) : { release: "", unknownClauses: [], failures: [] };
    const clauses = [...r.unknownClauses.values()].filter((f) => !baseline.unknownClauses.includes(f.key));
    const failures = [...r.failures.values()].filter((f) => !baseline.failures.includes(f.key));
    console.error(`${spec.label} ${tag}: ${String(r.statements)} statements, ${String(clauses.length)} new unread clauses, ${String(failures.length)} new errors`);
    console.log(JSON.stringify({ dialect: d, release: tag, statements: r.statements, newClauses: clauses, newFailures: failures }, null, 2));
    if (clauses.length > 0 || failures.length > 0) {
      found = true;
      titles.push(`sql: ${spec.label} ${tag} has DDL the parser does not read`);
      bodies.push(issueBody(spec, r, clauses, failures));
    }
  }
  if (process.env.GITHUB_OUTPUT && !write) {
    appendFileSync(process.env.GITHUB_OUTPUT, `found=${String(found)}\n`);
    if (found) {
      appendFileSync(process.env.GITHUB_OUTPUT, `title=${titles.join("; ")}\n`);
      appendFileSync(process.env.GITHUB_OUTPUT, `body<<CHANT_EOF\n${bodies.join("\n\n---\n\n")}\nCHANT_EOF\n`);
    }
  }
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
