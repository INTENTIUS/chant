/**
 * Spike (#3278) checks, from the repo root:
 *
 *   npx tsx spikes/pg-3278-parser/check.ts
 *
 * 1. Source round trip: every template in project/src and project/edge
 *    tokenizes and reassembles byte for byte, `${...}` included.
 * 2. Token-level errors: a syntax error in project/broken/bad.ts maps to a
 *    line and column of the .ts file, as lint and the LSP would report it,
 *    with every interpolation left unknown.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { POSTGRES_LEXICAL, SqlSyntaxError, tokenize, untokenize } from "./project/lexicon/core/tokens";
import { parseStatements } from "./project/lexicon/postgres/parser";
import { unescapeTemplateDelimiters } from "./project/lexicon/core/template";

const TAGS = new Set(["schema", "table", "index", "view", "sequence", "type", "domain", "extension"]);
const root = join(import.meta.dirname, "project");

function templates(file: string) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: Array<{ raw: string; parts: string[]; starts: number[]; exprs: string[]; sf: ts.SourceFile }> = [];
  const visit = (n: ts.Node) => {
    if (ts.isTaggedTemplateExpression(n) && ts.isIdentifier(n.tag) && TAGS.has(n.tag.text)) {
      const t = n.template;
      const lits = ts.isNoSubstitutionTemplateLiteral(t) ? [t] : [t.head, ...t.templateSpans.map((s) => s.literal)];
      out.push({
        raw: t.getText(sf),
        parts: lits.map((l) => (l as ts.TemplateLiteralLikeNode).rawText ?? ""),
        starts: lits.map((l) => l.getStart(sf) + 1),
        exprs: ts.isNoSubstitutionTemplateLiteral(t) ? [] : t.templateSpans.map((s) => s.expression.getText(sf)),
        sf,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

let n = 0;
let identical = 0;
for (const dir of ["src", "edge"]) {
  for (const f of readdirSync(join(root, dir))) {
    for (const t of templates(join(root, dir, f))) {
      n++;
      const back = "`" + untokenize(tokenize(t.parts, POSTGRES_LEXICAL), (i) => "${" + t.exprs[i] + "}") + "`";
      if (back === t.raw) identical++;
      else console.log(`round trip differs in ${f}`);
    }
  }
}
console.log(`source round trip: ${identical}/${n} templates byte-identical`);

const bad = join(root, "broken", "bad.ts");
for (const t of templates(bad)) {
  try {
    parseStatements(tokenize(t.parts.map(unescapeTemplateDelimiters), POSTGRES_LEXICAL));
    console.log("bad.ts: no error found");
  } catch (e) {
    if (!(e instanceof SqlSyntaxError)) throw e;
    const pos = t.sf.getLineAndCharacterOfPosition(t.starts[e.part]! + e.offset);
    console.log(`bad.ts:${pos.line + 1}:${pos.character + 1}: ${e.message}`);
  }
}
