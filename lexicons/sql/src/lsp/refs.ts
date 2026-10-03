/**
 * What a `${...}` in a template points at: a table or view declared in the same
 * file or imported from a relative path, or one of its columns. The answer is
 * the hover text, from the source of the declaration.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import * as ts from "typescript";
import { declarations, type Declared } from "./template";

function importedFrom(content: string, local: string, fileName: string): { declared: Declared; file: string } | undefined {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    const named = stmt.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    const el = named.elements.find((e) => e.name.text === local);
    if (!el) continue;
    const base = resolve(dirname(fileName), spec);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), base.replace(/\.js$/, ".ts")]) {
      if (!existsSync(candidate)) continue;
      const found = declarations(readFileSync(candidate, "utf-8"), candidate).find((d) => d.name === (el.propertyName ?? el.name).text);
      if (found) return { declared: found, file: candidate };
    }
  }
  return undefined;
}

const describe = (d: Declared): string => {
  const kind = d.materialized ? "materialized view" : d.tag;
  const lines = [`**${d.name}**: ClickHouse ${kind} \`${d.sqlName}\``];
  if (d.engine) lines.push(`Engine: \`${d.engine}\``);
  if (d.columns.length) lines.push(`Columns: ${d.columns.map((c) => `\`${c.name}${c.type ? ` ${c.type}` : ""}\``).join(", ")}`);
  return lines.join("\n\n");
};

/** Hover text for the expression written in a `${}`, or undefined when it is not a reference this can follow. */
export function resolveReference(content: string, expression: string, fileName: string): string | undefined {
  const m = /^([A-Za-z_$][\w$]*)(?:\.columns(?:\.([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\]))?$/.exec(expression.trim());
  if (!m) return undefined;
  const [, owner, dotted, bracketed] = m;
  const column = dotted ?? bracketed;
  const declared =
    declarations(content, fileName).find((d) => d.name === owner) ?? importedFrom(content, owner!, fileName)?.declared;
  if (!declared) return undefined;
  if (!column) return describe(declared);
  const c = declared.columns.find((x) => x.name === column);
  if (!c) return `**${owner}.columns.${column}**: no column \`${column}\` in ${declared.sqlName}. Columns: ${declared.columns.map((x) => x.name).join(", ")}`;
  return `**${owner}.columns.${column}**: column \`${c.name}\` of ${declared.tag} \`${declared.sqlName}\`${c.type ? `, type \`${c.type}\`` : ""}`;
}
