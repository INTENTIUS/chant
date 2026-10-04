/**
 * Symbol regions for the intent walk (#3034): `graph --intent <path>#<symbol>`
 * names a function, class, method, type or constant instead of a line range,
 * because a line range means something else once the file is edited.
 *
 * A resolver turns a symbol into its current lines in the tree read, and the
 * walk follows those lines through history as it follows any line range
 * (`git log -L`). Resolvers are chosen by file extension. Core ships one for
 * TypeScript and JavaScript, parsed with the TypeScript compiler chant already
 * depends on. A lexicon can contribute more through its plugin's
 * `symbolResolvers()` (#3313), which the intent walk loads for a file in a
 * member that configures the lexicon (`lexicon-symbols.ts`); core's resolver
 * stays the one for `.ts` and `.js`. A file with no resolver is refused with
 * `intent-symbol-unsupported`, and a line range still works for it.
 *
 * A symbol is a name, or a dotted path through classes, namespaces,
 * interfaces, enums and object literals bound to a constant, such as
 * `createApp` or `Server.listen`. A bare name is looked up among the
 * file's top-level declarations first, then among every nested one; when it
 * matches more than one declaration it is refused as ambiguous, with the
 * qualified names that would pick one. The lines run from the declaration's
 * doc comment, when it has one, to its last line.
 */

import * as ts from "typescript";
import type { LineRange } from "./intent";

/** One declaration a resolver found. */
export interface SymbolDeclaration {
  /** The dotted path from the file's top level, such as `Server.listen`. */
  qualified: string;
  /** What declares it: function, class, method, property, interface, type, enum, namespace, variable, member. */
  kind: string;
  lines: LineRange;
}

export type SymbolResolution =
  | { ok: true; declaration: SymbolDeclaration }
  | { ok: false; reason: "unsupported" | "unknown" | "ambiguous"; message: string; candidates: string[] };

/** A language-aware resolver: every declaration in a file, by qualified name. */
export interface SymbolResolver {
  /** The language it reads, for messages. */
  language: string;
  extensions: readonly string[];
  declarations(path: string, text: string): SymbolDeclaration[];
}

// ── TypeScript and JavaScript ────────────────────────────────────────────────

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function nameText(name: ts.PropertyName | ts.BindingName | ts.ModuleName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

const typescriptResolver: SymbolResolver = {
  language: "TypeScript and JavaScript",
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  declarations(path, text) {
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
    const out: SymbolDeclaration[] = [];
    const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    // The span: from the doc comment (or the statement holding a lone variable) to the node's end.
    const push = (qualified: string, kind: string, node: ts.Node) => {
      out.push({ qualified, kind, lines: { start: lineOf(node.getStart(sf, true)), end: lineOf(node.getEnd()) } });
    };
    const visitMembers = (prefix: string, members: ts.NodeArray<ts.Node>) => {
      for (const m of members) {
        const name = nameText((m as ts.NamedDeclaration).name as ts.PropertyName | undefined);
        if (name === undefined) {
          if (ts.isConstructorDeclaration(m)) push(`${prefix}.constructor`, "method", m);
          continue;
        }
        const q = `${prefix}.${name}`;
        if (ts.isMethodDeclaration(m) || ts.isMethodSignature(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) push(q, "method", m);
        else if (ts.isPropertyDeclaration(m) || ts.isPropertySignature(m)) {
          push(q, "property", m);
          if (ts.isPropertyDeclaration(m) && m.initializer) visitValue(q, m.initializer);
        } else if (ts.isEnumMember(m)) push(q, "member", m);
        else if (ts.isPropertyAssignment(m)) {
          push(q, "property", m);
          visitValue(q, m.initializer);
        } else if (ts.isShorthandPropertyAssignment(m)) push(q, "property", m);
      }
    };
    // A class expression or object literal bound to a name has members of its own.
    const visitValue = (prefix: string, value: ts.Expression) => {
      let v = value;
      while (ts.isParenthesizedExpression(v) || ts.isAsExpression(v) || ts.isSatisfiesExpression(v)) v = v.expression;
      if (ts.isClassExpression(v)) visitMembers(prefix, v.members);
      else if (ts.isObjectLiteralExpression(v)) visitMembers(prefix, v.properties);
    };
    const visitStatements = (prefix: string, statements: ts.NodeArray<ts.Statement>) => {
      const q = (name: string) => (prefix ? `${prefix}.${name}` : name);
      for (const s of statements) {
        if (ts.isFunctionDeclaration(s) && s.name) push(q(s.name.text), "function", s);
        else if (ts.isClassDeclaration(s) && s.name) {
          push(q(s.name.text), "class", s);
          visitMembers(q(s.name.text), s.members);
        } else if (ts.isInterfaceDeclaration(s)) {
          push(q(s.name.text), "interface", s);
          visitMembers(q(s.name.text), s.members);
        } else if (ts.isTypeAliasDeclaration(s)) push(q(s.name.text), "type", s);
        else if (ts.isEnumDeclaration(s)) {
          push(q(s.name.text), "enum", s);
          visitMembers(q(s.name.text), s.members);
        } else if (ts.isModuleDeclaration(s)) {
          const name = nameText(s.name);
          if (name === undefined) continue;
          push(q(name), "namespace", s);
          let body = s.body;
          let inner = q(name);
          while (body && ts.isModuleDeclaration(body)) {
            inner = `${inner}.${nameText(body.name)}`;
            body = body.body;
          }
          if (body && ts.isModuleBlock(body)) visitStatements(inner, body.statements);
        } else if (ts.isVariableStatement(s)) {
          const lone = s.declarationList.declarations.length === 1;
          for (const d of s.declarationList.declarations) {
            const name = nameText(d.name);
            if (name === undefined) continue;
            // A lone declaration takes its statement's lines, so `export const x = ...` and its doc comment are in the region.
            push(q(name), "variable", lone ? s : d);
            if (d.initializer) visitValue(q(name), d.initializer);
          }
        } else if (ts.isExportAssignment(s) && !s.isExportEquals) {
          push(q("default"), "variable", s);
          visitValue(q("default"), s.expression);
        }
      }
    };
    visitStatements("", sf.statements);
    return out;
  },
};

/** The resolvers core ships, chosen by the file's extension. */
export const SYMBOL_RESOLVERS: readonly SymbolResolver[] = [typescriptResolver];

/**
 * The resolver for a path, or undefined when none reads its language. Core's
 * resolvers come first, so a lexicon's never takes `.ts` or `.js` from them;
 * among `extra`, the first that names the extension wins.
 */
export function symbolResolverFor(path: string, extra: readonly SymbolResolver[] = []): SymbolResolver | undefined {
  const lower = path.toLowerCase();
  return [...SYMBOL_RESOLVERS, ...extra].find((r) => r.extensions.some((e) => lower.endsWith(e.toLowerCase())));
}

/**
 * Resolve `symbol` in the file `path` holding `text`: its current lines, or
 * why it can't be. `extra` are the resolvers a lexicon contributed for the
 * file's member (#3313).
 */
export function resolveSymbol(path: string, text: string, symbol: string, extra: readonly SymbolResolver[] = []): SymbolResolution {
  const resolver = symbolResolverFor(path, extra);
  if (!resolver) {
    const known = [...new Set([...SYMBOL_RESOLVERS, ...extra].flatMap((r) => r.extensions))].join(", ");
    return { ok: false, reason: "unsupported", message: `${path} has no symbol resolver: symbols resolve in ${known} files. Give a line range, ${path}:<start>-<end>, instead`, candidates: [] };
  }
  const all = resolver.declarations(path, text);
  const exact = all.filter((d) => d.qualified === symbol);
  // A name declared twice at one path, such as an overload or a merged declaration, is one region from the first to the last.
  if (exact.length > 0) {
    const start = Math.min(...exact.map((d) => d.lines.start));
    const end = Math.max(...exact.map((d) => d.lines.end));
    return { ok: true, declaration: { qualified: symbol, kind: exact[0].kind, lines: { start, end } } };
  }
  const nested = [...new Set(all.filter((d) => d.qualified.endsWith(`.${symbol}`)).map((d) => d.qualified))];
  if (nested.length === 1) return resolveSymbol(path, text, nested[0], extra);
  if (nested.length > 1) {
    return { ok: false, reason: "ambiguous", message: `${symbol} names ${nested.length} declarations in ${path}: ${nested.join(", ")}. Give the qualified name`, candidates: nested };
  }
  const top = [...new Set(all.filter((d) => !d.qualified.includes(".")).map((d) => d.qualified))];
  const shown = top.slice(0, 20);
  return {
    ok: false,
    reason: "unknown",
    message: `${path} declares no ${symbol}${top.length > 0 ? `; its top-level declarations are ${shown.join(", ")}${top.length > shown.length ? `, and ${top.length - shown.length} more` : ""}` : ", and no top-level declaration a resolver reads"}`,
    candidates: shown,
  };
}
