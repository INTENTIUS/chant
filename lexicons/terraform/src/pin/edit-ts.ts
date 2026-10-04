/**
 * The pin edit for a root chant generates (#3189): move the pin in the
 * module declaration of its TypeScript source, not in the `.tf` a build
 * writes from it.
 *
 * A module declaration in TypeScript is an object literal with the same
 * arguments the HCL block has: a `source` string, and a `version` string
 * beside a registry source. Any object literal whose `source` is a plain
 * string naming the module counts, whatever function or constructor receives
 * it. The TypeScript compiler parses the file, so a `source:` inside a
 * comment, a template with substitutions, or another string is never a
 * match, and the edit replaces the string literal's content only. Every other
 * byte of the file stays as it was.
 *
 * It needs the TypeScript compiler, so `./index.ts` (the bundled subpath,
 * #3421) does not import it. The rollout takes it as `editTs`.
 */

import * as ts from "typescript";
import type { PinCallResult, PinEditResult, PinRequest } from "./edit";
import { movePin } from "./source";

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

function stringInitializer(obj: ts.ObjectLiteralExpression, key: string): ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | "expression" | undefined {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || propertyName(p.name) !== key) continue;
    const init = p.initializer;
    return ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) ? init : "expression";
  }
  return undefined;
}

/** Write a value as a literal with the same quote the old one used. */
function quote(value: string, old: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral, file: ts.SourceFile): string {
  const q = old.getText(file)[0]!;
  const escaped = value.replace(/\\/g, "\\\\").replaceAll(q, `\\${q}`);
  return `${q}${q === "`" ? escaped.replace(/\$\{/g, "\\${") : escaped}${q}`;
}

/** Move `request.module`'s pin in one TypeScript file. */
export function editPinsInTs(text: string, file: string, request: PinRequest): PinEditResult {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const calls: PinCallResult[] = [];
  const splices: Array<{ start: number; end: number; text: string }> = [];

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const source = stringInitializer(node, "source");
      const version = stringInitializer(node, "version");
      if (source && source !== "expression") {
        const call = `line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
        const move = movePin(source.text, version && version !== "expression" ? version.text : undefined, request);
        if (move) {
          if (version === "expression") {
            calls.push({ outcome: "refused", reason: "version is an expression, not a string literal", file, call });
          } else if (move.outcome === "moved") {
            if (move.source !== source.text) splices.push({ start: source.getStart(sf), end: source.getEnd(), text: quote(move.source, source, sf) });
            if (version && move.version !== undefined && move.version !== version.text) splices.push({ start: version.getStart(sf), end: version.getEnd(), text: quote(move.version, version, sf) });
            calls.push({ ...move, file, call });
          } else {
            calls.push({ ...move, file, call });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  let content = text;
  for (const s of splices.sort((a, b) => b.start - a.start)) content = content.slice(0, s.start) + s.text + content.slice(s.end);
  return { content, calls };
}
