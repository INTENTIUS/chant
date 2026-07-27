import * as ts from "typescript";
import { readFile } from "node:fs/promises";
import { existsSync, statSync, readFileSync, realpathSync } from "node:fs";
import { dirname, basename, join, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isDeclarable, type Declarable } from "../declarable";
import { isCompositeInstance, type CompositeInstance } from "../composite";
import { isAttrRefLike } from "../utils";
import {
  collectConsts,
  foldResource,
  fold,
  FoldError,
  locate,
  type FoldedResource,
  type FoldedValue,
  type FoldedIntrinsic,
  type SymbolicValue,
} from "../fold/fold";
import { importModule } from "./import";
import type { IntrinsicDef } from "../lexicon";
import type { BuildParamValue } from "../build-params";

/**
 * Bridges the static folder ({@link ../fold/fold}, #1026) into discovery
 * (#1022/#1023, epic #1019): attempts to fold one source file into real
 * `Declarable`/`CompositeInstance` instances with zero execution of the
 * file's own top-level code, so `discover()` can skip `importModule` for it
 * entirely.
 *
 * The folder only reduces expressions to plain values — it has no notion of
 * lexicon resource classes or composites. This module supplies that missing
 * piece: it reads the file's `import` declarations to learn which module
 * each `new Type(...)` constructor or bare composite-factory call names,
 * resolves and imports *that* module (a trusted lexicon/vendor module, not
 * the file under fold), and constructs the real resource/composite instance
 * from the folded props. Importing the lexicon module is not a regression on
 * "no module execution" — the run path already imports it to get the same
 * class/function; the only thing skipped here is executing the file's *own*
 * statements.
 *
 * chant #1023 (epic #1019 Phase 5) extends this from leaf resources
 * (`new Type(...)`) to composite factory calls — `SomeComposite({...})`,
 * `propagate(SomeComposite({...}), {...})`, member access on the result
 * (`web.deployment`), and destructuring (`const { a, b } = SomeComposite(...)`
 * or `export const { a, b } = SomeComposite(...)`). A composite factory is a
 * pure function of its props (EVL009/EVL010 guarantee its body only
 * references props, sibling members, and imports), so — exactly like a
 * resource constructor — it's safe to resolve through the file's imports and
 * actually invoke with statically-folded props: no need to pre-verify "is
 * this specifically a registered composite" via a shared registry (which
 * would be unreliable across separately-loaded module instances of
 * `@intentius/chant` anyway) — {@link resolveCallExpression} just resolves,
 * invokes, and lets the RESULT speak. If it satisfies
 * {@link isCompositeInstance} (or, for a plain resource-returning helper,
 * {@link isDeclarable}), it's used. Nested composites and `propagate()`'d
 * shared props need no special-casing: a nested composite is just another
 * member the real factory call already produced (real JS execution inside a
 * trusted module), and `propagate` is just another resolvable imported
 * function that receives a live `CompositeInstance` plus folded shared props
 * and returns it — `expandComposite()` (invoked downstream by
 * `collectEntities`, unchanged) does the recursive expansion and the shared-
 * prop merge exactly as it does for the run path.
 */

/** One exported `const` name folded to a real, constructed `Declarable` or `CompositeInstance`. */
export type FoldedEntity = [name: string, entity: Declarable | CompositeInstance];

export type FoldFileResult =
  | {
      ok: true;
      entities: FoldedEntity[];
      /**
       * chant #1020 — EVERY exported name's fully-resolved value, not just
       * the `Declarable`/`CompositeInstance` ones already in `entities`: a
       * plain value folds too (a string, a number, a plain object), it just
       * contributes nothing to `entities` (see {@link applyResolvedValue}).
       * This is the table another file's cross-file reference resolves
       * against — see `buildExternals` below and the module doc on
       * `planFoldTaint` for why a resource/composite value here MUST be the
       * exact same object every referencing file sees.
       */
      exportedValues: Map<string, unknown>;
    }
  | { ok: false; reason: string };

/**
 * A per-build memo (chant #1020) so a project file imported by several
 * others is folded exactly ONCE — every referrer resolves against the SAME
 * `FoldFileResult`, and therefore the SAME constructed
 * `Declarable`/`CompositeInstance` objects, no matter how many files
 * cross-file-reference it or in what order discovery visits them. Also
 * tracks the current resolution call chain (`stack`) so a genuine reference
 * cycle (fileA needs fileB needs fileA) is DETECTED — rather than an
 * infinite recursion / a promise awaiting itself forever — and reported as a
 * located `FoldError` naming the cycle path.
 *
 * `discover()` creates exactly one session per `{ fold: true }` build and
 * passes it to every top-level `tryFoldFile` call, so its own per-file loop
 * and any cross-file reference reaching into the same file share the
 * identical cache. Callers that don't care about cross-file sharing (unit
 * tests exercising a single file in isolation) can omit it — {@link tryFoldFile}
 * creates a private, single-call session on their behalf.
 */
export interface FoldSession {
  readonly intrinsics: readonly IntrinsicDef[];
  readonly cache: Map<string, Promise<FoldFileResult>>;
  readonly stack: string[];
  /**
   * Per-build memo (chant #1020 hang fix) for {@link importModule} itself —
   * keyed by resolved absolute module path, shared session-wide exactly like
   * {@link cache} above. Cross-file resolution means MANY files in one
   * directory can each independently resolve the SAME constructor/composite-
   * factory import (e.g. every file that constructs an AWS resource imports
   * the same lexicon barrel) — before this, every one of those calls issued
   * its own `await import(path)`, relying entirely on the runtime's own
   * module cache to make the repeats cheap. That assumption holds for a
   * plain `node`/`tsx` process, but NOT for a real dynamic import running
   * inside a vitest worker: `vite-node`'s own SSR module graph can take a
   * real, non-trivial amount of wall-clock time to re-resolve/re-register an
   * already-loaded module on EVERY call, not just the first — harmless at
   * single-digit call counts, but #1020's cross-file resolution can issue
   * several times as many `importModule` calls for the same handful of large
   * lexicon barrels within one `discover()` pass as the pre-#1020 single-file
   * fold did. Memoizing the import itself (not just the path resolution)
   * caps it at exactly one real `import()` per unique path per session,
   * regardless of how many files reference it — this is what actually keeps
   * a session-local retry (e.g. `sandbox-differential.test.ts`'s
   * `vi.resetModules()` + rebuild path, which reruns fold from a cold
   * module cache) from compounding into a multi-minute stall. Purely a cache
   * over an idempotent operation (the same resolved path always yields the
   * same module namespace object) — doesn't change what folds.
   */
  readonly importCache: Map<string, Promise<Record<string, unknown>>>;
  /**
   * Per-build memo (chant #1020 hang fix) for {@link resolveModulePath}'s
   * RELATIVE/absolute-specifier branch only — keyed by
   * `${dirname(fromFile)}\0${specifier}`. See {@link resolveModulePathMemoized}'s
   * doc for the full story, including why bare (package) specifiers are
   * memoized in a separate, process-wide cache instead of this session-
   * scoped one: a relative specifier resolves against PROJECT source, which
   * `chant build --watch` can legitimately change between rebuilds (a new
   * sibling file appearing mid-session), so this cache is intentionally
   * thrown away with the rest of the session at the end of every
   * `discover()` call, unlike the bare-specifier one.
   */
  readonly resolvePathCache: Map<string, string>;
  /**
   * chant #1064 — this build's resolved build-time parameter values (see
   * ../build-params.ts), consulted only by {@link buildExternals}'s one
   * recognized bare-specifier case: a named `params` import resolving to
   * ../params.ts. `undefined` when the build supplied none (no `chant.config.ts`
   * `buildParams` declared, or the caller didn't pass any) — a project that
   * doesn't use build-time parameters pays nothing extra here.
   */
  readonly buildParams?: Readonly<Record<string, BuildParamValue>>;
}

/** Create a fresh, empty {@link FoldSession}. */
export function createFoldSession(
  intrinsics: readonly IntrinsicDef[] = [],
  buildParams?: Readonly<Record<string, BuildParamValue>>,
): FoldSession {
  return { intrinsics, cache: new Map(), stack: [], importCache: new Map(), resolvePathCache: new Map(), buildParams };
}

/**
 * chant #1020 hang fix — memo for {@link resolveModulePath}'s BARE
 * (package) specifier branch, deliberately PROCESS-WIDE rather than
 * session-scoped (contrast {@link FoldSession.resolvePathCache}, used for
 * relative specifiers). A bare specifier like `@intentius/chant-lexicon-aws`
 * resolves via `createRequire(fromFile).resolve(specifier)` — which package
 * a name refers to cannot change mid-process (Node's own module cache
 * already assumes this: nothing invalidates `require.cache`/the dynamic
 * `import()` cache either if `node_modules` changes under a running
 * process), so caching the answer for the process's lifetime, across every
 * `discover()` call/`FoldSession`, is exactly as safe as Node's own
 * assumptions — unlike a relative specifier (a project file `chant build
 * --watch` can legitimately add/remove between rebuilds), never unsafe to
 * reuse.
 *
 * This is what actually fixes the hang, not just reduces it: profiling (a
 * real `sample` during the observed multi-minute stall) traced the cost to
 * `createRequire(fromFile).resolve(specifier)` ITSELF taking upwards of a
 * minute — measured on this exact call, in this exact spot, nowhere else —
 * specifically for the FIRST bare-specifier resolution inside a
 * `FoldSession` created right after `vitest`'s `vi.resetModules()`
 * (`sandbox-differential.test.ts`'s own retry path, pre-existing and
 * unrelated to #1020 — confirmed on `main`, which hits the identical retry
 * for the identical reason and stays fast). Two narrower versions of this
 * fix (session-scoped; then process-wide but still keyed by directory) each
 * still paid that cost at least once more: directory-scoping alone pays it
 * once per NEW directory a corpus entry introduces, and #1020's cross-file
 * resolution reaches a real constructor/composite-factory/intrinsic
 * resolution — hence a real bare-specifier resolve — from strictly more
 * directories across a 98-entry corpus than the pre-#1020 single-file fold
 * ever did. Keyed by specifier ALONE (see {@link resolveModulePathMemoized}'s
 * doc for the directory-independence assumption this relies on), the answer
 * computed the first time ANY directory needed a given package is there for
 * every directory after it, `vi.resetModules()` retry or not — the slow call
 * never has to happen a second time in the same process, for any package.
 */
const bareSpecifierPathCache = new Map<string, string>();

/**
 * Memoized {@link resolveModulePath}. A relative/absolute specifier goes
 * through the session-scoped `resolvePathCache`, keyed by DIRECTORY (not the
 * full file path: `resolveModulePath` only ever consults `dirname(fromFile)`
 * — the relative branch resolves against `dirname(fromFile)`, so the
 * specific FILE within a directory never affects the answer) — a project
 * file can legitimately be added/removed between builds (`chant build
 * --watch`), so this cache is thrown away with the rest of the session.
 *
 * A bare (package) specifier goes through {@link bareSpecifierPathCache}
 * instead, keyed by the specifier ALONE — process-wide, no directory
 * component. `createRequire(fromFile).resolve(specifier)` technically CAN
 * answer differently for the same specifier from two directories (nested
 * `node_modules` with a version override), but `discover()`'s real usage is
 * one `srcDir` per build, whose files overwhelmingly share one effective
 * `node_modules` resolution — the same assumption bundlers (webpack,
 * esbuild, vite) already make for their own module resolution caches. See
 * {@link bareSpecifierPathCache}'s own doc for why process-wide (not just
 * directory-scoped) is what actually fixes the hang: `examples/foo`'s
 * directory and `lexicons/aws/examples/bar`'s directory both need
 * `@intentius/chant-lexicon-aws`, and directory-scoping alone still pays the
 * pathological cost once per NEW directory, not just once per package.
 */
function resolveModulePathMemoized(
  specifier: string,
  fromFile: string,
  resolvePathCache: Map<string, string>,
): string {
  const isBare = !specifier.startsWith(".") && !isAbsolute(specifier);
  if (isBare) {
    const cached = bareSpecifierPathCache.get(specifier);
    if (cached !== undefined) return cached;
    const resolved = resolveModulePath(specifier, fromFile);
    bareSpecifierPathCache.set(specifier, resolved);
    return resolved;
  }
  const key = `${dirname(fromFile)}\0${specifier}`;
  const cached = resolvePathCache.get(key);
  if (cached !== undefined) return cached;
  const resolved = resolveModulePath(specifier, fromFile);
  resolvePathCache.set(key, resolved);
  return resolved;
}

/**
 * chant #1020 hang fix — construct an `Error` for a routine, EXPECTED
 * cross-file resolution failure (an unresolvable import, a non-function
 * export, a shape this module doesn't support) WITHOUT V8's normal eager
 * stack-frame capture. Every one of these is thrown, then caught a few
 * frames up and reduced to `.message` — `tryFoldFileCore`'s own top-level
 * catch, ultimately, same as {@link FoldError} (see its own doc in
 * ../fold/fold.ts for the full mechanism and profiling evidence): `.stack` is
 * never read on this path. Cheap for a shallow call stack, but this module's
 * cross-file recursion (`foldFileMemoized` -> `buildExternals` ->
 * `tryFoldFileCore` -> `resolveDeclaratorValue`/`resolveLiveValue` ->
 * `resolveCallExpression`/`resolveImportedExport`, sometimes several files
 * deep) makes the live stack deep enough, and hot enough for V8 to inline
 * aggressively across a 98-entry corpus, that eager capture becomes the
 * dominant cost — confirmed via `sample` during the observed multi-minute
 * stall. Every throw site in this module that isn't a {@link FoldError}
 * itself should use this instead of `new Error(...)`.
 */
function cheapError(message: string): Error {
  const prevStackTraceLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    return new Error(message);
  } finally {
    Error.stackTraceLimit = prevStackTraceLimit;
  }
}

/**
 * Memoized {@link importModule} — see {@link FoldSession.importCache}'s doc
 * for why this exists. Keyed by `modulePath` exactly as callers already pass
 * it (the output of {@link resolveModulePath}, always an absolute path), so
 * every caller resolving the same module shares the identical in-flight/
 * settled promise instead of issuing its own `import()`.
 */
function importModuleMemoized(
  modulePath: string,
  importCache: Map<string, Promise<Record<string, unknown>>>,
): Promise<Record<string, unknown>> {
  const cached = importCache.get(modulePath);
  if (cached) return cached;
  const promise = importModule(modulePath);
  importCache.set(modulePath, promise);
  return promise;
}

/** True when `node` carries the `export` modifier. */
function hasExportModifier(node: { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * True for any non-null, non-array object — a real `CompositeInstance`, a
 * real `Declarable`, or (chant #1020) the synthetic plain object a
 * namespace import's cross-file resolution builds from another file's own
 * `exportedValues`. Property/member access on any of these is just a plain
 * bracket index, so {@link resolveLiveValue} doesn't need to special-case
 * which kind it is.
 */
function isIndexableObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract a foldable object-binding-pattern element's source property key, or `undefined` if the shape isn't supported (rest element, nested pattern, default value, computed name). */
function bindingElementPropKey(el: ts.BindingElement): string | undefined {
  if (el.dotDotDotToken || el.initializer || !ts.isIdentifier(el.name)) return undefined;
  if (!el.propertyName) return el.name.text;
  return ts.isIdentifier(el.propertyName) ? el.propertyName.text : undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Scan: classify every top-level statement, in file order.
// ─────────────────────────────────────────────────────────────────────────

/** A single exported `const name = new Type(...)` — the original (#1022) resource shape. */
interface ResourceDeclarator {
  kind: "resource";
  name: string;
  node: ts.NewExpression;
}

/** A single exported `const name = <expr>` where `<expr>` isn't `new Type(...)` — #1023's composite-call shape (or a plain value, which still falls back). */
interface SingleDeclarator {
  kind: "single";
  name: string;
  node: ts.Expression;
}

/** `export const { a, b: bAlias } = <expr>;` — #1023: destructuring a composite call's result at export time. */
interface DestructureDeclarator {
  kind: "destructure";
  node: ts.Expression;
  elements: Array<{ propKey: string; bindingName: string }>;
}

/** `export { a, b as c };` — a LOCAL named-export list (no `moduleSpecifier`), referencing bindings declared earlier in the same file (#1023: commonly a composite call destructured into local `const`s first, then re-exported by name). Distinct from a genuine re-export (`export { a } from "./other"`), handled by {@link ReExportDeclarator} below. */
interface NamedExportDeclarator {
  kind: "named-export";
  elements: Array<{ localNameNode: ts.Identifier; exportedName: string }>;
}

/** `export { a, b as c } from "./other";` (chant #1020) — a genuine re-export: each element names an export of ANOTHER module, resolved cross-file exactly like an imported binding, then re-exported under (possibly) a different name. `export * from "./other"` is NOT this shape (no enumerable element list to resolve one-by-one) and still disqualifies the file, same as before #1020. */
interface ReExportDeclarator {
  kind: "re-export";
  specifier: string;
  specifierNode: ts.StringLiteral;
  elements: Array<{ imported: string; exportedName: string }>;
}

type ScanDeclarator =
  | ResourceDeclarator
  | SingleDeclarator
  | DestructureDeclarator
  | NamedExportDeclarator
  | ReExportDeclarator;

interface ScanResult {
  declarators: ScanDeclarator[];
  unfoldableReason?: string;
}

/**
 * Scan a source file's top-level statements for the exported shapes this
 * module can fold: `export const X = new Type(...)` (resources, #1022),
 * `export const X = <expr>` / `export const { a, b } = <expr>` (composite
 * calls and member access on them, #1023), `export { a, b }` (a local
 * named-export list), and `export { a, b } from "./other"` (a re-export
 * chain, #1020). Any OTHER export construct (`export default`, `export *
 * from`, an exported function/class, `let`/`var`, a destructured export with
 * a rest/nested/defaulted element) makes the whole file ineligible: the
 * module must run so that construct is actually evaluated. This mirrors the
 * epic's hybrid design — fallback is per-module, not per-declaration,
 * because an unfoldable export can itself reference or be referenced by a
 * foldable one in ways only running proves safe.
 */
function scanExports(sourceFile: ts.SourceFile): ScanResult {
  const declarators: ScanDeclarator[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      return { declarators, unfoldableReason: "`export default` is not foldable" };
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue; // `export type { ... }` — erased, no runtime value to fold.
      if (statement.moduleSpecifier) {
        // chant #1020 — a genuine re-export (`export { a } from "./other"`).
        // `export * from "./other"` has no `exportClause` at all — no
        // enumerable element list to resolve one-by-one — and still
        // disqualifies the file, same as before #1020.
        if (!ts.isStringLiteral(statement.moduleSpecifier)) {
          return { declarators, unfoldableReason: "re-export declaration is not foldable" };
        }
        if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
          return { declarators, unfoldableReason: "re-export declaration is not foldable" };
        }
        const elements: ReExportDeclarator["elements"] = [];
        for (const el of statement.exportClause.elements) {
          if (el.isTypeOnly) continue;
          const importedNameNode = el.propertyName ?? el.name;
          if (!ts.isIdentifier(importedNameNode)) {
            return { declarators, unfoldableReason: "re-export declaration is not foldable" };
          }
          elements.push({ imported: importedNameNode.text, exportedName: el.name.text });
        }
        declarators.push({
          kind: "re-export",
          specifier: statement.moduleSpecifier.text,
          specifierNode: statement.moduleSpecifier,
          elements,
        });
        continue;
      }
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        return { declarators, unfoldableReason: "export declaration is not foldable" };
      }
      const elements: NamedExportDeclarator["elements"] = [];
      for (const el of statement.exportClause.elements) {
        if (el.isTypeOnly) continue;
        const localNameNode = el.propertyName ?? el.name;
        // `export { "string name" as foo }` (TS 4.5+ module-export-name
        // syntax) isn't a plain identifier reference — not seen in practice
        // for local (non-re-export) lists; fall back rather than guess.
        if (!ts.isIdentifier(localNameNode)) {
          return { declarators, unfoldableReason: "export declaration is not foldable" };
        }
        elements.push({ localNameNode, exportedName: el.name.text });
      }
      declarators.push({ kind: "named-export", elements });
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement)) {
      return {
        declarators,
        unfoldableReason: `exported function declaration "${statement.name?.text ?? "<anonymous>"}" is not foldable`,
      };
    }
    if (ts.isClassDeclaration(statement) && hasExportModifier(statement)) {
      return {
        declarators,
        unfoldableReason: `exported class declaration "${statement.name?.text ?? "<anonymous>"}" is not foldable`,
      };
    }
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;

    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      return { declarators, unfoldableReason: "exported `let`/`var` declaration is not foldable" };
    }

    for (const decl of statement.declarationList.declarations) {
      if (!decl.initializer) {
        return { declarators, unfoldableReason: "exported destructured or uninitialized declaration is not foldable" };
      }

      if (ts.isIdentifier(decl.name)) {
        if (ts.isNewExpression(decl.initializer)) {
          declarators.push({ kind: "resource", name: decl.name.text, node: decl.initializer });
        } else {
          declarators.push({ kind: "single", name: decl.name.text, node: decl.initializer });
        }
        continue;
      }

      if (ts.isObjectBindingPattern(decl.name)) {
        const elements: Array<{ propKey: string; bindingName: string }> = [];
        let allSupported = true;
        for (const el of decl.name.elements) {
          const propKey = bindingElementPropKey(el);
          if (propKey === undefined) {
            allSupported = false;
            break;
          }
          elements.push({ propKey, bindingName: el.name.getText() });
        }
        if (!allSupported) {
          return { declarators, unfoldableReason: "exported destructured or uninitialized declaration is not foldable" };
        }
        declarators.push({ kind: "destructure", node: decl.initializer, elements });
        continue;
      }

      // ArrayBindingPattern — not supported.
      return { declarators, unfoldableReason: "exported destructured or uninitialized declaration is not foldable" };
    }
  }

  return { declarators };
}

// ─────────────────────────────────────────────────────────────────────────
// Local (possibly non-exported) top-level bindings — needed to resolve
// `const web = WebApp({...}); export const x = web.member;` and
// `const { a } = WebApp({...}); export { a };` (#1023): the composite call
// itself is very often not the exported declaration.
// ─────────────────────────────────────────────────────────────────────────

/** Where a local top-level identifier's value comes from: either directly (`propKey` unset) or as one destructured member of another expression's result. */
interface LocalBinding {
  source: ts.Expression;
  propKey?: string;
}

function collectLocalBindings(sourceFile: ts.SourceFile): Map<string, LocalBinding> {
  const bindings = new Map<string, LocalBinding>();

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;

    for (const decl of statement.declarationList.declarations) {
      if (!decl.initializer) continue;

      if (ts.isIdentifier(decl.name)) {
        bindings.set(decl.name.text, { source: decl.initializer });
      } else if (ts.isObjectBindingPattern(decl.name)) {
        for (const el of decl.name.elements) {
          const propKey = bindingElementPropKey(el);
          if (propKey === undefined) continue;
          bindings.set(el.name.getText(), { source: decl.initializer, propKey });
        }
      }
      // ArrayBindingPattern locals: not indexed — a later reference to one
      // of its names simply won't be found below, which correctly falls
      // back (same as referencing any other unresolved identifier).
    }
  }

  return bindings;
}

// ─────────────────────────────────────────────────────────────────────────
// Import resolution — unchanged from #1022, shared by the resource and
// composite-call resolution paths.
// ─────────────────────────────────────────────────────────────────────────

/** Where an imported local identifier came from. */
interface ImportBinding {
  specifier: string;
  imported: string;
  /** The `import ... from "specifier"` declaration's module-specifier
   * string-literal node (chant #1020) — used to attach a source position to
   * a cross-file resolution failure (in particular an import-cycle
   * diagnostic) at the referencing site, not just the defining one. */
  specifierNode: ts.StringLiteral;
}

/** Where a namespace import (`import * as ns from "specifier"`) came from — chant #1020. */
interface NamespaceImportBinding {
  specifier: string;
  specifierNode: ts.StringLiteral;
}

interface CollectedImports {
  /** Default and named bindings (`import Foo from "x"`, `import { a, b as c } from "x"`). */
  named: Map<string, ImportBinding>;
  /** Namespace bindings (`import * as ns from "x"`) — chant #1020: indexed
   * (unlike before) so a property-access chain rooted at `ns`
   * (`ns.someExport`, e.g. `ecr.apiRepo.RepositoryUri`) can resolve
   * cross-file. Still doesn't help a constructor/composite-factory CALLEE
   * shaped as a dotted name (`new ns.Type(...)`, `ns.Foo(...)`) — that
   * callee text is the literal string "ns.Type"/"ns.Foo", which simply
   * misses `named` above, unaffected by this map's existence. */
  namespaces: Map<string, NamespaceImportBinding>;
}

/** Map every top-level `import`-bound local identifier to its source module + export name. */
function collectImports(sourceFile: ts.SourceFile): CollectedImports {
  const named = new Map<string, ImportBinding>();
  const namespaces = new Map<string, NamespaceImportBinding>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    // A whole-statement `import type { ... } from "x"` is erased at runtime
    // and never appears in expression position — indexing it would only
    // ever manufacture a false cross-file dependency edge (taint, or worse,
    // a phantom import-cycle) between files that share no real value
    // dependency. Per-specifier `import { type Foo } from "x"` is filtered
    // below, at the named-element level.
    if (clause.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    const specifierNode = statement.moduleSpecifier;

    if (clause.name) {
      named.set(clause.name.text, { specifier, imported: "default", specifierNode });
    }
    if (clause.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue;
          const imported = element.propertyName?.text ?? element.name.text;
          named.set(element.name.text, { specifier, imported, specifierNode });
        }
      } else if (ts.isNamespaceImport(clause.namedBindings)) {
        namespaces.set(clause.namedBindings.name.text, { specifier, specifierNode });
      }
    }
  }

  return { named, namespaces };
}

/**
 * chant #1020 hang fix — best-effort fast path for resolving a BARE
 * specifier by walking `node_modules` directly with the same primitives
 * (`existsSync`/`readFileSync`) the relative-specifier branch below already
 * uses, reading `package.json`'s "exports"/"main" field by hand instead of
 * calling `createRequire(fromFile).resolve(specifier)`. Returns `undefined`
 * — never throws — for anything beyond the simple, single-target shape
 * (a string `"exports"`, or an object whose `"."` entry is a string or a
 * flat, string-valued condition map): the caller falls back to the slow,
 * authoritative `createRequire().resolve()` path whenever this returns
 * `undefined`, so a genuinely complex `package.json` (a conditions array, a
 * self-reference, a `"."` entry the fast path doesn't recognize) is still
 * resolved correctly, just not quickly.
 *
 * Why this exists at all: profiling traced the hang to
 * `createRequire(fromFile).resolve(specifier)` ITSELF taking upwards of a
 * minute — and, worse, growing (measured 60s, then 69s, then 361s for
 * successive NEW packages later in the same run) — inside a vitest worker,
 * specifically for the FIRST resolution of a given bare specifier in the
 * process (session-level and even process-wide-by-specifier caching, see
 * {@link bareSpecifierPathCache}, only avoid paying that cost a SECOND
 * time). The relative-specifier branch just below, using these exact same
 * `existsSync`/`statSync` primitives, never showed this slowdown anywhere
 * in the same profiling — the cost is specific to Node's own
 * `Module._resolveFilename` machinery, not to file-system access in
 * general, so replacing just that one call with plain `existsSync`/
 * `readFileSync` sidesteps it entirely for the common case every
 * `@intentius/chant*` package (and most well-formed npm packages) ships.
 */
function fastResolveBareSpecifier(specifier: string, fromFile: string): string | undefined {
  let dir = dirname(fromFile);
  for (;;) {
    const packageDir = join(dir, "node_modules", specifier);
    if (existsSync(packageDir)) {
      const entry = fastResolvePackageEntry(packageDir);
      if (entry === undefined) return undefined;
      const resolved = resolvePath(packageDir, entry);
      if (!existsSync(resolved) || !statSync(resolved).isFile()) return undefined;
      try {
        return realpathSync(resolved);
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root, unresolved
    dir = parent;
  }
}

/** Read `<packageDir>/package.json`'s "." export target — see {@link fastResolveBareSpecifier}'s doc for exactly which shapes this recognizes; anything else returns `undefined`. */
function fastResolvePackageEntry(packageDir: string): string | undefined {
  const pkgJsonPath = join(packageDir, "package.json");
  if (!existsSync(pkgJsonPath)) return undefined;
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    return undefined;
  }
  if (typeof pkg !== "object" || pkg === null) return undefined;
  const exportsField = (pkg as Record<string, unknown>).exports;

  if (exportsField !== undefined) {
    if (typeof exportsField === "string") return exportsField;
    if (typeof exportsField !== "object" || exportsField === null || Array.isArray(exportsField)) {
      return undefined;
    }
    const exportsObj = exportsField as Record<string, unknown>;
    // No "." key at all means the WHOLE object IS the "." export's own
    // condition map (the shorthand form) — only when none of its OWN keys
    // look like a subpath/condition-name ambiguity risk (a key starting
    // with "." that isn't literally "." itself signals real subpath
    // exports present, so bail rather than misparse).
    const hasSubpathKeys = Object.keys(exportsObj).some((k) => k.startsWith(".") && k !== ".");
    const target = "." in exportsObj ? exportsObj["."] : hasSubpathKeys ? undefined : exportsObj;
    if (target === undefined) return undefined;
    if (typeof target === "string") return target;
    if (typeof target !== "object" || target === null || Array.isArray(target)) return undefined;
    const conditions = target as Record<string, unknown>;
    // Prefer "default" (present on every chant/lexicon package and the
    // overwhelming majority of well-formed dual-mode npm packages); "node"/
    // "import" as narrower fallbacks. Every chant package's own "default"
    // and "development" conditions point at the identical source file, so
    // which one Node's own algorithm would have picked never matters here.
    for (const key of ["default", "node", "import"]) {
      const val = conditions[key];
      if (typeof val === "string") return val;
    }
    return undefined;
  }

  const main = (pkg as Record<string, unknown>).main;
  if (main !== undefined) return typeof main === "string" ? main : undefined;
  return "index.js";
}

/**
 * Resolve an import specifier to an absolute module path, the way the
 * declaring file's own `import` would — without depending on a TS-aware
 * loader being active. Relative/absolute specifiers are probed against real
 * TS/JS candidate files on disk; bare package specifiers try
 * {@link fastResolveBareSpecifier} first, falling back to Node's own CJS
 * algorithm from the declaring file's location (lexicon packages ship built
 * JS, so this needs no `.ts` awareness) whenever that returns `undefined`.
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

  const fast = fastResolveBareSpecifier(specifier, fromFile);
  if (fast !== undefined) return fast;
  return createRequire(fromFile).resolve(specifier);
}

/**
 * chant #1064 — the absolute path of chant-core's OWN build-time-parameters
 * runtime module (../params.ts), resolved once, from THIS file's own
 * location, via the exact same relative-specifier resolution
 * {@link resolveModulePath} already applies to project files. Used by
 * {@link buildExternals} to recognize a project file's `import { params }
 * from "@intentius/chant/params"` (a BARE specifier, resolved the normal way
 * through the consuming project's own `node_modules`) as referring to this
 * same installed package — install-layout-agnostic (dev "src" condition or
 * built "dist"), with no text-matching of the specifier string itself.
 */
const PARAMS_MODULE_PATH = resolveModulePath("../params", fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────
// Resolution: given the scan + import map, compute the REAL runtime value
// (Declarable | CompositeInstance) each foldable export would have had if
// the file had actually run — without running the file.
// ─────────────────────────────────────────────────────────────────────────

/** Everything the recursive resolver needs, threaded through unchanged. */
interface ResolveCtx {
  file: string;
  consts: Map<string, ts.Expression>;
  locals: Map<string, LocalBinding>;
  imports: Map<string, ImportBinding>;
  /** Namespace imports (chant #1020) — see {@link CollectedImports.namespaces}. */
  namespaceImports: Map<string, NamespaceImportBinding>;
  /** Memoizes by initializer node so a composite call referenced by several member accesses / destructured names is invoked exactly once — matching what actually running the file would do. */
  memo: Map<ts.Expression, Promise<LiveResolution>>;
  /** Lexicon-registered intrinsic tags (chant #1039) — passed through to
   * {@link fold}/{@link foldResource} so a registered tagged template
   * (e.g. AWS `Sub`\`...\`) folds instead of throwing "unregistered tagged
   * template intrinsic". Empty when the caller (`discover()`) wasn't given any. */
  intrinsics: readonly IntrinsicDef[];
  /**
   * chant #1020 — every relative-import binding of `file`'s that resolved,
   * eagerly, to its real cross-file value: a plain value for an imported
   * `const`, the real live `Declarable`/`CompositeInstance` for a name bound
   * to a resource/composite in the defining module (see this module's own
   * doc comment on `planFoldTaint` for why identity — not just equality —
   * has to be preserved here), or a synthetic plain object of a namespace
   * import's own `exportedValues` (so `ns.someExport` indexes it exactly
   * like any other object). Consulted by {@link fold}/{@link foldResource}
   * only when an identifier isn't one of `file`'s own `consts`, and by
   * {@link resolveLiveValue}'s identifier branch only when it isn't one of
   * `locals`. A name absent from this map (an unresolvable import, a bare
   * package specifier, or a name a cross-file fold attempt didn't produce)
   * falls through to the exact same "unresolved identifier"/"not foldable"
   * failure as before #1020 — this is strictly additive.
   */
  externals: Map<string, unknown>;
  /**
   * chant #1020 — for a `file`-local import name whose cross-file
   * resolution attempt failed, WHY (a located, human-readable reason —
   * notably an import-cycle diagnostic naming the cycle path). Used only to
   * enrich an otherwise-generic "unresolved identifier: X" failure message
   * when X happens to be one of these names; purely cosmetic; resolution
   * behavior doesn't depend on it.
   */
  crossFileFailures: Map<string, string>;
  /**
   * chant #1020 hang fix — session-wide {@link importModule} memo (see
   * {@link FoldSession.importCache}'s doc). Every constructor/composite-
   * factory/intrinsic import in this module goes through
   * {@link importModuleMemoized} with this map, not a bare `importModule`
   * call.
   */
  importCache: Map<string, Promise<Record<string, unknown>>>;
  /**
   * chant #1020 hang fix — session-wide {@link resolveModulePath} memo (see
   * {@link FoldSession.resolvePathCache}'s doc). Every constructor/composite-
   * factory/intrinsic/re-export resolution in this module goes through
   * {@link resolveModulePathMemoized} with this map.
   */
  resolvePathCache: Map<string, string>;
}

/** `{ value }` when `node`'s shape was recognized and resolved (value may itself be `undefined`/`null` — e.g. an optional composite member that wasn't created); `undefined` when the shape isn't one the live resolver understands (a plain literal, etc.) — callers fall back to the original, unchanged handling for that shape. */
type LiveResolution = { value: unknown } | undefined;

function resolveMemoized(node: ts.Expression, ctx: ResolveCtx): Promise<LiveResolution> {
  const cached = ctx.memo.get(node);
  if (cached) return cached;
  const promise = resolveLiveValue(node, ctx);
  ctx.memo.set(node, promise);
  return promise;
}

/**
 * Attempt to resolve `node` to the real runtime value it would have if the
 * file were executed. Understands the "spine" of composite consumption: a
 * bare call (a composite factory, or a wrapper like `propagate()` — resolved
 * through this file's imports, invoked for real with statically-folded
 * arguments), a reference to an earlier top-level `const` bound to one of
 * those (memoized — see {@link ResolveCtx.memo}), and dotted property access
 * or `!` non-null assertion on the result (`web.deployment`, `web.pdb!`).
 *
 * Throws when the shape IS recognized (a call, a member access) but
 * resolution genuinely fails — unresolved import, non-function import,
 * folding a nested argument failed, member access on a non-composite value,
 * the call itself threw. That failure should fall back the whole file to
 * run, same as any other fold gap.
 */
async function resolveLiveValue(node: ts.Expression, ctx: ResolveCtx): Promise<LiveResolution> {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return resolveLiveValue(node.expression, ctx);
  }

  if (ts.isIdentifier(node)) {
    const binding = ctx.locals.get(node.text);
    if (!binding) {
      // chant #1020 — not a same-file local; try a cross-file resolution
      // (a plain value, or the real live Declarable/CompositeInstance a
      // sibling file's own fold produced, or a namespace import's synthetic
      // exports object). Absent from `externals` falls through to
      // `undefined`, exactly the pre-#1020 behavior for any unbound name.
      if (ctx.externals.has(node.text)) {
        return { value: ctx.externals.get(node.text) };
      }
      return undefined;
    }
    const resolvedSource = await resolveMemoized(binding.source, ctx);
    if (resolvedSource === undefined) return undefined;
    if (binding.propKey === undefined) return resolvedSource;
    if (!isIndexableObject(resolvedSource.value)) {
      throw cheapError(`destructured member "${binding.propKey}" is not on a composite value`);
    }
    return { value: (resolvedSource.value as unknown as Record<string, unknown>)[binding.propKey] };
  }

  if (ts.isCallExpression(node)) {
    return { value: await resolveCallExpression(node, ctx) };
  }

  if (ts.isPropertyAccessExpression(node)) {
    const base = await resolveLiveValue(node.expression, ctx);
    if (base === undefined) return undefined;
    const key = node.name.text;
    if (!isIndexableObject(base.value)) {
      throw cheapError(`property access ".${key}" on a non-composite value is not foldable`);
    }
    return { value: (base.value as unknown as Record<string, unknown>)[key] };
  }

  return undefined;
}

/**
 * Resolve and invoke a bare call expression — a composite factory call
 * (`SomeComposite({...})`) or a wrapper that takes a composite instance and
 * returns one (`propagate(SomeComposite({...}), {...})`). The callee must be
 * a plain identifier bound by this file's own `import` (a namespace-import
 * call like `ns.Foo(...)`, or a call to a function/composite DEFINED in this
 * same file, can't be resolved without running the file — falls back, same
 * as an unresolvable resource constructor).
 *
 * No pre-check verifies the resolved callee is "really" a composite: each
 * argument is resolved (recursively, for a nested composite-call/member-
 * access argument like `propagate`'s first one) or folded (for a plain props
 * object literal via {@link fold}), the real function is invoked, and the
 * RESULT is what matters to the caller — {@link resolveLiveValue}'s callers
 * decide what shape they need (a `CompositeInstance` for member access, an
 * `isDeclarable`/`isCompositeInstance` value for a top-level export).
 */
async function resolveCallExpression(node: ts.CallExpression, ctx: ResolveCtx): Promise<unknown> {
  if (!ts.isIdentifier(node.expression)) {
    throw cheapError(`call expression as a value is not foldable: ${node.expression.getText()}(...)`);
  }
  const calleeName = node.expression.text;
  const binding = ctx.imports.get(calleeName);
  if (!binding) {
    throw cheapError(`call expression as a value is not foldable: ${calleeName}(...)`);
  }

  let modulePath: string;
  try {
    modulePath = resolveModulePathMemoized(binding.specifier, ctx.file, ctx.resolvePathCache);
  } catch (err) {
    throw cheapError(
      `could not resolve import "${binding.specifier}" for "${calleeName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Reuses the SAME import mechanism the run path uses ({@link importModule},
  // ../discovery/import.ts — a plain-path `import()`) rather than a
  // `pathToFileURL(...)`-wrapped one. For a resource constructor (a
  // stateless lexicon class) the two would be interchangeable, but a
  // composite-call resolution (#1023) can import a SIBLING PROJECT FILE
  // (e.g. `import { network } from "./network"`, not just a lexicon
  // package) that `discover()`'s own per-file loop ALSO independently
  // processes — if that file falls back to run and imports the same
  // sibling for a live value (`network.vpc.VpcId`), the two import calls
  // MUST resolve to the identical cached module instance, or the run side
  // ends up with a second, distinct `network`/`vpc` object whose AttrRefs
  // can never be matched back to the entity fold already registered
  // (`Cannot serialize AttrRef ...: logical name not set`).
  let mod: Record<string, unknown>;
  try {
    mod = await importModuleMemoized(modulePath, ctx.importCache);
  } catch (err) {
    throw cheapError(
      `could not import "${binding.specifier}" to resolve "${calleeName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const Fn = mod[binding.imported];
  if (typeof Fn !== "function") {
    throw cheapError(`"${binding.imported}" from "${binding.specifier}" is not a function`);
  }

  const args: unknown[] = [];
  for (const argNode of node.arguments) {
    const live = await resolveLiveValue(argNode, ctx);
    // chant #1039 — a folded (non-live) argument may itself contain a
    // registered intrinsic tagged template; revive it into the real value
    // before the composite factory actually runs on it (see the "Intrinsic
    // revival" section below `resolveResourceEntity` uses the same way).
    args.push(
      live !== undefined
        ? live.value
        : await reviveFoldedValue(fold(argNode, ctx.consts, ctx.intrinsics, ctx.externals), ctx, false),
    );
  }

  return (Fn as (...fnArgs: unknown[]) => unknown)(...args);
}

/**
 * Record one exported name's fully-resolved value: into `entities` when
 * it's a real `Declarable`/`CompositeInstance` (`collectEntities`, and
 * therefore serialization, only cares about these), and — chant #1020 —
 * unconditionally into `exportedValues` too, so a plain value (a string, a
 * number, a plain object, `undefined`/`null`) is still available for
 * ANOTHER file's cross-file reference to this export, exactly as it would
 * be if this file were actually imported and its real `exports` object read
 * directly. A plain value contributing nothing to `entities` isn't a
 * failure: the run path's real `exports` object would contain it too, and
 * `collectEntities` already silently ignores a non-Declarable/array/
 * CompositeInstance export the same way (see enumerateEntries, ../collect.ts).
 */
function applyResolvedValue(
  name: string,
  value: unknown,
  entities: FoldedEntity[],
  exportedValues: Map<string, unknown>,
): void {
  exportedValues.set(name, value);
  if (isDeclarable(value) || isCompositeInstance(value)) {
    entities.push([name, value as Declarable | CompositeInstance]);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Intrinsic revival (chant #1039).
//
// `fold()`/`foldResource()` reduce a registered intrinsic tagged template
// (e.g. AWS `Sub`\`...\`) to a symbolic `FoldedIntrinsic` node —
// `{ __intrinsic, strings, values }` — and an unresolved external symbol
// chain inside it (e.g. `AWS.StackName`) to a `SymbolicValue` —
// `{ __symbol }` (../fold/fold.ts's own doc: "mirrors the runtime call shape
// `Tag(strings, ...values)` so a later build path can replay it into the
// real intrinsic object"). This IS that later build path: without it, the
// symbolic envelope would be passed straight into the constructed entity's
// props as an inert plain object — the entity would be built (no crash), but
// its serialized output would silently diverge from the run path's real
// `Sub`/`PseudoParameter` instances (caught by the #1025 differential the
// moment intrinsics started actually folding). `reviveFoldedProps` walks the
// folded props/attributes tree and, for each `{__intrinsic}`/`{__symbol}`
// node, resolves the real tag function / pseudo-parameter through this
// file's own imports (same mechanism `resolveResourceEntity` already uses
// for the resource constructor itself) and invokes/accesses it for real —
// exactly what running the original tagged template would have done.
//
// `{__attrRef}` (a same-file sibling-resource reference, ../fold/fold.ts's
// `AttrRefValue`) is left untouched when it is NOT nested inside a revived
// intrinsic: the serializer's generic walker already recognizes that plain
// envelope structurally (see ../serializer-walker.ts) with no revival
// needed. But an intrinsic's OWN implementation (e.g. `SubIntrinsic`) needs
// a genuine `AttrRef` instance internally (`instanceof` checks), which would
// require wiring a live `WeakRef` to the sibling entity — out of scope here,
// same call as the existing "nested `new Type(...)` as a value" rejection
// a few lines up: reject (fall back to run) rather than risk silently wrong
// output.
// ─────────────────────────────────────────────────────────────────────────

/** Resolve a bare name bound by this file's own `import` to its real, live export — the same two-step (resolve module path, then `importModule`) `resolveResourceEntity`/`resolveCallExpression` already use for constructors and composite factories. */
async function resolveImportedExport(name: string, ctx: ResolveCtx): Promise<unknown> {
  const binding = ctx.imports.get(name);
  if (!binding) {
    throw cheapError(`"${name}" is not a resolvable import`);
  }

  let modulePath: string;
  try {
    modulePath = resolveModulePathMemoized(binding.specifier, ctx.file, ctx.resolvePathCache);
  } catch (err) {
    throw cheapError(
      `could not resolve import "${binding.specifier}" for "${name}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let mod: Record<string, unknown>;
  try {
    mod = await importModuleMemoized(modulePath, ctx.importCache);
  } catch (err) {
    throw cheapError(
      `could not import "${binding.specifier}" to resolve "${name}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return mod[binding.imported];
}

/** A bare identifier, or simple dotted access chain rooted at one (`AWS.StackName`, `Azure.ResourceGroupName`) — the only shape {@link fold.ts}'s `isUnresolvedSymbolChain` actually produces `SymbolicValue` text for in practice (element access/non-null on a pseudo-parameter-style namespace isn't a real authoring pattern anywhere in a lexicon today). Anything else is rejected rather than guessed at. */
const SIMPLE_DOTTED_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** Resolve a folded `SymbolicValue`'s raw source text (e.g. `"AWS.StackName"`) back to the real value it refers to, by resolving its root identifier through this file's own imports and then doing real property access down the rest of the chain — reproducing exactly what evaluating that expression at runtime would have done. */
async function resolveSymbolicValue(text: string, ctx: ResolveCtx): Promise<unknown> {
  if (!SIMPLE_DOTTED_CHAIN.test(text)) {
    throw cheapError(`symbol "${text}" is not a simple dotted import reference`);
  }
  const [root, ...path] = text.split(".");
  let value = await resolveImportedExport(root, ctx);
  for (const key of path) {
    if (value === null || value === undefined) {
      throw cheapError(`symbol "${text}": "${root}" has no "${key}"`);
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * Revive a folded value tree: replace any `{__intrinsic}`/`{__symbol}`
 * envelope with the real value it represents. `insideIntrinsic` tracks
 * whether the CURRENT node is (transitively) one of a `{__intrinsic}`'s own
 * `values` — see the module-doc note above on why `{__attrRef}` is only
 * rejected there, not everywhere.
 */
async function reviveFoldedValue(value: FoldedValue, ctx: ResolveCtx, insideIntrinsic: boolean): Promise<unknown> {
  if (value === null || typeof value !== "object") return value;

  // chant #1020 — a REAL, already-constructed live object reached via
  // cross-file resolution (`ctx.externals`, e.g. `network.vpc.VpcId` folding
  // to a genuine `AttrRef` wired to the actual shared `vpc` instance, or a
  // bare cross-file identifier folding directly to the shared
  // Declarable/CompositeInstance itself). None of these have an own
  // `__symbol`/`__intrinsic`/`__attrRef`/`__resource` marker KEY — an AttrRef
  // instance's own enumerable fields are `parent`/`attribute`, not a nested
  // `__attrRef` object — so without this early return the generic object
  // walk below would silently reconstruct a plain-object copy of it,
  // destroying the very identity #1020 exists to preserve. Passed through
  // completely unchanged, exactly like `resolveCallExpression`'s own
  // `live.value` passthrough for a composite-call argument.
  if (isAttrRefLike(value) || isDeclarable(value) || isCompositeInstance(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    const revived: unknown[] = [];
    for (const el of value) revived.push(await reviveFoldedValue(el, ctx, insideIntrinsic));
    return revived;
  }

  if ("__symbol" in value) {
    const symbolic = value as SymbolicValue;
    return resolveSymbolicValue(symbolic.__symbol, ctx);
  }

  if ("__intrinsic" in value) {
    const intrinsic = value as FoldedIntrinsic;
    const Fn = await resolveImportedExport(intrinsic.__intrinsic, ctx);
    if (typeof Fn !== "function") {
      throw cheapError(`intrinsic tag "${intrinsic.__intrinsic}" did not resolve to a function`);
    }
    const revivedValues: unknown[] = [];
    for (const v of intrinsic.values) revivedValues.push(await reviveFoldedValue(v, ctx, true));
    return (Fn as (...fnArgs: unknown[]) => unknown)(intrinsic.strings, ...revivedValues);
  }

  if ("__attrRef" in value) {
    if (insideIntrinsic) {
      throw cheapError(
        "a same-file resource reference inside a folded intrinsic's interpolation is not foldable yet",
      );
    }
    return value;
  }

  if ("__resource" in value) {
    // fold() itself already rejects a nested `new Type(...)` as a value
    // (see its own comment) — this is defensive, not a reachable path today.
    throw cheapError("nested resource as a value is not foldable");
  }

  const revived: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    revived[key] = await reviveFoldedValue(v as FoldedValue, ctx, insideIntrinsic);
  }
  return revived;
}

/** Revive every value in a folded props/attributes object (see {@link reviveFoldedValue}). */
async function reviveFoldedProps(
  props: { [key: string]: FoldedValue },
  ctx: ResolveCtx,
): Promise<Record<string, unknown>> {
  const revived: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    revived[key] = await reviveFoldedValue(value, ctx, false);
  }
  return revived;
}

// ─────────────────────────────────────────────────────────────────────────
// Resource construction — unchanged from #1022 (folds the ctor call's props
// via `fold()`, resolves the constructor through this file's imports,
// constructs the real Declarable).
// ─────────────────────────────────────────────────────────────────────────

async function resolveResourceEntity(
  name: string,
  node: ts.NewExpression,
  ctx: ResolveCtx,
): Promise<{ ok: true; entity: Declarable } | { ok: false; reason: string }> {
  let spec: FoldedResource;
  try {
    spec = foldResource(node, ctx.consts, ctx.intrinsics, ctx.externals);
  } catch (err) {
    if (err instanceof FoldError) {
      return { ok: false, reason: `"${name}" is not foldable: ${describeFoldFailure(err, ctx)}` };
    }
    throw err;
  }

  // chant #1039 — replay any folded intrinsic/symbol envelopes into their
  // real runtime values before constructing the entity. A no-op walk when
  // this file used no registered intrinsics (the overwhelming majority of
  // cases today).
  let props: Record<string, unknown>;
  let attributes: Record<string, unknown> | undefined;
  try {
    props = await reviveFoldedProps(spec.props, ctx);
    attributes = spec.attributes ? await reviveFoldedProps(spec.attributes, ctx) : undefined;
  } catch (err) {
    return {
      ok: false,
      reason: `"${name}" is not foldable: ${describeFoldFailure(err, ctx)}`,
    };
  }

  const typeName = spec.__resource;
  const binding = ctx.imports.get(typeName);
  if (!binding) {
    return { ok: false, reason: `constructor "${typeName}" for "${name}" is not a resolvable import` };
  }

  let modulePath: string;
  try {
    modulePath = resolveModulePathMemoized(binding.specifier, ctx.file, ctx.resolvePathCache);
  } catch (err) {
    return {
      ok: false,
      reason: `could not resolve import "${binding.specifier}" for "${typeName}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Same import mechanism as `resolveCallExpression` above — see its comment.
  let mod: Record<string, unknown>;
  try {
    mod = await importModuleMemoized(modulePath, ctx.importCache);
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
  // ../runtime.ts) is only present in `spec` when the source actually passed
  // one (see foldResource in ../fold/fold.ts). Passing `undefined` when it's
  // absent matches the run path's own default (`attributes ?? {}` inside the
  // constructor).
  const ResourceCtor = Ctor as new (
    props: Record<string, unknown>,
    attributes?: Record<string, unknown>,
  ) => Declarable;
  const entity = new ResourceCtor(props, attributes);
  return { ok: true, entity };
}

// ─────────────────────────────────────────────────────────────────────────
// Cross-file resolution (chant #1020) — resolves an imported PROJECT-file
// binding to its real, already-constructed value by recursively folding the
// DEFINING module (in that module's own scope: its own consts, its own
// imports), memoized per {@link FoldSession} so each cross-file export folds
// exactly once and every referrer shares the identical object — see
// `planFoldTaint`'s doc below for why that identity is the entire hard part.
// A bare package specifier (a lexicon/vendor module) is left alone here: it
// resolves through the pre-existing `importModule` mechanism at the point a
// constructor/composite-factory/intrinsic tag is actually used, same as
// before #1020 — this path exists only to avoid executing PROJECT files.
// ─────────────────────────────────────────────────────────────────────────

const UNRESOLVED_IDENTIFIER_RE = /unresolved identifier: (\S+)$/;

/**
 * Enrich an otherwise-generic "unresolved identifier: X" failure when X is a
 * name whose OWN cross-file resolution was attempted and failed for a known
 * reason (most notably an import cycle) — purely cosmetic, never changes
 * whether something resolves. Every other failure shape passes through
 * unchanged.
 */
function describeFoldFailure(err: unknown, ctx: ResolveCtx): string {
  if (!(err instanceof Error)) return String(err);
  const match = UNRESOLVED_IDENTIFIER_RE.exec(err.message);
  if (match) {
    const reason = ctx.crossFileFailures.get(match[1]);
    if (reason) return `${err.message} (${reason})`;
  }
  return err.message;
}

/** Build a located `FoldError`'s formatted "line:col - message" string anchored at `node` — for a cross-file failure detected here in fold-import.ts (an import cycle, a name genuinely absent from the target module's exports) rather than inside `fold()` itself. */
function locatedMessage(node: ts.Node, message: string): string {
  const { line, column } = locate(node);
  return new FoldError(message, line, column).message;
}

/**
 * Fold `file` with session-wide memoization and cycle detection. The SAME
 * promise is handed back to every caller that asks for `file` within one
 * session — `discover()`'s own top-level per-file loop AND any cross-file
 * reference that reaches into `file` alike — so `file` is folded exactly
 * once and every referrer shares the identical constructed entities.
 */
/**
 * A backstop, not a realistic limit: no legitimate project should have an
 * import chain this deep. Exists purely so a FUTURE regression that breaks
 * memoization (e.g. caching by the wrong key, or checking `stack` after
 * awaiting instead of before) fails loudly and immediately with a
 * diagnosable error, instead of recursing until the process runs out of
 * stack/memory or simply never terminates — a correctness bug in this exact
 * function is a termination hazard, not just a wrong-answer one, since
 * `foldFileMemoized` is the one place cross-file resolution can recurse.
 */
const MAX_RESOLUTION_DEPTH = 200;

function foldFileMemoized(file: string, session: FoldSession): Promise<FoldFileResult> {
  const cycleStart = session.stack.indexOf(file);
  if (cycleStart !== -1) {
    // A file currently being resolved (an ancestor of this very call, still
    // on the stack) is needed again — a genuine reference cycle, not merely
    // two files that happen to import each other with no real value
    // dependency (that could never re-enter here for an ancestor). The
    // caller ({@link buildExternals}/the re-export declarator handler, which
    // has the referencing import's own specifier node) attaches a source
    // position to this via {@link locatedMessage}; here we only have the
    // file-level chain to name.
    const cycle = [...session.stack.slice(cycleStart), file].map((f) => basename(f));
    return Promise.resolve({ ok: false, reason: `import cycle: ${cycle.join(" -> ")}` });
  }

  const cached = session.cache.get(file);
  if (cached) return cached;

  if (session.stack.length >= MAX_RESOLUTION_DEPTH) {
    const chain = [...session.stack.slice(-5), file].map((f) => basename(f));
    return Promise.resolve({
      ok: false,
      reason:
        `cross-file resolution depth exceeded ${MAX_RESOLUTION_DEPTH} ` +
        `(...-> ${chain.join(" -> ")}) — this is almost certainly a resolution ` +
        `bug (memoization not taking effect), not a genuinely thousand-file-deep import chain`,
    });
  }

  session.stack.push(file);
  const promise = tryFoldFileCore(file, session).finally(() => {
    const idx = session.stack.lastIndexOf(file);
    if (idx !== -1) session.stack.splice(idx, 1);
  });
  session.cache.set(file, promise);
  return promise;
}

/** True for a relative or absolute specifier — a sibling PROJECT file, as opposed to a bare package specifier (an installed lexicon/vendor module). */
function isProjectFileSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || isAbsolute(specifier);
}

/**
 * Eagerly resolve every project-file import binding of `file`'s to its real
 * cross-file value (see this section's own doc above). A binding that isn't
 * a project-file specifier, doesn't resolve to a file on disk, or whose
 * target doesn't fold or doesn't actually export the requested name is
 * simply left OUT of `externals` — exactly like a name that was never
 * imported at all, `fold()`'s ordinary "unresolved identifier" failure still
 * fires if (and only if) that name is actually referenced. `failures`
 * records WHY, purely to enrich that later message (see
 * {@link describeFoldFailure}).
 */
async function buildExternals(
  file: string,
  imports: Map<string, ImportBinding>,
  namespaceImports: Map<string, NamespaceImportBinding>,
  session: FoldSession,
): Promise<{ externals: Map<string, unknown>; failures: Map<string, string> }> {
  const externals = new Map<string, unknown>();
  const failures = new Map<string, string>();

  for (const [localName, binding] of imports) {
    // chant #1064 — recognized regardless of specifier SHAPE (bare package,
    // relative, or absolute): a named `params` import that resolves to
    // chant-core's own build-time-parameters module (../params.ts) is
    // substituted directly from this build's already-resolved values, with
    // NO import performed — so `params.tier` folds to a LITERAL rather than
    // a symbolic node (contrast the `{__symbol}` deferral a pseudo-parameter
    // namespace import like `AWS.StackName` gets — that genuinely can't
    // resolve until a real module runs; a build parameter's value is already
    // fully known here). Checked BEFORE the project-file/bare-specifier
    // branch below, cheaply (one memoized resolve), so it applies whichever
    // way the real specifier happens to be spelled; a real project's
    // "@intentius/chant/params" bare import and this module's own tests'
    // absolute-path import both take this path identically. Any OTHER
    // `params`-named import (a project file that happens to export something
    // called `params`) simply doesn't match `PARAMS_MODULE_PATH` and falls
    // through unaffected.
    if (session.buildParams && binding.imported === "params") {
      try {
        const targetPath = resolveModulePathMemoized(binding.specifier, file, session.resolvePathCache);
        if (targetPath === PARAMS_MODULE_PATH) {
          externals.set(localName, session.buildParams);
          continue;
        }
      } catch {
        // Unresolvable specifier — fall through to the ordinary handling
        // below, same as any other import this loop can't resolve.
      }
    }

    if (!isProjectFileSpecifier(binding.specifier)) {
      // Every other bare specifier (a lexicon/vendor package) is left alone
      // here, exactly as before #1064: it resolves lazily, through the
      // pre-existing `importModule` mechanism, only once a constructor/
      // composite-factory/intrinsic tag actually consumes it.
      continue;
    }
    let targetPath: string;
    try {
      targetPath = resolveModulePathMemoized(binding.specifier, file, session.resolvePathCache);
    } catch {
      continue;
    }
    const result = await foldFileMemoized(targetPath, session);
    if (!result.ok) {
      failures.set(localName, locatedMessage(binding.specifierNode, result.reason));
      continue;
    }
    if (result.exportedValues.has(binding.imported)) {
      externals.set(localName, result.exportedValues.get(binding.imported));
    } else {
      failures.set(
        localName,
        locatedMessage(binding.specifierNode, `"${binding.imported}" is not exported by "${binding.specifier}"`),
      );
    }
  }

  for (const [localName, binding] of namespaceImports) {
    if (!isProjectFileSpecifier(binding.specifier)) continue;
    let targetPath: string;
    try {
      targetPath = resolveModulePathMemoized(binding.specifier, file, session.resolvePathCache);
    } catch {
      continue;
    }
    const result = await foldFileMemoized(targetPath, session);
    if (!result.ok) {
      failures.set(localName, locatedMessage(binding.specifierNode, result.reason));
      continue;
    }
    // A plain object wrapping the target's own exported values — property
    // access on it (`ns.someExport`) is then just an ordinary bracket index,
    // exactly like on a real composite instance (see `isIndexableObject`).
    externals.set(localName, Object.fromEntries(result.exportedValues));
  }

  return { externals, failures };
}

/**
 * Resolve a declarator's initializer to its final value: first via the
 * "live spine" ({@link resolveLiveValue} — same-file composite-call
 * navigation, and, chant #1020, a cross-file identifier/property-access
 * chain through `ctx.externals`); when that shape isn't recognized at all
 * (a plain literal, object/array literal, template, binary expression, …),
 * via the general reducer ({@link fold} + intrinsic revival) — chant #1020:
 * this is what lets `export const REGION = "us-east-1";` (and an IMPORTED
 * REGION used the same way) fold, not just a `new Type(...)`/composite-call
 * shape. Throws when a shape WAS recognized but resolution genuinely failed
 * (unresolved import, non-function import, a nested argument's own fold
 * failed, an unresolved identifier, …) — the caller falls the whole file
 * back to run, exactly as before #1020.
 */
async function resolveDeclaratorValue(node: ts.Expression, ctx: ResolveCtx): Promise<{ value: unknown }> {
  const live = await resolveLiveValue(node, ctx);
  if (live !== undefined) return live;
  const folded = fold(node, ctx.consts, ctx.intrinsics, ctx.externals);
  return { value: await reviveFoldedValue(folded, ctx, false) };
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Attempt to fold one source file with zero execution of its own top-level
 * code, sharing `session`'s cross-file memoization (chant #1020) — see
 * {@link foldFileMemoized}. Internal; {@link tryFoldFile} is the public
 * entry point below.
 */
async function tryFoldFileCore(file: string, session: FoldSession): Promise<FoldFileResult> {
  try {
    const source = await readFile(file, "utf-8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, /* setParentNodes */ true);

    const scan = scanExports(sourceFile);
    if (scan.unfoldableReason) return { ok: false, reason: scan.unfoldableReason };
    if (scan.declarators.length === 0) return { ok: false, reason: "no foldable resource exports" };

    const collected = collectImports(sourceFile);
    const { externals, failures } = await buildExternals(file, collected.named, collected.namespaces, session);

    const ctx: ResolveCtx = {
      file,
      consts: collectConsts(sourceFile),
      locals: collectLocalBindings(sourceFile),
      imports: collected.named,
      namespaceImports: collected.namespaces,
      memo: new Map(),
      intrinsics: session.intrinsics,
      externals,
      crossFileFailures: failures,
      importCache: session.importCache,
      resolvePathCache: session.resolvePathCache,
    };

    const entities: FoldedEntity[] = [];
    const exportedValues = new Map<string, unknown>();

    for (const decl of scan.declarators) {
      if (decl.kind === "resource") {
        const result = await resolveResourceEntity(decl.name, decl.node, ctx);
        if (!result.ok) return result;
        applyResolvedValue(decl.name, result.entity, entities, exportedValues);
        continue;
      }

      if (decl.kind === "single") {
        let value: unknown;
        try {
          value = (await resolveDeclaratorValue(decl.node, ctx)).value;
        } catch (err) {
          return { ok: false, reason: `"${decl.name}" is not foldable: ${describeFoldFailure(err, ctx)}` };
        }
        applyResolvedValue(decl.name, value, entities, exportedValues);
        continue;
      }

      if (decl.kind === "destructure") {
        let value: unknown;
        try {
          value = (await resolveDeclaratorValue(decl.node, ctx)).value;
        } catch (err) {
          return {
            ok: false,
            reason: `destructured export from "${decl.node.getText()}" is not foldable: ${describeFoldFailure(err, ctx)}`,
          };
        }
        if (!isIndexableObject(value)) {
          return {
            ok: false,
            reason: `destructured export from "${decl.node.getText()}" is not foldable (not a composite call or object)`,
          };
        }
        for (const { propKey, bindingName } of decl.elements) {
          applyResolvedValue(bindingName, value[propKey], entities, exportedValues);
        }
        continue;
      }

      if (decl.kind === "named-export") {
        // Reuses resolveDeclaratorValue's own identifier handling
        // (ctx.locals/ctx.externals lookup + memoized destructured-member
        // extraction) rather than duplicating it here.
        for (const { localNameNode, exportedName } of decl.elements) {
          let value: unknown;
          try {
            value = (await resolveDeclaratorValue(localNameNode, ctx)).value;
          } catch (err) {
            return { ok: false, reason: `exported "${exportedName}" is not foldable: ${describeFoldFailure(err, ctx)}` };
          }
          applyResolvedValue(exportedName, value, entities, exportedValues);
        }
        continue;
      }

      // decl.kind === "re-export" (chant #1020) — resolve each element
      // through the target module's OWN fold, memoized via the session
      // exactly like any other cross-file reference (see `foldFileMemoized`
      // above); a cycle surfaces here too since a re-export is just another
      // edge in the same module graph.
      let targetPath: string;
      try {
        targetPath = resolveModulePathMemoized(decl.specifier, file, session.resolvePathCache);
      } catch (err) {
        return {
          ok: false,
          reason: `could not resolve re-export "${decl.specifier}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const result = await foldFileMemoized(targetPath, session);
      if (!result.ok) {
        return {
          ok: false,
          reason: `re-export from "${decl.specifier}" is not foldable: ${locatedMessage(decl.specifierNode, result.reason)}`,
        };
      }
      for (const { imported, exportedName } of decl.elements) {
        if (!result.exportedValues.has(imported)) {
          return {
            ok: false,
            reason: locatedMessage(decl.specifierNode, `"${imported}" is not exported by "${decl.specifier}"`),
          };
        }
        applyResolvedValue(exportedName, result.exportedValues.get(imported), entities, exportedValues);
      }
    }

    return { ok: true, entities, exportedValues };
  } catch (err) {
    // Any unexpected failure degrades to "fall back to run" rather than
    // taking discovery down with it — fold is opt-in, not a new failure mode.
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Attempt to fold one source file with zero execution of its own top-level
 * code. Returns the folded, instantiated entities on success, or a reason
 * to fall back to the run path (`importModule`) on the first construct
 * outside the fold subset.
 *
 * @param intrinsics - Lexicon-registered intrinsic tags (chant #1039), e.g.
 *   AWS's `Sub`. Threaded down to {@link fold}/{@link foldResource} so a
 *   registered tagged template folds instead of unconditionally throwing
 *   "unregistered tagged template intrinsic". Defaults to none — the caller
 *   (`discover()`, ultimately `chant build --fold`) is expected to pass the
 *   target lexicons' combined `intrinsics()`. Ignored when `session` is
 *   given (its own `intrinsics`, fixed at creation, apply instead).
 * @param session - chant #1020: share ONE {@link FoldSession} across every
 *   file in a build (as `discover()` does) so a project file imported by
 *   several others folds exactly once and every referrer shares the same
 *   constructed entities — see {@link FoldSession}'s doc. Omit for a
 *   standalone, single-file fold attempt (creates a private session scoped
 *   to just this call — a cross-file reference reachable from `file` still
 *   resolves, just without sharing its cache with any other top-level call).
 */
export async function tryFoldFile(
  file: string,
  intrinsics: readonly IntrinsicDef[] = [],
  session?: FoldSession,
): Promise<FoldFileResult> {
  return foldFileMemoized(file, session ?? createFoldSession(intrinsics));
}

// ─────────────────────────────────────────────────────────────────────────
// Cross-file fold/run identity hazard (#1023).
// ─────────────────────────────────────────────────────────────────────────

/**
 * A file that folds successfully in isolation must still be forced back to
 * run if some OTHER discovered file — one that itself falls back to run —
 * imports it (directly, or transitively through another sibling file it
 * imports). Composite folding is what makes this reachable: `network.ts`
 * exporting `export const network = VpcDefault({})` folds cleanly on its
 * own (no cross-file reference needed), landing its Declarables (`vpc`, its
 * subnets, …) in `entities` as ONE set of real objects, built by literally
 * invoking `VpcDefault` from inside `tryFoldFile` — bypassing `network.ts`
 * as a module entirely (that's the whole point of folding it).
 *
 * Before chant #1020, a sibling file like `alb.ts` that did
 * `import { network } from "./network"; ... vpcId: network.vpc.VpcId`
 * could never fold that cross-file reference and fell back to run — but
 * running `alb.ts` for real re-executes `import "./network"` for real too,
 * which (via Node's module cache) produces the SAME `network.ts` module
 * instance for every OTHER run-fallback file that imports it, but a
 * DIFFERENT one than the object `tryFoldFile("network.ts")` already built.
 * `alb.ts`'s AttrRef for `network.vpc.VpcId` then points at an object
 * that's never in the `entities` map (only the folded one is), so it can
 * never be assigned a logical name and serialization fails outright — not
 * drift, a crash.
 *
 * The fix: fold and run must never disagree about which object identity a
 * given file's exports have. Since `network.ts` itself doesn't need
 * anything cross-file to fold (only a file's own successful fold could ever
 * reach this taint — an unresolvable cross-file reference already fails
 * that file's OWN fold attempt), the safe rule is to force `network.ts`
 * back to run too, so both `alb.ts`'s real import and `network.ts`'s own
 * discovery entry resolve through the exact same `importModule` call and
 * share the exact same singleton module instance. This has to propagate
 * transitively (if `alb.ts` itself is only reachable by importing a file
 * that imports `network.ts`), so this is a forward-reachability walk over
 * the discovered files' relative-import graph, seeded from every file that
 * doesn't fold on its own.
 *
 * chant #1020 changes the calculus but not this function: `alb.ts` can now
 * often fold `network.vpc.VpcId` too (see `buildExternals`/`foldFileMemoized`
 * above), by reusing THE EXACT SAME `tryFoldFile("network.ts")` call (memoized
 * per `FoldSession`) that `discover()`'s own per-file loop also uses — so
 * `alb.ts` and `network.ts` share one real `vpc` object without ever
 * disagreeing. This invariant is still needed for whatever STILL falls back
 * after #1020 (a call-as-a-value construct, #1044; a shape #1020 doesn't
 * cover): the edge collection below is unconditional — it doesn't care
 * whether an edge happens to ALSO be used for cross-file value resolution —
 * so the exact same forced-taint safety net still applies to that remaining
 * boundary, unchanged.
 */
export async function planFoldTaint(
  files: readonly string[],
  wouldFold: ReadonlyMap<string, boolean>,
): Promise<Set<string>> {
  const fileSet = new Set(files);

  // file -> set of OTHER discovered files it relatively imports OR re-exports
  // from, regardless of that file's own fold outcome (taint needs the full
  // edge set to propagate transitively). chant #1020 — this now ALSO counts
  // a namespace import (`import * as ns from "./x"`, previously skipped —
  // see `collectImports`) and a re-export (`export { x } from "./y"`, which
  // `collectImports` never saw at all, since it only looks at `import`
  // declarations): both are real cross-file value dependencies my own new
  // resolution follows, so both need the same identity guarantee an
  // ordinary named import already got.
  const edges = new Map<string, Set<string>>();
  for (const file of files) {
    const targets = new Set<string>();
    const addTarget = (specifier: string): void => {
      if (!isProjectFileSpecifier(specifier)) return; // package import, not a sibling source file
      let resolved: string;
      try {
        resolved = resolveModulePath(specifier, file);
      } catch {
        return;
      }
      if (fileSet.has(resolved)) targets.add(resolved);
    };
    try {
      const source = await readFile(file, "utf-8");
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const collected = collectImports(sourceFile);
      for (const binding of collected.named.values()) addTarget(binding.specifier);
      for (const binding of collected.namespaces.values()) addTarget(binding.specifier);
      for (const statement of sourceFile.statements) {
        if (
          ts.isExportDeclaration(statement) &&
          !statement.isTypeOnly &&
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          addTarget(statement.moduleSpecifier.text);
        }
      }
    } catch {
      // Unreadable/unparseable — no edges contributed; tryFoldFile's own
      // top-level catch already turns this into a "run" decision for the
      // file itself, which is enough to seed it as tainted below.
    }
    edges.set(file, targets);
  }

  const tainted = new Set<string>(files.filter((f) => wouldFold.get(f) !== true));
  const queue = [...tainted];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const target of edges.get(current) ?? []) {
      if (!tainted.has(target)) {
        tainted.add(target);
        queue.push(target);
      }
    }
  }

  return tainted;
}
