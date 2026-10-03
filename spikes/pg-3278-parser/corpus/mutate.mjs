/**
 * Spike (#3278): syntax errors for the lint comparison. For each subset
 * statement in corpus.json, two single-token mutations (a dropped token, a
 * misspelt key word), kept when libpg_query rejects the result, with the
 * cursor position it reports. Run beside extract.mjs in the scratch directory:
 *
 *   node mutate.mjs corpus.json mutants.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadModule, parseSync, scanSync } from "libpg-query";

await loadModule();
const [inp, out] = process.argv.slice(2);
const { corpus } = JSON.parse(readFileSync(inp, "utf8"));
let seed = 3278;
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const mutants = [];
for (const s of corpus) {
  if (s.kind === "invalid") continue;
  const toks = scanSync(s.sql).tokens.filter((t) => t.tokenName !== "SQL_COMMENT" && t.tokenName !== "C_COMMENT");
  if (toks.length < 3) continue;
  const tries = [];
  const d = toks[1 + rand(toks.length - 1)];
  tries.push({ how: "drop", sql: s.sql.slice(0, d.start) + s.sql.slice(d.end) });
  const kws = toks.filter((t) => t.keywordKind > 0);
  if (kws.length) {
    const k = kws[rand(kws.length)];
    const at = 1 + rand(k.text.length - 1);
    tries.push({ how: "misspell", sql: s.sql.slice(0, k.start) + k.text.slice(0, at) + k.text.slice(at + 1) + s.sql.slice(k.end) });
  }
  for (const t of tries) {
    try {
      parseSync(t.sql);
    } catch (e) {
      mutants.push({ file: s.file, kind: s.kind, how: t.how, sql: t.sql, message: e.message, cursor: e.sqlDetails?.cursorPosition });
    }
  }
}
writeFileSync(out, JSON.stringify(mutants, null, 1));
console.log(`${mutants.length} mutants libpg_query rejects`);
