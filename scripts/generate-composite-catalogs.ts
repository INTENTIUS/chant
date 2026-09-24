#!/usr/bin/env tsx
/**
 * Write each lexicon's composite catalog (#2662).
 *
 * `LexiconPlugin.composites()` returns static data so that `chant serve mcp`
 * can answer "what composites do you have for aws?" without loading, let alone
 * calling, a composite. This script reads that data out of the source with the
 * TypeScript checker and writes it to `lexicons/<lex>/src/composites/catalog.ts`,
 * which is committed:
 *
 *   - a composite is an exported value whose type is a `CompositeDefinition`
 *     (it has `compositeName` and a call signature), which is exactly what
 *     `Composite()` and `withDefaults()` return;
 *   - its params are the properties of that call signature's first parameter;
 *   - its bundles are the class names of the members its result type declares,
 *     with nested composite instances flattened;
 *   - its description is the export's JSDoc summary, else its props type's,
 *     else a line naming what it bundles.
 *
 * A lexicon's own `catalog.test.ts` holds the committed file to the runtime
 * exports, so a new composite without a regenerated catalog fails there.
 *
 * Usage: `npm run generate:composite-catalogs [-- <lexicon>...]`
 * Needs the lexicons' generated barrels (`npm run generate`) to resolve types.
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lexiconsDir = join(repoRoot, "lexicons");

interface Param { name: string; type: string; required: boolean; description?: string }
interface Entry { name: string; lexicon: string; description: string; bundles: string[]; params: Param[] }

const MAX_TYPE_TEXT = 120;
const MAX_DESCRIPTION = 160;

/** The modules a lexicon exports its composites from. */
export function compositeEntryModules(lexicon: string): string[] {
  const dir = join(lexiconsDir, lexicon, "src", "composites");
  if (!existsSync(dir)) return [];
  if (existsSync(join(dir, "index.ts"))) return [join(dir, "index.ts")];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.includes(".test.") && f !== "catalog.ts")
    .sort()
    .map((f) => join(dir, f));
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The first sentence of a JSDoc summary, on one line. */
function summary(text: string): string {
  const para = text.split(/\n\s*\n/)[0] ?? "";
  const flat = oneLine(para);
  const m = flat.match(/^(.+?(?<!\be\.g|\bi\.e|\betc|\bvs)[.!?])(\s|$)/);
  const first = m ? m[1] : flat;
  if (first.length <= MAX_DESCRIPTION) return first;
  // A long first sentence usually leads with the point and elaborates after a
  // dash or colon; keep the lead when it says something on its own.
  const lead = first.split(/ — |: /)[0];
  if (lead.length >= 25 && lead.length < first.length) return `${lead}.`;
  const cut = first.slice(0, MAX_DESCRIPTION - 3);
  return `${cut.slice(0, cut.lastIndexOf(" "))}...`;
}

function shorten(text: string): string {
  const flat = oneLine(text);
  return flat.length > MAX_TYPE_TEXT ? `${flat.slice(0, MAX_TYPE_TEXT - 3)}...` : flat;
}

function docOf(symbol: ts.Symbol, checker: ts.TypeChecker): string {
  return ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
}

function deprecatedNote(symbol: ts.Symbol, checker: ts.TypeChecker): string | undefined {
  const tag = symbol.getJsDocTags(checker).find((t) => t.name === "deprecated");
  if (!tag) return undefined;
  const text = ts.displayPartsToString(tag.text).trim();
  if (!text) return "Deprecated.";
  const line = summary(text);
  return `Deprecated: ${/[.!?]$/.test(line) ? line : `${line}.`}`;
}

function isCompositeDefinition(type: ts.Type): boolean {
  return type.getCallSignatures().length > 0 && type.getProperty("compositeName") !== undefined;
}

type ClassKind = "resource" | "property";

/**
 * Whether a symbol is a lexicon class, and which kind: generated and
 * hand-written lexicon classes alike are `const X = createResource(...)` or
 * `createProperty(...)`, possibly re-exported under another name.
 */
function classKind(symbol: ts.Symbol, checker: ts.TypeChecker): ClassKind | undefined {
  let decl = symbol.valueDeclaration;
  for (let hop = 0; hop < 4 && decl; hop++) {
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
    const init = decl.initializer;
    if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
      if (init.expression.text === "createResource") return "resource";
      if (init.expression.text === "createProperty") return "property";
      return undefined;
    }
    if (!ts.isIdentifier(init)) return undefined;
    let next = checker.getSymbolAtLocation(init);
    if (next && next.flags & ts.SymbolFlags.Alias) next = checker.getAliasedSymbol(next);
    decl = next?.valueDeclaration;
  }
  return undefined;
}

/**
 * What a composite constructs: every `new X(...)` reachable from its
 * definition whose `X` is a lexicon class, following the lexicon's own
 * helpers and nested composites (anything the definition references that is
 * declared in the lexicon's hand-written source). Resource classes when there
 * are any; a composite that only builds property objects (a GitHub `Step`)
 * reports those instead. Syntactic, because several lexicons type their
 * generated classes loosely enough (`Declarable & Record<string, string>`)
 * that a composite's result type does not name them.
 */
function bundlesOf(start: ts.Node, checker: ts.TypeChecker, ownSrc: string): string[] {
  const found: Record<ClassKind, Set<string>> = { resource: new Set(), property: new Set() };
  const visited = new Set<ts.Node>();
  const resolve = (node: ts.Node): ts.Symbol | undefined => {
    const sym = checker.getSymbolAtLocation(node);
    if (!sym) return undefined;
    return sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  };
  const isOwn = (decl: ts.Node): boolean => {
    const file = decl.getSourceFile().fileName;
    return file.startsWith(ownSrc) && !file.includes("/generated/") && !file.includes(".test.");
  };
  const walk = (node: ts.Node): void => {
    if (visited.has(node)) return;
    visited.add(node);
    const visit = (n: ts.Node): void => {
      if (ts.isNewExpression(n)) {
        const sym = resolve(n.expression);
        const kind = sym && classKind(sym, checker);
        if (sym && kind) found[kind].add(sym.getName());
      } else if (ts.isIdentifier(n)) {
        const decl = resolve(n)?.valueDeclaration;
        if (decl && isOwn(decl) && (ts.isVariableDeclaration(decl) || ts.isFunctionDeclaration(decl))) walk(decl);
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  };
  walk(start);
  return [...(found.resource.size > 0 ? found.resource : found.property)].sort();
}

function paramsOf(propsType: ts.Type, checker: ts.TypeChecker, at: ts.Node): Param[] {
  const params: Param[] = [];
  for (const prop of checker.getPropertiesOfType(propsType)) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    let typeText: string;
    if (decl && (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) && decl.type) {
      typeText = decl.type.getText();
    } else {
      typeText = checker.typeToString(
        checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(prop, at)),
        undefined,
        ts.TypeFormatFlags.NoTruncation,
      );
    }
    const description = summary(docOf(prop, checker));
    params.push({
      name: prop.getName(),
      type: shorten(typeText),
      required: (prop.flags & ts.SymbolFlags.Optional) === 0,
      ...(description ? { description } : {}),
    });
  }
  return params;
}

/**
 * The summary of the JSDoc block that opens a file, when the file defines a
 * single composite: several lexicons describe a composite there rather than on
 * the export.
 */
function fileHeaderSummary(sf: ts.SourceFile): string {
  if ((sf.text.match(/\bComposite\s*[<(]/g) ?? []).length !== 1) return "";
  const first = sf.statements[0];
  if (!first) return "";
  const ranges = ts.getLeadingCommentRanges(sf.text, first.pos) ?? [];
  const block = ranges.find((r) => sf.text.startsWith("/**", r.pos));
  if (!block) return "";
  const body = sf.text
    .slice(block.pos + 3, block.end - 2)
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .filter((line) => !line.trimStart().startsWith("@"))
    .join("\n");
  return summary(body);
}

/** How an export is defined, when it is another composite under a new name or with defaults. */
function derivation(decl: ts.Declaration | undefined): { kind: "alias" | "defaults"; of: string; keys: string[] } | undefined {
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
  const init = decl.initializer;
  if (ts.isIdentifier(init)) return { kind: "alias", of: init.text, keys: [] };
  if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "withDefaults") {
    const [target, defaults] = init.arguments;
    if (target && ts.isIdentifier(target)) {
      const keys = defaults && ts.isObjectLiteralExpression(defaults)
        ? defaults.properties.map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : "")).filter(Boolean)
        : [];
      return { kind: "defaults", of: target.text, keys };
    }
  }
  return undefined;
}

export function collectCatalog(lexicon: string): Entry[] {
  const modules = compositeEntryModules(lexicon);
  if (modules.length === 0) return [];

  const configPath = join(repoRoot, "tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, repoRoot);
  const program = ts.createProgram({ rootNames: modules, options: { ...parsed.options, noEmit: true } });
  const checker = program.getTypeChecker();

  const ownSrc = join(lexiconsDir, lexicon, "src") + "/";
  const entries = new Map<string, Entry>();
  for (const file of modules) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`composite catalog: ${file} is not in the program`);
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      if (!(symbol.flags & ts.SymbolFlags.Value)) continue;
      const decl = symbol.valueDeclaration;
      if (!decl) continue;
      const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
      if (!isCompositeDefinition(type)) continue;

      const name = exported.getName();
      const sig = type.getCallSignatures()[0];
      const propsParam = sig.getParameters()[0];
      const propsType = propsParam ? checker.getTypeOfSymbolAtLocation(propsParam, decl) : undefined;
      const bundleList = bundlesOf(decl, checker, ownSrc);

      const derived = exported.getName() !== symbol.getName()
        ? { kind: "alias" as const, of: symbol.getName(), keys: [] }
        : derivation(decl);
      const own = summary(docOf(symbol, checker));
      const propsDoc = propsType ? summary(docOf(propsType.aliasSymbol ?? propsType.getSymbol() ?? symbol, checker)) : "";
      let description =
        deprecatedNote(symbol, checker) ??
        (own || undefined) ??
        (derived?.kind === "alias" ? `Another name for ${derived.of}.` : undefined) ??
        (derived?.kind === "defaults"
          ? `${derived.of} with preset defaults${derived.keys.length ? ` for ${derived.keys.join(", ")}` : ""}.`
          : undefined) ??
        (propsDoc && !/^Props? for\b/i.test(propsDoc) ? propsDoc : undefined) ??
        (fileHeaderSummary(decl.getSourceFile()) || undefined) ??
        (bundleList.length ? `Bundles ${bundleList.join(", ")}.` : `The ${name} composite.`);
      if (derived?.kind === "alias" && !description.includes(derived.of)) description = `${description} Another name for ${derived.of}.`;

      entries.set(name, {
        name,
        lexicon,
        description,
        bundles: bundleList,
        params: propsType ? paramsOf(propsType, checker, decl) : [],
      });
    }
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function renderCatalog(entries: Entry[]): string {
  return [
    "// Generated by scripts/generate-composite-catalogs.ts (#2662) from this",
    "// lexicon's composite exports. Do not edit by hand: run",
    "// `npm run generate:composite-catalogs`. catalog.test.ts holds it to the exports.",
    'import type { CompositeEntry } from "@intentius/chant/lexicon";',
    "",
    `export const compositeCatalog: CompositeEntry[] = ${JSON.stringify(entries, null, 2)};`,
    "",
  ].join("\n");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const only = process.argv.slice(2);
  const lexicons = (only.length ? only : readdirSync(lexiconsDir).sort()).filter(
    (l) => compositeEntryModules(l).length > 0,
  );
  for (const lexicon of lexicons) {
    const entries = collectCatalog(lexicon);
    if (entries.length === 0) {
      console.error(`  ${lexicon}: no composites, no catalog written`);
      continue;
    }
    const out = join(lexiconsDir, lexicon, "src", "composites", "catalog.ts");
    writeFileSync(out, renderCatalog(entries));
    console.error(`  ${lexicon}: ${entries.length} composites -> ${out.replace(repoRoot + "/", "")}`);
  }
}
