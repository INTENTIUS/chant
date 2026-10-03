/**
 * Spike (#3278): the hand-written parser over the corpus extract.mjs built.
 *
 *   npx tsx spikes/pg-3278-parser/corpus/coverage.ts <corpus.json> [--show <kind>] [--fails <n>]
 *
 * For each statement in the declared subset: the tokenizer round-trips it
 * byte for byte, the parser accepts it, and what it parsed agrees with
 * libpg_query's tree (names, column names, foreign key targets, index element
 * counts, enum label counts). For the statements libpg_query rejects with a
 * syntax error, how many the hand-written parser also rejects.
 */
import { readFileSync } from "node:fs";
import { POSTGRES_LEXICAL, tokenize, untokenize } from "../project/lexicon/core/tokens";
import { identValue, parseStatement, type StatementNode } from "../project/lexicon/postgres/parser";
import type { Token } from "../project/lexicon/core/tokens";

const [file, ...flags] = process.argv.slice(2);
const show = flags.includes("--show") ? flags[flags.indexOf("--show") + 1] : undefined;
const { corpus } = JSON.parse(readFileSync(file!, "utf8")) as {
  corpus: Array<{ file: string; sql: string; kind: string; facts?: Record<string, unknown>; error?: { message: string; cursor: number } }>;
};

const nameOf = (tokens: Token[], n: { span: { from: number; to: number } }) =>
  tokens
    .slice(n.span.from, n.span.to)
    .filter((t) => t.kind === "ident" || t.kind === "qident")
    .map(identValue)
    .join(".");

function agree(kind: string, node: StatementNode, tokens: Token[], f: Record<string, unknown>): string | undefined {
  const eq = (what: string, a: unknown, b: unknown) => (JSON.stringify(a) === JSON.stringify(b) ? undefined : `${what}: ${JSON.stringify(a)} vs libpg_query ${JSON.stringify(b)}`);
  switch (node.statement) {
    case "table": {
      const fks = [...node.columns.flatMap((c) => c.constraints), ...node.constraints].filter((c) => c.kind === "FOREIGN KEY").map((c) => nameOf(tokens, c.references!.table));
      return eq("name", nameOf(tokens, node.name), f.name) ?? eq("columns", node.columns.map((c) => c.name), f.columns) ?? eq("fks", fks, f.fks);
    }
    case "index":
      return eq("name", node.name ? nameOf(tokens, node.name) : "", f.name) ?? eq("table", nameOf(tokens, node.table), f.table) ?? eq("elements", node.elements.length, f.elements);
    case "view":
      if ((kind === "matview") !== node.materialized) return "materialized flag";
      return eq("name", nameOf(tokens, node.name), f.name) ?? eq("columns", node.columnNames.map((c) => c.name), f.columns);
    case "sequence":
      return eq("name", nameOf(tokens, node.name), f.name) ?? eq("options", node.options.length, f.options);
    case "enum":
      return eq("name", nameOf(tokens, node.name), f.name) ?? eq("labels", node.labels.length, f.labels);
    case "domain":
    case "extension":
      return eq("name", nameOf(tokens, node.name), f.name);
    case "schema":
      return eq("name", node.name ? nameOf(tokens, node.name) : "", f.name);
    case "comment":
      return undefined;
  }
}

const KIND_OF: Record<string, string> = { table: "table", index: "index", view: "view", matview: "view", sequence: "sequence", enum: "enum", domain: "domain", extension: "extension", schema: "schema", comment: "comment" };

const stats: Record<string, { total: number; lossless: number; accepted: number; agree: number }> = {};
const fails = new Map<string, { n: number; example: string }>();
const disagreements: string[] = [];
let invalid = 0;
let invalidRejected = 0;
const falseAccepts: string[] = [];
const t0 = performance.now();
let parsed = 0;

for (const s of corpus) {
  if (s.kind === "invalid") {
    invalid++;
    try {
      parseStatement(tokenize([s.sql], POSTGRES_LEXICAL));
      falseAccepts.push(`${s.file}: ${s.sql.replace(/\s+/g, " ").slice(0, 140)}  [server: ${s.error!.message}]`);
    } catch {
      invalidRejected++;
    }
    continue;
  }
  const st = (stats[s.kind] ??= { total: 0, lossless: 0, accepted: 0, agree: 0 });
  st.total++;
  let tokens: Token[];
  try {
    tokens = tokenize([s.sql], POSTGRES_LEXICAL);
  } catch (e) {
    const key = `tokenize: ${(e as Error).message}`;
    fails.set(key, { n: (fails.get(key)?.n ?? 0) + 1, example: s.sql.slice(0, 160) });
    continue;
  }
  if (untokenize(tokens, () => "") === s.sql) st.lossless++;
  try {
    const node = parseStatement(tokens);
    parsed++;
    st.accepted++;
    if (KIND_OF[s.kind] !== node.statement) {
      disagreements.push(`${s.kind} parsed as ${node.statement}: ${s.sql.slice(0, 100)}`);
      continue;
    }
    const d = agree(s.kind, node, tokens, s.facts ?? {});
    if (d) disagreements.push(`${s.file} ${s.kind} ${d}: ${s.sql.replace(/\s+/g, " ").slice(0, 120)}`);
    else st.agree++;
  } catch (e) {
    const msg = (e as Error).message.replace(/ at '.*'$/s, "");
    const key = `${s.kind}: ${msg}`;
    const cur = fails.get(key);
    fails.set(key, { n: (cur?.n ?? 0) + 1, example: cur?.example ?? `${s.file}: ${s.sql.replace(/\s+/g, " ").slice(0, 200)}  [${(e as Error).message.slice(-40)}]` });
    if (show === s.kind) console.log(`REJECT ${s.file}: ${(e as Error).message}\n  ${s.sql.replace(/\s+/g, " ").slice(0, 300)}`);
  }
}
const ms = performance.now() - t0;

let T = 0;
let A = 0;
let G = 0;
let L = 0;
console.log("| kind | statements | lossless | accepted | agrees with libpg_query |");
console.log("|---|---|---|---|---|");
for (const [k, v] of Object.entries(stats).sort((a, b) => b[1].total - a[1].total)) {
  T += v.total;
  A += v.accepted;
  G += v.agree;
  L += v.lossless;
  console.log(`| ${k} | ${v.total} | ${v.lossless} | ${v.accepted} (${((100 * v.accepted) / v.total).toFixed(1)}%) | ${v.agree} |`);
}
console.log(`| all | ${T} | ${L} | ${A} (${((100 * A) / T).toFixed(1)}%) | ${G} |`);
console.log(`\nrejects by first error:`);
for (const [k, v] of [...fails.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, Number(flags[flags.indexOf("--fails") + 1]) || 40)) console.log(`${String(v.n).padStart(5)}  ${k}\n        ${v.example}`);
console.log(`\ndisagreements: ${disagreements.length}`);
for (const d of disagreements.slice(0, 30)) console.log(`  ${d}`);
console.log(`\nsyntax errors libpg_query reports in subset-looking statements: ${invalid}; hand-written also rejects ${invalidRejected}`);
for (const f of falseAccepts) console.log(`  accepted: ${f}`);
console.log(`\nparse time: ${ms.toFixed(0)} ms for ${T + invalid} statements (${((1000 * ms) / (T + invalid)).toFixed(0)} us each, tokenize included)`);

// Mutants: single-token syntax errors libpg_query rejects (mutate.mjs).
if (flags.includes("--mutants")) {
  const mutants = JSON.parse(readFileSync(flags[flags.indexOf("--mutants") + 1]!, "utf8")) as Array<{ how: string; kind: string; sql: string; message: string; cursor: number }>;
  const by: Record<string, { n: number; rejected: number; sameToken: number; sameLine: number; ascii: number }> = {};
  const missed: string[] = [];
  for (const m of mutants) {
    const b = (by[m.how] ??= { n: 0, rejected: 0, sameToken: 0, sameLine: 0, ascii: 0 });
    b.n++;
    try {
      parseStatement(tokenize([m.sql], POSTGRES_LEXICAL));
      missed.push(`${m.how} ${m.kind}: ${m.sql.replace(/\s+/g, " ").slice(0, 150)}  [server: ${m.message}]`);
    } catch (e) {
      b.rejected++;
      const off = (e as { offset?: number }).offset;
      // libpg-query 18's cursorPosition is a 0-based offset (bytes in C); compare on ASCII statements only.
      if (/^[\x00-\x7f]*$/.test(m.sql)) {
        b.ascii++;
        if (off !== undefined && off === m.cursor) b.sameToken++;
        if (off !== undefined && m.sql.slice(0, off).split("\n").length === m.sql.slice(0, m.cursor).split("\n").length) b.sameLine++;
      }
    }
  }
  console.log("\n| mutation | mutants libpg_query rejects | hand-written rejects | at libpg_query's offset (ASCII) | on libpg_query's line |");
  console.log("|---|---|---|---|---|");
  for (const [k, v] of Object.entries(by)) console.log(`| ${k} | ${v.n} | ${v.rejected} (${((100 * v.rejected) / v.n).toFixed(1)}%) | ${v.sameToken} of ${v.ascii} (${((100 * v.sameToken) / v.ascii).toFixed(1)}%) | ${v.sameLine} (${((100 * v.sameLine) / v.ascii).toFixed(1)}%) |`);
  const perKind: Record<string, [number, number]> = {};
  for (const m of mutants) (perKind[m.kind] ??= [0, 0])[0]++;
  for (const x of missed) perKind[x.split(" ")[1]!.replace(":", "")]![1]++;
  console.log("by statement kind, [mutants, missed]:", JSON.stringify(perKind));
  const nv = Object.entries(perKind).filter(([k]) => k !== "view" && k !== "matview").reduce((a, [, v]) => [a[0] + v[0], a[1] + v[1]], [0, 0]);
  console.log(`outside view queries: ${nv[0] - nv[1]} of ${nv[0]} rejected (${((100 * (nv[0] - nv[1])) / nv[0]).toFixed(1)}%)`);
  const MISSED = Number(flags[flags.indexOf("--missed") + 1]) || 15;
  for (const x of missed.slice(0, MISSED)) console.log(`  missed: ${x}`);
}
