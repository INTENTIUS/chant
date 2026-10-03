/**
 * Spike (#3278): the generalized tokenizer, given ClickHouse's lexical rules,
 * produces exactly the tokens the shipped ClickHouse tokenizer does, over the
 * ClickHouse corpus fixture and the ClickHouse examples' templates. That is
 * the evidence the tokenizer can move to a shared core without changing
 * ClickHouse.
 *
 *   npx tsx spikes/pg-3278-parser/check-shared-core.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { tokenizeText as chTokenize } from "../../lexicons/sql/src/clickhouse/tokens";
import { CLICKHOUSE_LEXICAL, tokenizeText } from "./project/lexicon/core/tokens";

const root = join(import.meta.dirname, "..", "..", "lexicons", "sql");
const texts: string[] = JSON.parse(readFileSync(join(root, "src/clickhouse/testdata/clickhouse-tests-corpus.json"), "utf8"));

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? (f === "node_modules" ? [] : walk(p)) : p.endsWith(".ts") ? [p] : [];
  });
for (const file of [...walk(join(root, "examples")), ...walk(join(root, "src/composites"))]) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (n: ts.Node) => {
    if (ts.isTaggedTemplateExpression(n)) {
      const t = n.template;
      if (ts.isNoSubstitutionTemplateLiteral(t)) texts.push(t.rawText ?? t.text);
      else texts.push(t.head.rawText ?? "", ...t.templateSpans.map((s) => s.literal.rawText ?? ""));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

let same = 0;
const diffs: string[] = [];
for (const src of texts) {
  let a: string;
  let b: string;
  try {
    a = JSON.stringify(chTokenize(src, 0));
  } catch (e) {
    a = `throws ${(e as Error).message}`;
  }
  try {
    b = JSON.stringify(tokenizeText(src, 0, CLICKHOUSE_LEXICAL));
  } catch (e) {
    b = `throws ${(e as Error).message}`;
  }
  if (a === b) same++;
  else diffs.push(src.slice(0, 120));
}
console.log(`ClickHouse tokens, shipped vs shared core with CLICKHOUSE_LEXICAL: ${same}/${texts.length} texts identical`);
for (const d of diffs.slice(0, 10)) console.log(`  differs: ${d}`);
