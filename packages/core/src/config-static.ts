/**
 * chant#2591, chant#2589 — read the `lexicons` a project's config declares
 * without running the config.
 *
 * `chant.config.ts` is project code. Most commands evaluate it (see
 * `./config-sandbox.ts`), but a few only need to know which lexicons it
 * declares by path (#2520) so their messages can name the path instead of a
 * package: `init --force`, `dev onboard`, `import --agents` and `audit`.
 * Those read the config here, statically, and never evaluate it.
 *
 * The reader parses the file and reduces the `lexicons` value with the fold
 * machinery (`./fold/fold.ts`'s {@link fold}), given the file's own top-level
 * `const`s and nothing else. It never imports anything, so an imported
 * binding, a function call or `process.env` is not readable. When the value
 * cannot be read, the result says why and callers treat path lexicons as
 * unknown. They never fall back to evaluating the config.
 *
 * What the config's export looks like follows `selectConfigExport` in
 * `./config-sandbox.ts`: `export default`, else `export const config`, else
 * the module's named exports (`export const lexicons`).
 *
 * `chant.config.json` is data and is simply parsed.
 *
 * {@link readConfigFieldsStatically} reads other top-level fields the same
 * way. `chant workspace check` reads a member's `ownership` and
 * `environments` with it for the ledger checks (#2641).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ts from "typescript";
import { ChantConfigSchema, findProjectConfigPastFragments } from "./config";
import { collectConsts, fold, propName, FoldError } from "./fold/fold";
import type { LexiconDeclaration } from "./lexicon-module";

/** What {@link readLexiconDeclarationsStatically} found. */
export type StaticLexiconRead =
  /** No `chant.config.ts` or `chant.config.json` for the directory. */
  | { status: "no-config" }
  /** The declarations, in order. Empty when the config declares no `lexicons`. */
  | { status: "read"; configPath: string; entries: LexiconDeclaration[] }
  /** The config exists, but its `lexicons` could not be read without running it. */
  | { status: "unknown"; configPath: string; reason: string };

/** Signals a config shape the reader does not follow. The message is the reason reported. */
class Unreadable extends Error {}

/**
 * Find the project config for `startDir` (the walk `loadChantConfigUpward`
 * makes) and read its `lexicons` without evaluating it.
 */
export function readLexiconDeclarationsStatically(startDir: string): StaticLexiconRead {
  const { configPath } = findProjectConfigPastFragments(startDir);
  if (configPath === undefined) return { status: "no-config" };
  try {
    const value = readFields(configPath, ["lexicons"]).lexicons;
    if (value === undefined) return { status: "read", configPath, entries: [] };
    const parsed = ChantConfigSchema.shape.lexicons.safeParse(value);
    if (!parsed.success) {
      return { status: "unknown", configPath, reason: "`lexicons` is not a list of lexicon entries" };
    }
    return { status: "read", configPath, entries: (parsed.data ?? []) as LexiconDeclaration[] };
  } catch (err) {
    return { status: "unknown", configPath, reason: unreadableReason(err) };
  }
}

function unreadableReason(err: unknown): string {
  return err instanceof FoldError
    ? `line ${err.line}: ${err.message}`
    : err instanceof Unreadable
      ? err.message
      : `the file could not be read (${err instanceof Error ? err.message : String(err)})`;
}

/** What {@link readConfigFieldsStatically} found. */
export type StaticFieldsRead =
  /** No `chant.config.ts` or `chant.config.json` in the directory. */
  | { status: "no-config" }
  /** Each asked-for field the config sets, folded to a value. A field it doesn't set is absent. */
  | { status: "read"; configPath: string; fields: Record<string, unknown> }
  /** The config exists, but a field could not be read without running it. */
  | { status: "unknown"; configPath: string; reason: string };

/**
 * Read top-level `fields` of the config in `dir` itself, as
 * `loadChantConfig(dir)` finds it (`chant.config.ts`, else
 * `chant.config.json`), without evaluating it. The values are not checked
 * against the config schema; the caller does that for the fields it reads.
 */
export function readConfigFieldsStatically(dir: string, fields: readonly string[]): StaticFieldsRead {
  const configPath = ["chant.config.ts", "chant.config.json"].map((f) => join(dir, f)).find((f) => existsSync(f));
  if (configPath === undefined) return { status: "no-config" };
  try {
    return { status: "read", configPath, fields: readFields(configPath, fields) };
  } catch (err) {
    return { status: "unknown", configPath, reason: unreadableReason(err) };
  }
}

function readFields(configPath: string, fields: readonly string[]): Record<string, unknown> {
  const values = configPath.endsWith(".json") ? readJsonFields(configPath, fields) : readTsFields(configPath, fields);
  // Absent fields are left out rather than set to undefined.
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
}

/** The directory a read config's relative module paths resolve against. */
export function staticConfigBaseDir(read: { configPath: string }): string {
  return dirname(read.configPath);
}

/**
 * The line a command prints when {@link readLexiconDeclarationsStatically}
 * could not read the config, or `undefined` when it could.
 */
export function unknownPathLexiconsNotice(read: StaticLexiconRead): string | undefined {
  if (read.status !== "unknown") return undefined;
  return (
    `note: could not read the lexicons in ${read.configPath} without running it (${read.reason}). ` +
    "chant does not run it for this command, so any lexicon it declares by path is unknown here and is treated as a package."
  );
}

function readJsonFields(configPath: string, fields: readonly string[]): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Unreadable("the config is not a JSON object");
  }
  return Object.fromEntries(fields.map((f) => [f, (parsed as Record<string, unknown>)[f]]));
}

function readTsFields(configPath: string, fields: readonly string[]): Record<string, unknown> {
  const source = ts.createSourceFile(configPath, readFileSync(configPath, "utf-8"), ts.ScriptTarget.Latest, true);
  const consts = collectConsts(source);

  let defaultExport: ts.Expression | undefined;
  const named = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) throw new Unreadable("`export =` is not read");
      defaultExport = statement.expression;
    } else if (ts.isExportDeclaration(statement)) {
      // `export { x as default }`, `export * from "./other"`: the export's
      // value lives elsewhere, possibly in another module.
      throw new Unreadable("an `export { … }` or `export … from` declaration is not read");
    } else if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
        throw new Unreadable("an exported `let` or `var` is not read");
      }
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) named.set(decl.name.text, decl.initializer);
        else throw new Unreadable("a destructured export is not read");
      }
    } else if (hasExportModifier(statement) && hasDefaultModifier(statement)) {
      throw new Unreadable("the default export is not an object");
    }
  }

  const configExpr = defaultExport ?? named.get("config");
  if (configExpr === undefined) {
    // The module's named exports are the config.
    return Object.fromEntries(
      fields.map((f) => {
        const expr = named.get(f);
        return [f, expr === undefined ? undefined : fold(expr, consts)];
      }),
    );
  }
  const obj = configObject(configExpr, consts, new Set());
  return Object.fromEntries(fields.map((f) => [f, fieldOfObject(obj, f, consts)]));
}

/** The object literal a config export reduces to, following `const` aliases. */
function configObject(
  node: ts.Expression,
  consts: Map<string, ts.Expression>,
  seen: Set<string>,
): ts.ObjectLiteralExpression {
  const inner = unwrap(node);
  if (ts.isObjectLiteralExpression(inner)) return inner;
  if (ts.isIdentifier(inner)) {
    const init = consts.get(inner.text);
    if (init === undefined || seen.has(inner.text)) {
      throw new Unreadable(`the exported config \`${inner.text}\` is not a top-level const of this file`);
    }
    seen.add(inner.text);
    return configObject(init, consts, seen);
  }
  throw new Unreadable("the exported config is not an object literal");
}

/** The value `field` takes in a config object literal, or `undefined` when it sets none. */
function fieldOfObject(obj: ts.ObjectLiteralExpression, field: string, consts: Map<string, ts.Expression>): unknown {
  let value: unknown = undefined;
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const spread = fold(prop.expression, consts);
      if (spread !== null && typeof spread === "object" && Object.prototype.hasOwnProperty.call(spread, field)) {
        value = (spread as Record<string, unknown>)[field];
      }
      continue;
    }
    if (prop.name === undefined) continue;
    const name = propName(prop.name);
    if (name !== field) continue;
    if (ts.isPropertyAssignment(prop)) value = fold(prop.initializer, consts);
    else if (ts.isShorthandPropertyAssignment(prop)) value = fold(prop.name, consts);
    else throw new Unreadable(`\`${field}\` is a method or accessor`);
  }
  return value;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function hasExportModifier(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) ?? false;
}

function hasDefaultModifier(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) ?? false;
}
