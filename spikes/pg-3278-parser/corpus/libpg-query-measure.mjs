/**
 * Spike (#3278): libpg_query through `libpg-query` 18.1.5 and `pgsql-parser`
 * 18.2.8, measured in a scratch directory (not a repo dependency):
 *
 *   node libpg-query-measure.mjs corpus.json
 *
 * - load: module import, loadModule() (the wasm instantiation), first parse
 * - parse time over the corpus
 * - source round trip: deparse(parse(x)) === x, and the weaker
 *   parse(deparse(parse(x))) equal to parse(x) once locations are dropped
 * - comments: whether the tree or the scanner keeps them
 * - interpolations: the example templates with each `${}` as a placeholder
 *   identifier, and an error cursor mapped back to a template part
 */
import { readFileSync } from "node:fs";

const t0 = performance.now();
const lpq = await import("libpg-query");
const t1 = performance.now();
await lpq.loadModule();
const t2 = performance.now();
lpq.parseSync("CREATE TABLE t (id bigint PRIMARY KEY)");
const t3 = performance.now();
const { deparse } = await import("pgsql-parser");
const t4 = performance.now();
console.log(`load: import ${(t1 - t0).toFixed(1)} ms, loadModule (wasm) ${(t2 - t1).toFixed(1)} ms, first parse ${(t3 - t2).toFixed(2)} ms, pgsql-parser import ${(t4 - t3).toFixed(1)} ms`);

const { corpus } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const valid = corpus.filter((s) => s.kind !== "invalid");
let p0 = performance.now();
for (const s of valid) lpq.parseSync(s.sql);
let p1 = performance.now();
console.log(`parseSync over ${valid.length} statements: ${(p1 - p0).toFixed(0)} ms (${((1000 * (p1 - p0)) / valid.length).toFixed(0)} us each)`);
p0 = performance.now();
for (const s of valid) lpq.scanSync(s.sql);
p1 = performance.now();
console.log(`scanSync over the same: ${(p1 - p0).toFixed(0)} ms`);

const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === "location" || k === "stmt_location" || k === "stmt_len" ? undefined : v)));
let exact = 0;
let semantic = 0;
let deparseFail = 0;
const examples = [];
for (const s of valid) {
  const tree = lpq.parseSync(s.sql);
  let out;
  try {
    out = await deparse(tree);
  } catch {
    deparseFail++;
    continue;
  }
  if (out.trim().replace(/;$/, "") === s.sql.trim()) exact++;
  else if (examples.length < 3) examples.push([s.sql.slice(0, 90), out.slice(0, 90)]);
  try {
    if (JSON.stringify(strip(lpq.parseSync(out))) === JSON.stringify(strip(tree))) semantic++;
  } catch {}
}
console.log(`round trip: deparse(parse(x)) === x for ${exact}/${valid.length}; same tree after a deparse for ${semantic}/${valid.length}; deparse threw ${deparseFail}`);
for (const [a, b] of examples) console.log(`  in:  ${a.replace(/\s+/g, " ")}\n  out: ${b.replace(/\s+/g, " ")}`);

const withComments = "CREATE TABLE users (\n  id bigint PRIMARY KEY, -- surrogate\n  /* login */ email text NOT NULL\n)";
const tree = lpq.parseSync(withComments);
console.log(`comments in the tree: ${JSON.stringify(tree).includes("surrogate") || JSON.stringify(tree).includes("login") ? "yes" : "no"}; in scanSync: ${lpq.scanSync(withComments).tokens.filter((t) => /COMMENT/.test(t.tokenName)).map((t) => t.text).join(" | ")}`);
console.log(`deparsed: ${(await deparse(tree)).replace(/\s+/g, " ")}`);
const col = tree.stmts[0].stmt.CreateStmt.tableElts[1].ColumnDef;
console.log(`locations kept: ColumnDef.location=${col.location}, typeName.location=${col.typeName.location}, constraint.location=${col.constraints?.[0]?.Constraint?.location}; no end offsets`);

// Interpolations as placeholders: the orders template from the spike example.
const parts = [
  "\n  CREATE TABLE ",
  ".orders (\n    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n    user_id bigint NOT NULL REFERENCES ",
  " (",
  ") ON DELETE CASCADE,\n    status ",
  " NOT NULL DEFAULT 'placed',\n    amount numeric(12, 2) NOT NULL CHECK (amount >= 0)\n  )",
];
const ph = (i) => `__chant_ref_${i}`;
const joined = parts.map((p, i) => p + (i < parts.length - 1 ? ph(i) : "")).join("");
const t = lpq.parseSync(joined).stmts[0].stmt.CreateStmt;
console.log(`placeholders: table ${t.relation.schemaname}.${t.relation.relname}; fk -> ${t.tableElts[1].ColumnDef.constraints.find((c) => c.Constraint.contype === "CONSTR_FOREIGN").Constraint.pktable.relname}; status type ${JSON.stringify(t.tableElts[2].ColumnDef.typeName.names.map((n) => n.String.sval))}`);
const broken = parts.slice();
broken[4] = broken[4].replace("CHECK", "CHEK");
const bj = broken.map((p, i) => p + (i < broken.length - 1 ? ph(i) : "")).join("");
try {
  lpq.parseSync(bj);
} catch (e) {
  // Map the cursor back: walk the parts, subtracting each placeholder's length.
  let off = e.sqlDetails.cursorPosition;
  let part = 0;
  while (part < broken.length - 1 && off >= broken[part].length + ph(part).length) {
    off -= broken[part].length + ph(part).length;
    part++;
  }
  console.log(`error: ${e.message}, cursor ${e.sqlDetails.cursorPosition} -> part ${part} offset ${off} ('${broken[part].slice(off, off + 4)}')`);
}
try {
  lpq.parseSync("CREATE TABLE t (a int, b int) PARTITION BY RANGE (a) FOR VALUES FROM (1) TO (2)");
} catch (e) {
  console.log(`a grammar the server has, refused as written: ${e.message}`);
}
