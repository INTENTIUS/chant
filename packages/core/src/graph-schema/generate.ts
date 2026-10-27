/**
 * Generates the graph JSON Schema set from chant core's TypeScript types
 * (#4527; schema home ruled on INTENTIUS/behold#1025 Q5, 2026-10-26).
 *
 * One schema file, ./graph.schema.json, covers both documents a Go engine or
 * a non-chant reader has to write or read without importing chant:
 *
 * - `EngineGraphDocument` (../engine-facts.ts): what `choudoufu live-graph
 *   -json` and `plunge graph --json` print, a `GraphIR` at version 1 with
 *   `meta.engineGraph`, node `facts` and edge `grain`;
 * - `IndexDocument` (../lifecycle/index-document.ts): one index version.
 *
 * Each is a `$defs` entry, so a test validates against
 * `<$id>#/$defs/EngineGraphDocument` or `<$id>#/$defs/IndexDocument`. The
 * fixtures in ./fixtures are written from ./fixtures.ts, which the compiler
 * checks against the same types.
 *
 * The emitter is a small walk over the TypeScript checker, not a dependency:
 * the repo already ships `typescript`, and the types use only what JSON can
 * hold (strings, numbers, booleans, literals, unions, arrays, records and
 * interfaces). Anything else (a function, a class, a generic interface) is
 * refused with its path, so a type that cannot be printed fails generation
 * rather than printing a loose schema.
 *
 * Object schemas are closed (`additionalProperties: false`) unless the type
 * has an index signature, so an engine's test catches a misspelled field.
 * Readers still ignore fields they do not know (GRAPH_IR_VERSION's rule): the
 * closed schema is for writers testing their output against the chant they
 * target.
 *
 * `npm run generate:graph-schema` writes the files; `-- --check` exits 1 when
 * the checked-in files differ, and ./graph-schema.test.ts asserts the same.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { GRAPH_SCHEMA_FIXTURES } from "./fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const coreSrc = resolve(here, "..");

/** The schema's `$id`. */
export const GRAPH_SCHEMA_ID = "https://intentius.io/chant/schemas/graph/v1/graph.schema.json";

/** Where the generated schema is checked in. */
export const GRAPH_SCHEMA_PATH = join(here, "graph.schema.json");

/** Where the generated fixtures are checked in. */
export const GRAPH_SCHEMA_FIXTURE_DIR = join(here, "fixtures");

/** The root types, by the file that declares each. */
const ROOTS: ReadonlyArray<{ file: string; name: string }> = [
  { file: join(coreSrc, "engine-facts.ts"), name: "EngineGraphDocument" },
  { file: join(coreSrc, "lifecycle", "index-document.ts"), name: "IndexDocument" },
];

type Schema = Record<string, unknown>;

/** `{@link X}` and `{@link X text}` as plain text. */
function plainDoc(text: string): string {
  return text
    .replace(/\{@link(?:code|plain)?\s+([^}\s|]+)(?:[\s|]+([^}]*))?\}/g, (_m, name: string, label?: string) => (label?.trim() ? label.trim() : name))
    .replace(/\r\n/g, "\n")
    // Unwrap hard-wrapped lines; keep paragraph breaks and list items.
    .replace(/([^\n])\n(?!\n|\s*[-*] |\s*\d+\. )\s*/g, "$1 ")
    .trim();
}

function docOf(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): string | undefined {
  if (!symbol) return undefined;
  const text = plainDoc(ts.displayPartsToString(symbol.getDocumentationComment(checker)));
  return text === "" ? undefined : text;
}

/** Declared under packages/core/src, so the name is chant's and not the standard library's. */
function isCoreDeclaration(symbol: ts.Symbol | undefined): boolean {
  const decl = symbol?.declarations?.[0];
  if (!decl) return false;
  const file = resolve(decl.getSourceFile().fileName);
  return file.startsWith(coreSrc + sep) && !file.includes(`${sep}node_modules${sep}`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

class Emitter {
  readonly defs = new Map<string, Schema>();
  private readonly defTypes = new Map<string, ts.Type>();

  constructor(private readonly checker: ts.TypeChecker) {}

  /** A `$ref` for a named chant type, else its structure inline. */
  emit(type: ts.Type, path: string): Schema {
    const name = this.defName(type, path);
    if (name === undefined) return this.structure(type, path);
    const seen = this.defTypes.get(name);
    if (seen !== undefined && seen !== type) throw new Error(`graph schema: two types are named ${name} (at ${path})`);
    if (seen === undefined) {
      this.defTypes.set(name, type);
      this.defs.set(name, {}); // placeholder, so a recursive type refers to itself
      const symbol = type.aliasSymbol ?? type.getSymbol();
      const description = docOf(symbol, this.checker);
      this.defs.set(name, { ...(description ? { description } : {}), ...this.structure(type, name) });
    }
    return { $ref: `#/$defs/${name}` };
  }

  private defName(type: ts.Type, path: string): string | undefined {
    if (type.aliasSymbol && !type.aliasTypeArguments?.length && isCoreDeclaration(type.aliasSymbol)) {
      return type.aliasSymbol.getName();
    }
    const symbol = type.getSymbol();
    if (
      symbol &&
      type.flags & ts.TypeFlags.Object &&
      symbol.flags & ts.SymbolFlags.Interface &&
      isCoreDeclaration(symbol)
    ) {
      if ((type as ts.TypeReference).typeArguments?.length) throw new Error(`graph schema: generic interface ${symbol.getName()} at ${path}`);
      return symbol.getName();
    }
    return undefined;
  }

  private structure(type: ts.Type, path: string): Schema {
    const f = type.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
    if (f & ts.TypeFlags.String) return { type: "string" };
    if (f & ts.TypeFlags.Number) return { type: "number" };
    if (f & ts.TypeFlags.Boolean) return { type: "boolean" };
    if (f & ts.TypeFlags.Null) return { type: "null" };
    if (f & ts.TypeFlags.StringLiteral) return { const: (type as ts.StringLiteralType).value };
    if (f & ts.TypeFlags.NumberLiteral) return { const: (type as ts.NumberLiteralType).value };
    if (f & ts.TypeFlags.BooleanLiteral) return { const: (type as unknown as { intrinsicName: string }).intrinsicName === "true" };
    if (type.isUnion()) return this.union(type, path);
    if (this.checker.isTupleType(type)) {
      const args = this.checker.getTypeArguments(type as ts.TypeReference);
      return { type: "array", prefixItems: args.map((a, i) => this.emit(a, `${path}[${i}]`)), items: false };
    }
    if (this.checker.isArrayType(type)) {
      const [item] = this.checker.getTypeArguments(type as ts.TypeReference);
      return { type: "array", items: this.emit(item!, `${path}[]`) };
    }
    if (f & ts.TypeFlags.Object || type.isIntersection()) return this.object(type, path);
    throw new Error(`graph schema: cannot print the type at ${path} (${this.checker.typeToString(type)})`);
  }

  private union(type: ts.UnionType, path: string): Schema {
    let members = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
    const bools = members.filter((t) => t.flags & ts.TypeFlags.BooleanLiteral);
    const hasBoolean = bools.length === 2;
    if (hasBoolean) members = members.filter((t) => !(t.flags & ts.TypeFlags.BooleanLiteral));
    const strings = members.filter((t) => t.flags & ts.TypeFlags.StringLiteral).map((t) => (t as ts.StringLiteralType).value);
    const rest = members.filter((t) => !(t.flags & ts.TypeFlags.StringLiteral));
    const out: Schema[] = [];
    if (strings.length > 0) out.push({ type: "string", enum: [...new Set(strings)].sort() });
    if (hasBoolean) out.push({ type: "boolean" });
    for (const t of rest) out.push(this.emit(t, path));
    if (out.length === 1) return out[0]!;
    if (out.length === 0) throw new Error(`graph schema: an empty union at ${path}`);
    return { anyOf: out.sort((a, b) => (stableJson(a) < stableJson(b) ? -1 : stableJson(a) > stableJson(b) ? 1 : 0)) };
  }

  private object(type: ts.Type, path: string): Schema {
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      throw new Error(`graph schema: a function type at ${path}`);
    }
    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    for (const prop of this.checker.getPropertiesOfType(type)) {
      const name = prop.getName();
      const propPath = `${path}.${name}`;
      const decl = prop.valueDeclaration ?? prop.declarations?.[0];
      if (decl && (ts.isMethodSignature(decl) || ts.isMethodDeclaration(decl))) throw new Error(`graph schema: a method at ${propPath}`);
      // The declared type node keeps an alias (`EdgeGrain`) that the optional
      // property's `T | undefined` loses.
      const typeNode = decl && (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) ? decl.type : undefined;
      const propType = typeNode ? this.checker.getTypeFromTypeNode(typeNode) : this.checker.getTypeOfSymbol(prop);
      const description = docOf(prop, this.checker);
      const schema = this.emit(propType, propPath);
      properties[name] = description ? { description, ...schema } : schema;
      if (!(prop.flags & ts.SymbolFlags.Optional)) required.push(name);
    }
    const index = this.checker.getIndexInfoOfType(type, ts.IndexKind.String);
    const out: Schema = { type: "object" };
    if (Object.keys(properties).length > 0) out.properties = properties;
    if (required.length > 0) out.required = required;
    if (index) {
      if (!(index.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) out.additionalProperties = this.emit(index.type, `${path}[string]`);
    } else {
      out.additionalProperties = false;
    }
    return out;
  }
}

function program(): ts.Program {
  return ts.createProgram(
    ROOTS.map((r) => r.file),
    {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      types: [],
    },
  );
}

/** The schema set, as an object. */
export function generateGraphSchema(): Schema {
  const prog = program();
  const checker = prog.getTypeChecker();
  const emitter = new Emitter(checker);
  const roots: Schema[] = [];
  for (const root of ROOTS) {
    const source = prog.getSourceFile(root.file);
    if (!source) throw new Error(`graph schema: ${root.file} is not in the program`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    const symbol = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === root.name);
    if (!symbol) throw new Error(`graph schema: ${root.file} exports no ${root.name}`);
    roots.push(emitter.emit(checker.getDeclaredTypeOfSymbol(symbol), root.name));
  }
  const defs = Object.fromEntries([...emitter.defs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: GRAPH_SCHEMA_ID,
    title: "chant-graph/v1",
    description:
      "Generated from chant core's TypeScript types (packages/core/src/engine-facts.ts, packages/core/src/lifecycle/index-document.ts) by `npm run generate:graph-schema`; do not edit by hand. Two documents: an engine graph (`#/$defs/EngineGraphDocument`, what `choudoufu live-graph -json` and `plunge graph --json` print, chant#4520) and an index version (`#/$defs/IndexDocument`, behold#1025). Objects are closed so a writer's test catches a misspelled field; a reader ignores fields it does not know.",
    anyOf: roots,
    $defs: defs,
  };
}

/** Every generated file, by path, with its contents. */
export function generatedGraphSchemaFiles(): Map<string, string> {
  const files = new Map<string, string>();
  files.set(GRAPH_SCHEMA_PATH, `${JSON.stringify(generateGraphSchema(), null, 2)}\n`);
  for (const [name, doc] of Object.entries(GRAPH_SCHEMA_FIXTURES)) {
    files.set(join(GRAPH_SCHEMA_FIXTURE_DIR, `${name}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  }
  return files;
}

/** The generated files whose checked-in copy is missing or differs. */
export function staleGraphSchemaFiles(): string[] {
  const stale: string[] = [];
  for (const [path, contents] of generatedGraphSchemaFiles()) {
    if (!existsSync(path) || readFileSync(path, "utf-8") !== contents) stale.push(path);
  }
  return stale;
}
