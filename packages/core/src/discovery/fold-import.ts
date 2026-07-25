import * as ts from "typescript";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join, isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { Declarable } from "../declarable";
import { foldModule } from "../fold/fold";

/**
 * Bridges the static folder ({@link ../fold/fold}, #1026) into discovery
 * (#1022, epic #1019): attempts to fold one source file into real
 * `Declarable` instances with zero execution of the file's own top-level
 * code, so `discover()` can skip `importModule` for it entirely.
 *
 * The folder only reduces expressions to plain values — it has no notion of
 * lexicon resource classes. This module supplies that missing piece: it
 * reads the file's `import` declarations to learn which module each `new
 * Type(...)` constructor call names, resolves and imports *that* module
 * (a trusted lexicon/vendor module, not the file under fold), and
 * constructs the real resource instance from the folded props. Importing
 * the lexicon module is not a regression on "no module execution" — the run
 * path already imports it to get the same class; the only thing skipped
 * here is executing the file's *own* statements.
 */

/** One exported `const` name folded to a real, constructed `Declarable`. */
export type FoldedEntity = [name: string, entity: Declarable];

export type FoldFileResult =
  | { ok: true; entities: FoldedEntity[] }
  | { ok: false; reason: string };

/** True when `node` carries the `export` modifier. */
function hasExportModifier(node: { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * Scan a source file's top-level statements for exported `const X = new
 * Type(...)` resource declarations — the shape {@link foldModule} can fold.
 * Any OTHER export construct (a composite factory call, a re-export, an
 * exported function/class, a non-`new` value, `let`/`var`, …) makes the
 * whole file ineligible for fold: the module must run so that construct is
 * actually evaluated. This mirrors the epic's hybrid design — fallback is
 * per-module, not per-declaration, because an unfoldable export can itself
 * reference or be referenced by a foldable one in ways only running proves
 * safe.
 */
function scanExports(sourceFile: ts.SourceFile): { foldableNames: string[]; unfoldableReason?: string } {
  const foldableNames: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      return { foldableNames, unfoldableReason: "`export default` is not foldable" };
    }
    if (ts.isExportDeclaration(statement)) {
      return { foldableNames, unfoldableReason: "re-export declaration is not foldable" };
    }
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement)) {
      return {
        foldableNames,
        unfoldableReason: `exported function declaration "${statement.name?.text ?? "<anonymous>"}" is not foldable`,
      };
    }
    if (ts.isClassDeclaration(statement) && hasExportModifier(statement)) {
      return {
        foldableNames,
        unfoldableReason: `exported class declaration "${statement.name?.text ?? "<anonymous>"}" is not foldable`,
      };
    }
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;

    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      return { foldableNames, unfoldableReason: "exported `let`/`var` declaration is not foldable" };
    }

    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) {
        return { foldableNames, unfoldableReason: "exported destructured or uninitialized declaration is not foldable" };
      }
      if (!ts.isNewExpression(decl.initializer)) {
        return {
          foldableNames,
          unfoldableReason: `exported "${decl.name.text}" is not a \`new Type(...)\` resource declaration (composite call or plain value)`,
        };
      }
      foldableNames.push(decl.name.text);
    }
  }

  return { foldableNames };
}

/** Where an imported local identifier came from. */
interface ImportBinding {
  specifier: string;
  imported: string;
}

/** Map every top-level `import`-bound local identifier to its source module + export name. */
function collectImports(sourceFile: ts.SourceFile): Map<string, ImportBinding> {
  const imports = new Map<string, ImportBinding>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;

    if (clause.name) {
      imports.set(clause.name.text, { specifier, imported: "default" });
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        imports.set(element.name.text, { specifier, imported });
      }
    }
    // Namespace imports (`import * as ns from "..."`) are not indexed: a
    // `new ns.Type(...)` constructor call folds its callee text as the
    // dotted string "ns.Type", which will simply miss this map — handled
    // uniformly below as an unresolved constructor, falling back to run.
  }

  return imports;
}

/**
 * Resolve an import specifier to an absolute module path, the way the
 * declaring file's own `import` would — without depending on a TS-aware
 * loader being active. Relative/absolute specifiers are probed against real
 * TS/JS candidate files on disk; bare package specifiers are resolved via
 * Node's own CJS algorithm from the declaring file's location (lexicon
 * packages ship built JS, so this needs no `.ts` awareness).
 */
function resolveModulePath(specifier: string, fromFile: string): string {
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    const base = specifier.startsWith(".") ? resolvePath(dirname(fromFile), specifier) : specifier;
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.mjs`,
      join(base, "index.ts"),
      join(base, "index.js"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    // Nothing found on disk under any probed extension — hand back the bare
    // base and let `import()` fail with its own, more specific error.
    return base;
  }

  return createRequire(fromFile).resolve(specifier);
}

/**
 * Attempt to fold one source file with zero execution of its own top-level
 * code. Returns the folded, instantiated entities on success, or a reason
 * to fall back to the run path (`importModule`) on the first construct
 * outside the fold subset.
 */
export async function tryFoldFile(file: string): Promise<FoldFileResult> {
  try {
    const source = await readFile(file, "utf-8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, /* setParentNodes */ true);

    const scan = scanExports(sourceFile);
    if (scan.unfoldableReason) return { ok: false, reason: scan.unfoldableReason };
    if (scan.foldableNames.length === 0) return { ok: false, reason: "no foldable resource exports" };

    const foldResult = foldModule(source, file);
    const imports = collectImports(sourceFile);
    const entities: FoldedEntity[] = [];

    for (const name of scan.foldableNames) {
      const entry = foldResult[name];
      if (!entry) {
        return { ok: false, reason: `"${name}" did not produce a fold result` };
      }
      if (!entry.ok) {
        return { ok: false, reason: `"${name}" is not foldable: ${entry.error}` };
      }

      const typeName = entry.spec.__resource;
      const binding = imports.get(typeName);
      if (!binding) {
        return { ok: false, reason: `constructor "${typeName}" for "${name}" is not a resolvable import` };
      }

      let modulePath: string;
      try {
        modulePath = resolveModulePath(binding.specifier, file);
      } catch (err) {
        return {
          ok: false,
          reason: `could not resolve import "${binding.specifier}" for "${typeName}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      let mod: Record<string, unknown>;
      try {
        mod = await import(pathToFileURL(modulePath).href);
      } catch (err) {
        return {
          ok: false,
          reason: `could not import "${binding.specifier}" to resolve "${typeName}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const Ctor = mod[binding.imported];
      if (typeof Ctor !== "function") {
        return { ok: false, reason: `"${binding.imported}" from "${binding.specifier}" is not a constructor` };
      }

      // The runtime constructor's optional second argument (`attributes` —
      // CFN's DependsOn/Condition/DeletionPolicy/…, see createResource in
      // ../runtime.ts) is only present in `entry.spec` when the source
      // actually passed one (see foldResource in ../fold/fold.ts). Passing
      // `undefined` when it's absent matches the run path's own default
      // (`attributes ?? {}` inside the constructor).
      const ResourceCtor = Ctor as new (
        props: Record<string, unknown>,
        attributes?: Record<string, unknown>,
      ) => Declarable;
      const entity = new ResourceCtor(
        entry.spec.props as Record<string, unknown>,
        entry.spec.attributes as Record<string, unknown> | undefined,
      );
      entities.push([name, entity]);
    }

    return { ok: true, entities };
  } catch (err) {
    // Any unexpected failure degrades to "fall back to run" rather than
    // taking discovery down with it — fold is opt-in, not a new failure mode.
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
