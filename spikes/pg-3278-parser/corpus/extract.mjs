/**
 * Spike (#3278): build the coverage corpus from Postgres's regression SQL with
 * libpg_query as the referee. Not run from the repo: libpg-query is not a
 * dependency. corpus/run-corpus.sh copies this file into a scratch directory
 * that has `libpg-query@18.1.5` installed and runs it there:
 *
 *   node extract.mjs <postgres>/src/test/regress/sql corpus.json
 *
 * Each file loses its psql meta-commands (`\...` lines) and COPY data, is
 * split into statements with libpg_query's own scanner, and each statement is
 * parsed. A statement is in the declared subset when its node is one of the
 * statements the dialect declares. For those, the facts the hand-written
 * parser is compared against are recorded (names, columns, references).
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadModule, parseSync, scanSync } from "libpg-query";

await loadModule();
const [dir, out] = process.argv.slice(2);

const COMMENT_TYPES = new Set([
  "OBJECT_TABLE", "OBJECT_COLUMN", "OBJECT_INDEX", "OBJECT_VIEW", "OBJECT_MATVIEW", "OBJECT_SEQUENCE",
  "OBJECT_TYPE", "OBJECT_DOMAIN", "OBJECT_SCHEMA", "OBJECT_EXTENSION", "OBJECT_TABCONSTRAINT", "OBJECT_DOMCONSTRAINT",
]);

const rel = (r) => [r.schemaname, r.relname].filter(Boolean).join(".");
const names = (list) => (list ?? []).map((n) => n.String?.sval).filter(Boolean).join(".");

/** The subset kind of a parsed statement, or undefined. */
function kindOf(stmt) {
  const [type, node] = Object.entries(stmt)[0];
  switch (type) {
    case "CreateSchemaStmt": return (node.schemaElts ?? []).length ? undefined : "schema";
    case "CreateStmt": return "table";
    case "IndexStmt": return "index";
    case "ViewStmt": return "view";
    case "CreateTableAsStmt": return node.objtype === "OBJECT_MATVIEW" ? "matview" : undefined;
    case "CreateSeqStmt": return "sequence";
    case "CreateEnumStmt": return "enum";
    case "CreateDomainStmt": return "domain";
    case "CreateExtensionStmt": return "extension";
    case "CommentStmt": return COMMENT_TYPES.has(node.objtype) ? "comment" : undefined;
    default: return undefined;
  }
}

/** What the hand-written parser must agree with. */
function facts(stmt) {
  const [type, n] = Object.entries(stmt)[0];
  if (type === "CreateStmt") {
    const cols = [];
    const fks = [];
    for (const e of n.tableElts ?? []) {
      if (e.ColumnDef) {
        cols.push(e.ColumnDef.colname);
        for (const c of e.ColumnDef.constraints ?? []) if (c.Constraint.contype === "CONSTR_FOREIGN") fks.push(rel(c.Constraint.pktable));
      }
      if (e.Constraint?.contype === "CONSTR_FOREIGN") fks.push(rel(e.Constraint.pktable));
    }
    return { name: rel(n.relation), columns: cols, fks };
  }
  if (type === "IndexStmt") return { name: n.idxname ?? "", table: rel(n.relation), elements: (n.indexParams ?? []).length };
  if (type === "ViewStmt") return { name: rel(n.view), columns: (n.aliases ?? []).map((a) => a.String.sval) };
  if (type === "CreateTableAsStmt") return { name: rel(n.into.rel), columns: (n.into.colNames ?? []).map((a) => a.String.sval) };
  if (type === "CreateSeqStmt") return { name: rel(n.sequence), options: (n.options ?? []).length };
  if (type === "CreateEnumStmt") return { name: names(n.typeName), labels: (n.vals ?? []).length };
  if (type === "CreateDomainStmt") return { name: names(n.domainname) };
  if (type === "CreateExtensionStmt") return { name: n.extname };
  if (type === "CreateSchemaStmt") return { name: n.schemaname ?? "" };
  if (type === "CommentStmt") return { objtype: n.objtype };
  return {};
}

/** Remove psql meta-commands and COPY ... FROM stdin data, keeping line count. */
function clean(src) {
  const lines = src.split("\n");
  let inCopy = false;
  return lines
    .map((l) => {
      if (inCopy) {
        if (l.startsWith("\\.")) inCopy = false;
        return "";
      }
      if (/^\s*\\/.test(l)) return "";
      if (/^\s*COPY\b.*\bFROM\s+stdin/i.test(l)) inCopy = true;
      return l;
    })
    .join("\n");
}

const SUBSET_START = /^\s*(CREATE\s+(OR\s+REPLACE\s+)?((GLOBAL|LOCAL)\s+)?((TEMP|TEMPORARY|UNLOGGED)\s+)?(RECURSIVE\s+)?(SCHEMA|TABLE|UNIQUE\s+INDEX|INDEX|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|TYPE|DOMAIN|EXTENSION)\b|COMMENT\s+ON\b)/i;

const statements = [];
let files = 0;
let total = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
  files++;
  const src = clean(readFileSync(join(dir, f), "utf8"));
  let tokens;
  try {
    tokens = scanSync(src).tokens;
  } catch {
    continue;
  }
  let start = 0;
  const cuts = [];
  for (const t of tokens) if (t.text === ";" && t.tokenName === "ASCII_59") cuts.push(t.end);
  cuts.push(src.length);
  for (const end of cuts) {
    const sql = src.slice(start, end).replace(/;\s*$/, "").replace(/^(\s|--[^\n]*\n)*/, "");
    start = end;
    if (!sql.trim()) continue;
    total++;
    let ok = true;
    let kind;
    let fact;
    let error;
    try {
      const r = parseSync(sql);
      const stmt = r.stmts?.[0]?.stmt;
      if (!stmt || r.stmts.length !== 1) continue;
      kind = kindOf(stmt);
      if (kind) fact = facts(stmt);
    } catch (e) {
      ok = false;
      error = { message: e.message, cursor: e.sqlDetails?.cursorPosition };
    }
    if (ok && kind) statements.push({ file: f, sql, kind, facts: fact });
    else if (!ok && SUBSET_START.test(sql) && !/:['"A-Za-z_]/.test(sql.replace(/::/g, "")) && /syntax error/.test(error.message)) {
      statements.push({ file: f, sql, kind: "invalid", error });
    }
  }
}
writeFileSync(out, JSON.stringify({ files, statements: total, corpus: statements }, null, 1));
const by = {};
for (const s of statements) by[s.kind] = (by[s.kind] ?? 0) + 1;
console.log(`${files} files, ${total} statements, subset:`, by);
