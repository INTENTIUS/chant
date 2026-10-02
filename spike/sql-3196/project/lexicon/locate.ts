/**
 * Spike (#3196): what a source-level lint rule (and so the LSP) does with a
 * `table`/`view` template. It reads the TypeScript AST, finds each registered
 * tag, parses the raw template parts, and maps a parse error from
 * (part, offset) back to a line and column in the .ts file.
 */

import ts from "typescript";
import { tokenize, SqlSyntaxError } from "./tokens";
import { parseCreate } from "./parser";

export interface TemplateDiagnostic {
  line: number; // 1-based
  column: number; // 1-based
  message: string;
}

function partStarts(node: ts.TaggedTemplateExpression, sf: ts.SourceFile): number[] {
  const t = node.template;
  // A part's text begins one character after its opening delimiter (` or }).
  if (ts.isNoSubstitutionTemplateLiteral(t)) return [t.getStart(sf) + 1];
  return [t.head.getStart(sf) + 1, ...t.templateSpans.map((s) => s.literal.getStart(sf) + 1)];
}

function rawParts(node: ts.TaggedTemplateExpression): string[] {
  const t = node.template;
  if (ts.isNoSubstitutionTemplateLiteral(t)) return [t.rawText ?? t.text];
  return [t.head.rawText ?? t.head.text, ...t.templateSpans.map((s) => s.literal.rawText ?? s.literal.text)];
}

export function checkTemplates(fileName: string, source: string, tags = ["table", "view"]): TemplateDiagnostic[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: TemplateDiagnostic[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isTaggedTemplateExpression(n) && ts.isIdentifier(n.tag) && tags.includes(n.tag.text)) {
      try {
        parseCreate(tokenize(rawParts(n)));
      } catch (err) {
        if (!(err instanceof SqlSyntaxError)) throw err;
        const pos = partStarts(n, sf)[err.part] + err.offset;
        const { line, character } = sf.getLineAndCharacterOfPosition(pos);
        out.push({ line: line + 1, column: character + 1, message: err.message });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
