/**
 * What the typed-column rules (SQLPG005, SQLCH004; chant #3751) share: reading
 * a tag's type argument, comparing it with the name the template declares, and
 * reading the names the generated `sql-types.d.ts` lists.
 *
 * The type argument is `table<"shop.orders">\`CREATE TABLE ...\``. tsc checks
 * that it names an entry of the generated file's `SqlSchema` only when the
 * argument is a constraint, and an unlisted name falls back to unchecked
 * columns, so a mistyped argument is silent without these rules.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as ts from "typescript";

/** The generated file's name, beside the source (`chant sql types`). */
export const SQL_TYPES_FILE = "sql-types.d.ts";

/** A tag's type argument, when it is a string literal: `table<"shop.orders">`. */
export function typeArgumentName(node: ts.TaggedTemplateExpression): { name: string; node: ts.LiteralTypeNode } | undefined {
  const arg = node.typeArguments?.[0];
  if (!arg || node.typeArguments!.length !== 1) return undefined;
  if (!ts.isLiteralTypeNode(arg) || !ts.isStringLiteral(arg.literal)) return undefined;
  return { name: arg.literal.text, node: arg };
}

/** Split a dotted name outside quotes and take the quotes off: `shop."Order Items"` is `shop`, `Order Items`. */
export function splitQualified(name: string): string[] {
  const pieces: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!;
    if (quote) {
      if (c === quote && name[i + 1] === quote) {
        cur += c;
        i++;
      } else if (c === quote) quote = undefined;
      else cur += c;
    } else if (c === '"' || c === "`") quote = c;
    else if (c === ".") {
      pieces.push(cur);
      cur = "";
    } else cur += c;
  }
  pieces.push(cur);
  return pieces;
}

/**
 * Whether the declared name (an empty piece is an interpolation, which lint
 * cannot read) can be the type argument's. Compared from the last piece back.
 * A template that does not qualify its name takes the argument's schema, since
 * the build qualifies it with the schema or database the project sets; one
 * that does qualify it must agree with the argument.
 */
export function nameAgrees(declared: readonly string[], argument: string): boolean {
  const given = splitQualified(argument);
  if (declared.length === 0) return true;
  if (declared.length > given.length) return false;
  for (let i = 1; i <= declared.length; i++) {
    const d = declared[declared.length - i]!;
    if (d === "") continue;
    if (d !== given[given.length - i]) return false;
  }
  return true;
}

/** The text of a declared name for a message; an interpolation is `${...}`. */
export const declaredText = (declared: readonly string[]): string => declared.map((p) => (p === "" ? "${...}" : p)).join(".");

/** A qualified name with quoting taken off, so `"shop"."orders"` and `shop.orders` compare equal. */
export const normalizedName = (name: string): string => splitQualified(name).join("\0");

/** The names (normalized, see {@link normalizedName}) a `declare module "<module>"` block in a generated file augments `SqlSchema` with. */
export function namesInGenerated(content: string, module: string): Set<string> | undefined {
  const source = ts.createSourceFile(SQL_TYPES_FILE, content, ts.ScriptTarget.Latest, true);
  let names: Set<string> | undefined;
  for (const stmt of source.statements) {
    if (!ts.isModuleDeclaration(stmt) || !ts.isStringLiteral(stmt.name) || stmt.name.text !== module) continue;
    if (!stmt.body || !ts.isModuleBlock(stmt.body)) continue;
    for (const inner of stmt.body.statements) {
      if (!ts.isInterfaceDeclaration(inner) || inner.name.text !== "SqlSchema") continue;
      names ??= new Set();
      for (const member of inner.members) {
        const n = member.name;
        if (n && (ts.isStringLiteral(n) || ts.isIdentifier(n))) names.add(normalizedName(n.text));
      }
    }
  }
  return names;
}

/**
 * The generated file nearest above a source file, up to the directory that
 * holds the project's config. `chant sql types` writes it in `sourceDir` (or
 * the project root), so the walk finds it from any file below.
 */
export function findGeneratedFile(filePath: string): string | undefined {
  let dir = dirname(resolve(filePath));
  for (;;) {
    const candidate = join(dir, SQL_TYPES_FILE);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, "chant.config.ts")) || existsSync(join(dir, "chant.config.json"))) return undefined;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** The names the generated file lists for a dialect's module, or undefined when there is no file or it has no such block. */
export function generatedNamesFor(filePath: string, module: string): Set<string> | undefined {
  const found = findGeneratedFile(filePath);
  if (!found) return undefined;
  try {
    return namesInGenerated(readFileSync(found, "utf8"), module);
  } catch {
    return undefined;
  }
}
