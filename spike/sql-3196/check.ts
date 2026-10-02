/**
 * Spike (#3196) checks, run with tsx from the repo root:
 *   npx tsx spike/sql-3196/check.ts
 * 1. source round trip: every template's raw text tokenizes and untokenizes byte for byte
 * 2. a parse error maps to a line and column in the .ts file
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { tokenize, untokenize } from "./project/lexicon/tokens";
import { checkTemplates } from "./project/lexicon/locate";

const root = join(import.meta.dirname, "project");
let templates = 0;
let identical = 0;
for (const dir of ["src", "edge", "composite"]) {
  for (const f of readdirSync(join(root, dir))) {
    const file = join(root, dir, f);
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isTaggedTemplateExpression(n) && ts.isIdentifier(n.tag) && ["table", "view"].includes(n.tag.text)) {
        const raw = n.template.getText(sf); // the source, delimiters included
        const t = n.template;
        const parts = ts.isNoSubstitutionTemplateLiteral(t)
          ? [t.rawText!]
          : [t.head.rawText!, ...t.templateSpans.map((s) => s.literal.rawText!)];
        const exprs = ts.isNoSubstitutionTemplateLiteral(t) ? [] : t.templateSpans.map((s) => s.expression.getText(sf));
        const back = "`" + untokenize(tokenize(parts), (i) => "${" + exprs[i] + "}") + "`";
        templates++;
        if (back === raw) identical++;
        else console.log(`round trip differs in ${f}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}
console.log(`source round trip: ${identical}/${templates} templates byte-identical`);
const bad = join(root, "broken", "bad.ts");
console.log("parse error location:", JSON.stringify(checkTemplates(bad, readFileSync(bad, "utf8"))));
