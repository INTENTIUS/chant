import * as ts from "typescript";
import { readFile } from "node:fs/promises";
import { existsSync, statSync, readFileSync, realpathSync } from "node:fs";
import { dirname, basename, join, sep, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isDeclarable, type Declarable } from "../declarable";
import { Composite, isCompositeInstance, type CompositeInstance, type CompositeMembers } from "../composite";
import { isAttrRefLike } from "../utils";
import { isIntrinsic } from "../intrinsic";
import {
  collectConsts,
  foldResource,
  fold,
  propName,
  FoldError,
  FoldableFunction,
  isFoldableFunction,
  locate,
  type FoldedResource,
  type FoldedValue,
  type FoldedIntrinsic,
  type FoldedHelperCall,
  type SymbolicValue,
  type FoldedCompositeStepCall,
} from "../fold/fold";
import { isChantOwnedSpecifier, isFoldableHelperName } from "../fold/foldable-helpers";
import {
  briefNodeText,
  callExpressionMessage,
  computedPropertyNameMessage,
  isLiteralElementKey,
  unsupportedBinaryMessage,
  unsupportedExpressionMessage,
  UNSUPPORTED_OBJECT_MEMBER_MESSAGE,
  UNSUPPORTED_UNARY_MESSAGE,
  SUPPORTED_BINARY_OPERATORS,
  SUPPORTED_UNARY_OPERATORS,
} from "../fold/subset";
import { importModule } from "./import";
import { collectParamDependencies } from "./param-deps";
import { setPathProvenance } from "../provenance";
import { intrinsicCallFoldsEagerly, type IntrinsicDef } from "../lexicon";
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
 * chant #1022 extends this from leaf resources (`new Type(...)`) to composite
 * factory calls — `SomeComposite({...})`,
 * `propagate(SomeComposite({...}), {...})`, member access on the result
 * (`web.deployment`), and destructuring (`const { a, b } = SomeComposite(...)`
 * or `export const { a, b } = SomeComposite(...)`). A composite factory is a
 * pure function of its props (EVL009/EVL010 guarantee its body only
 * references props, sibling members, and imports), so — exactly like a
 * resource constructor — it is resolved through the file's imports and
 * INVOKED with statically-folded props, and the RESULT is what matters: if it
 * satisfies {@link isCompositeInstance} (or, for a plain resource-returning
 * helper, {@link isDeclarable}), it's used. Nested composites and
 * `propagate()`'d shared props need no special-casing there: a nested
 * composite is just another member the real factory call already produced,
 * and `propagate` is just another resolvable imported function that receives a
 * live `CompositeInstance` plus folded shared props and returns it —
 * `expandComposite()` (invoked downstream by `collectEntities`, unchanged)
 * does the recursive expansion and the shared-prop merge exactly as it does
 * for the run path.
 *
 * chant #1023 (epic #1019 Phase 5) removes that invocation where it can. When
 * the callee is a composite defined in a PROJECT file as
 * `Composite(<fn>, "<name>")` and `<fn>`'s body stays inside a closed,
 * documented subset, its body is INTERPRETED instead — the defining module is
 * never imported, and the members are built here, by the lexicon's own
 * constructors, from the same folded props. That closes the last place a file
 * reported as `[fold:fold]` could still execute project-authored code in the
 * CLI's process (#1093), and lets such a file fold under `--sandbox` rather
 * than being demoted to the child (#1111). A factory outside the subset keeps
 * invoking, unchanged. See the contract block above
 * {@link resolveInterpretableFactory} for the five admissibility rules and
 * what interpretation preserves.
 */

/** One exported `const` name folded to a real, constructed `Declarable` or `CompositeInstance`. */
export type FoldedEntity = [name: string, entity: Declarable | CompositeInstance];

export type FoldFileResult =
  | {
      ok: true;
      /**
       * The `Declarable`/`CompositeInstance` subset of {@link
       * FoldFileResult.exportedValues} — how many resources this file
       * contributed, for the `[fold:fold] x.ts — N resource(s)` decision
       * line. chant #1112: NOT what discovery collects from. Collection
       * reads `exportedValues`, so that `./collect.ts` stays the single
       * owner of which exports become entities — see {@link
       * applyResolvedValue}.
       */
      entities: FoldedEntity[];
      /**
       * chant #1020 — EVERY exported name's fully-resolved value, not just
       * the `Declarable`/`CompositeInstance` ones also listed in `entities`:
       * a plain value folds too (a string, a number, a plain object). A
       * successful fold means `scanExports` recognized every export the file
       * has (anything else disqualifies the whole file), so this IS the
       * file's complete export namespace — the same table the run path gets
       * from actually importing it. Two consumers: `discover()` passes it
       * straight to `collectEntities` (chant #1112), and another file's
       * cross-file reference resolves against it — see `buildExternals`
       * below and the module doc on `planFoldTaint` for why a
       * resource/composite value here MUST be the exact same object every
       * referencing file sees.
       */
      exportedValues: Map<string, unknown>;
      /**
       * chant #1044 — the OTHER project files whose exported OBJECTS this
       * fold consumed (a cross-file `Declarable`, composite instance, or any
       * other non-primitive reached through `buildExternals`/a re-export).
       *
       * Object identity is the thing that cannot survive one side of the
       * build folding while the other runs, so `planFoldTaint` needs to know
       * who consumed whose objects: if a file here is forced back to run, the
       * instance THIS file already captured is not the instance discovery
       * will collect, and serialization fails on an entity with no logical
       * name. A primitive (string, number, boolean, null) is never recorded —
       * it has no identity to disagree about.
       */
      liveSources: ReadonlySet<string>;
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
  /**
   * chant #1063 — the exact package specifiers of the lexicons LOADED for
   * this build (`@intentius/chant-lexicon-aws`, …), derived from the lexicon
   * names the build already resolved (`resolveProjectLexicons` ->
   * `loadPlugins`, see ../cli/plugins.ts). This is the entire allowlist
   * {@link buildExternals} will follow a bare import specifier into — see
   * {@link activeLexiconPackage} for why the set is matched by TEXT and
   * built from names the build already knows, rather than by resolving
   * specifiers to find out what they are.
   *
   * Empty when the caller supplied no lexicon list, which disables
   * lexicon-package resolution entirely rather than falling back to
   * something more permissive: "an active lexicon of this build" is the
   * boundary, and a build that can't say what its lexicons are hasn't
   * established one.
   */
  readonly lexiconPackages: ReadonlySet<string>;
  /**
   * chant #1093 — this build asked for the #1045 sandbox
   * (`DiscoveryOptions.sandbox`, `chant build --sandbox`), so fold must not
   * import or invoke a module the CLI process isn't already trusted to
   * execute. See {@link isTrustedExecutableBinding} for what that allowlist
   * is and {@link sandboxedExecutionRefusal} for what happens at each site
   * that would otherwise execute one.
   *
   * `false` (the default, plain `--fold`) leaves every resolution path
   * exactly as it was: fold already trusts the code enough to fall back to
   * an in-process `importModule` when it can't fold something, so gating
   * only the fold half would buy nothing there.
   */
  readonly sandbox: boolean;
  /**
   * chant #1023 — per-build memo for {@link readFactoryModule}, keyed by the
   * resolved absolute path of a module that DEFINES a composite. A composite
   * defined once and called from a dozen sibling files is parsed, and its
   * imports resolved, exactly once per build — the same reason
   * {@link FoldSession.cache} exists for the files discovery folds directly.
   *
   * Separate from `cache` because the two ask different questions of the same
   * file: `cache` asks "what are this module's exported VALUES" (and fails
   * outright for a module that exports a function declaration, which a
   * composite-defining module very often does); this asks "what is this
   * module's static SCOPE" — its consts, its imports, and those imports'
   * already-resolved values — which is well-defined even when the module as a
   * whole doesn't fold. `lexicons/aws/examples/lambda-api/src/lambda-api.ts`
   * is exactly that case: it exports two plain functions alongside its
   * `Composite`, so it never folds, and its `LambdaApi` is interpretable
   * regardless.
   */
  readonly factoryModules: Map<string, Promise<FactoryModuleScope | undefined>>;
}

/**
 * chant #1063 — the package specifier a lexicon NAME (`"aws"`, `"gitlab"`)
 * is installed under. The one naming convention the whole CLI already
 * depends on: `loadPlugin(name)` imports exactly this
 * (../cli/plugins.ts), `detectLexicons` scans source for exactly this
 * (../detectLexicon.ts), and `chant init` writes exactly this into
 * package.json.
 */
export function lexiconPackageName(lexiconName: string): string {
  return `@intentius/chant-lexicon-${lexiconName}`;
}

/**
 * Create a fresh, empty {@link FoldSession}.
 *
 * @param lexicons - chant #1063: the lexicon NAMES active for this build
 *   (`["aws", "k8s"]`). Converted to package specifiers via
 *   {@link lexiconPackageName}; see {@link FoldSession.lexiconPackages}.
 * @param sandbox - chant #1093: this build asked for the #1045 sandbox, so
 *   fold may not import or invoke anything outside the trusted allowlist —
 *   see {@link FoldSession.sandbox}.
 */
export function createFoldSession(
  intrinsics: readonly IntrinsicDef[] = [],
  buildParams?: Readonly<Record<string, BuildParamValue>>,
  lexicons: readonly string[] = [],
  sandbox = false,
): FoldSession {
  return {
    intrinsics,
    cache: new Map(),
    stack: [],
    importCache: new Map(),
    resolvePathCache: new Map(),
    buildParams,
    lexiconPackages: new Set(lexicons.map(lexiconPackageName)),
    sandbox,
    factoryModules: new Map(),
  };
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

// ─────────────────────────────────────────────────────────────────────────
// Execution accounting (chant #1023).
// ─────────────────────────────────────────────────────────────────────────

/**
 * What the fold pass actually EXECUTED, and what it interpreted instead — the
 * number chant #1023 is measured by, and the one the #1093/#1111
 * execution-boundary report could not state before: `--sandbox` proves
 * *nothing project-owned ran in this process*, but plain `--fold` still
 * invoked composite factories in-process, and nothing counted them.
 *
 * Purely observational. Two integer increments on paths that were already
 * about to perform a dynamic `import()` or parse a module, so it costs
 * nothing measurable and changes no decision.
 */
export interface FoldExecutionCounts {
  /**
   * Composite-factory / wrapper calls {@link resolveCallExpression} resolved
   * by importing the defining module and CALLING it in this process.
   */
  factoryInvocations: number;
  /**
   * Of {@link factoryInvocations}, the ones whose callee came from a PROJECT
   * FILE (a relative/absolute specifier) rather than a lexicon package or
   * chant's own — i.e. the ones that execute project-authored code here. Text
   * only ({@link isProjectFileSpecifier}); no resolution is performed to
   * classify.
   */
  projectFactoryInvocations: number;
  /**
   * Composite factory bodies {@link interpretCompositeFactory} evaluated
   * statically instead — each one an invocation that did NOT happen.
   */
  factoryInterpretations: number;
}

const executionCounts: FoldExecutionCounts = {
  factoryInvocations: 0,
  projectFactoryInvocations: 0,
  factoryInterpretations: 0,
};

/** A snapshot of {@link FoldExecutionCounts}. Process-wide and monotonic — a caller wanting a per-build figure calls {@link resetFoldExecutionCounts} first. */
export function foldExecutionCounts(): Readonly<FoldExecutionCounts> {
  return { ...executionCounts };
}

/** Zero {@link foldExecutionCounts}, for a caller measuring one build. */
export function resetFoldExecutionCounts(): void {
  executionCounts.factoryInvocations = 0;
  executionCounts.projectFactoryInvocations = 0;
  executionCounts.factoryInterpretations = 0;
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

/** `export function name(...) {...}` (chant #1373) — exported as a {@link FoldableFunction} marker so an importer can fold a call to it. The body's own foldability is judged at the CALL, never here: an unfoldable helper nobody calls from foldable source costs its module nothing. */
interface FunctionDeclarator {
  kind: "function";
  name: string;
}

type ScanDeclarator =
  | ResourceDeclarator
  | FunctionDeclarator
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
 * chain, #1020), and `export function name(...) {...}` (a foldable-function
 * export, #1373). Any OTHER export construct (`export default`, `export *
 * from`, an exported class, `let`/`var`, a destructured export with
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
      // chant #1373 — a named, bodied exported function is a foldable-function
      // export (see {@link FunctionDeclarator}). An overload signature has no
      // body and no value of its own — skipped, the implementation that
      // follows it is the export. `export default function` has no name an
      // importer could bind and stays a disqualifier, like `export default`.
      if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) || !statement.name) {
        return { declarators, unfoldableReason: "`export default` is not foldable" };
      }
      if (!statement.body) continue;
      declarators.push({ kind: "function", name: statement.name.text });
      continue;
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

/** `(x) => …` / `function (x) {…}`, possibly wrapped in parens/`as`/`satisfies` — the initializer shapes that make a `const` a function binding. */
function unwrapFunctionInitializer(node: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return ts.isArrowFunction(current) || ts.isFunctionExpression(current) ? current : undefined;
}

/**
 * chant #1373 — every top-level function a file declares, exported or not, as
 * a {@link FoldableFunction}: `function f(...) {...}` and `const f = (...) =>
 * …`. Placed in the file's own `externals` (so a same-file call folds, and a
 * sibling function can call it) and exported under its name (so an importer's
 * `buildExternals` can). The marker carries the file's scope BY REFERENCE:
 * `ctx.externals` is still being filled (pre-built resources land in it after
 * this runs) and a body reads it only when called.
 *
 * The marker's `consts` drops every `new`-bound const (transitively, through
 * aliases) — see {@link FoldableFunction.consts} for why a body must reach a
 * module-level resource through `externals` only.
 */
function collectLocalFunctions(sourceFile: ts.SourceFile, ctx: ResolveCtx): Map<string, FoldableFunction> {
  const consts = new Map(ctx.consts);
  for (const [name] of [...consts]) {
    if (constResolvesToResource(ctx.consts, name, new Set())) consts.delete(name);
  }
  const functions = new Map<string, FoldableFunction>();
  const add = (name: string, fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): void => {
    functions.set(name, new FoldableFunction(name, fn, ctx.file, consts, ctx.externals, ctx.crossFileFailures));
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name && statement.body) add(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const fn = unwrapFunctionInitializer(decl.initializer);
      if (fn) add(decl.name.text, fn);
    }
  }
  return functions;
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
 * chant #1064 — the one real published subpath a project imports chant's
 * build-time-parameters module from. {@link buildExternals} matches a bare
 * specifier against this by TEXT ONLY, never by resolving it — see that
 * function's own comment for why resolving an arbitrary bare specifier here
 * would reintroduce the exact pathological cold-resolution cost chant#1020
 * already fixed once (this module's other comments measure it at up to
 * ~361s for the first resolution of a genuinely new bare specifier).
 */
const PARAMS_BARE_SPECIFIER = "@intentius/chant/params";

/**
 * chant #1064 — the absolute path of chant-core's OWN build-time-parameters
 * runtime module (../params.ts), resolved lazily on first use, from THIS
 * file's own location, via the exact same relative-specifier resolution
 * {@link resolveModulePath} already applies to project files — cheap
 * (`existsSync`/`statSync` candidate probing only, never Node's package
 * resolution). Used by {@link buildExternals} to recognize a RELATIVE/
 * ABSOLUTE import of the params module (this module's own test fixtures use
 * an absolute path, matching the rest of this file's test convention) — a
 * real project's bare `@intentius/chant/params` import is instead matched by
 * {@link PARAMS_BARE_SPECIFIER}'s text alone, never through this path.
 *
 * Lazy and failure-safe, NOT a module-scope constant: this module is also
 * bundled into the #1045 sandbox child, where module-init code runs inside
 * `--permission` with a read allowlist. There `import.meta.url` is the
 * bundle's temp-dir path, so an init-time probe reaches for `<tmp>/params` —
 * outside the allowlist — and the `existsSync` throws `ERR_ACCESS_DENIED`,
 * killing the child before it reports (a real, observed sandbox-vs-run error
 * drift across six corpus entries). The child runs only the run path and
 * never calls {@link buildExternals}, so deferring the probe to first fold
 * use keeps it out of the sandbox entirely; if probing still fails there,
 * `null` just disables the relative-path recognition rather than erroring.
 */
let paramsModulePathMemo: string | null | undefined;
function paramsModulePath(): string | null {
  if (paramsModulePathMemo === undefined) {
    try {
      paramsModulePathMemo = resolveModulePath("../params", fileURLToPath(import.meta.url));
    } catch {
      paramsModulePathMemo = null;
    }
  }
  return paramsModulePathMemo;
}

/**
 * chant #1063 — is `specifier` a bare import of a package that is an ACTIVE
 * LEXICON of this build? Returns the specifier itself when so, `undefined`
 * otherwise.
 *
 * Three deliberate restrictions, each of which is the point rather than an
 * omission:
 *
 *  - **Text only, no resolution.** The answer is a `Set.has` on a set built
 *    from the lexicon names the build ALREADY resolved before discovery ran
 *    (`resolveProjectLexicons` -> `loadPlugins`). Nothing is probed, read, or
 *    resolved to decide whether a specifier is in scope — so an import of
 *    some unrelated package costs a string comparison and is then left alone,
 *    never resolved "just to find out what it is". That matters here more
 *    than anywhere: `resolveModulePath`'s bare branch can fall through to
 *    `createRequire(fromFile).resolve(specifier)`, measured at up to ~361s
 *    for the first resolution of a genuinely new bare specifier in a process
 *    (see {@link bareSpecifierPathCache}/{@link fastResolveBareSpecifier} —
 *    this exact class of cost regressed twice during chant#1020).
 *
 *  - **Exact package specifier, no subpaths.** `@intentius/chant-lexicon-aws`
 *    matches; `@intentius/chant-lexicon-aws/actions` does not. Every lexicon
 *    re-exports its whole public surface from its barrel and every example
 *    imports it that way, so subpaths buy nothing — and they would cost
 *    something real: {@link fastResolveBareSpecifier} only recognizes a
 *    package ROOT (it looks for `<node_modules>/<specifier>/package.json`),
 *    so a subpath specifier falls through to exactly the slow
 *    `createRequire().resolve()` path this restriction exists to avoid.
 *
 *  - **Lexicons of THIS build only.** Not "any `@intentius/chant-lexicon-*`
 *    package on disk", and emphatically not "any bare specifier". A lexicon
 *    the build did not load is as out of scope as `node:fs`.
 */
function activeLexiconPackage(specifier: string, lexiconPackages: ReadonlySet<string>): string | undefined {
  return lexiconPackages.has(specifier) ? specifier : undefined;
}

/**
 * chant #1063 — resolve one named import binding against an active lexicon
 * package's REAL exports, for {@link buildExternals}.
 *
 * The lexicon module is imported (through the session-wide
 * {@link FoldSession.importCache}, so at most one real `import()` per package
 * per build) and the requested export read straight off it. That is the same
 * module object the run path gets — `importModule` is a plain dynamic
 * `import()` with no cache-busting — so what fold captures here is not a
 * reconstruction of the lexicon's data but the identical value, down to
 * object identity for `Azure.ResourceGroupLocation`-style singletons. It is
 * also the same two-step (resolve path, then import) that
 * `resolveImportedExport` has always used to reach a lexicon's constructors
 * and intrinsic functions; the only thing new is that a plain DATA export is
 * now reachable too.
 *
 * Callable exports are otherwise excluded. A lexicon's functions — its
 * resource classes, composite factories, intrinsic implementations — already
 * have dedicated resolution paths that know how to INVOKE them
 * (`resolveResourceEntity`, `resolveCallExpression`, `reviveFoldedValue`), and
 * binding an arbitrary one as a plain identifier value here would widen what
 * folds in unmeasured ways. The one exception (chant #1966) is a function its
 * lexicon registered with {@link IntrinsicDef.foldsEagerly} — the same
 * per-name, lexicon-declared opt-in `foldsAsCall` is for an intrinsic's
 * envelope-and-revive form, admitting this one because `fold()`
 * (../fold/fold.ts) needs to CALL it eagerly — synchronously, before
 * revival — to support a lexicon's own string-building helpers used inline
 * (`matrix("os").toString()`, `` `${inputs("x")}` ``), where an envelope
 * would still be a plain object when the enclosing template folds.
 *
 * Returns `undefined` — never throws — for a package that isn't an active
 * lexicon, an export the package doesn't have, a non-admitted callable
 * export, or an import that fails. The binding is then simply absent from
 * `externals`, exactly as before, and `fold()`'s ordinary "unresolved
 * identifier" failure still fires if the name is actually referenced.
 */
async function resolveActiveLexiconExport(
  binding: ImportBinding,
  fromFile: string,
  session: FoldSession,
): Promise<{ value: unknown } | undefined> {
  if (!activeLexiconPackage(binding.specifier, session.lexiconPackages)) return undefined;

  let modulePath: string;
  try {
    modulePath = resolveModulePathMemoized(binding.specifier, fromFile, session.resolvePathCache);
  } catch {
    return undefined;
  }

  let mod: Record<string, unknown>;
  try {
    mod = await importModuleMemoized(modulePath, session.importCache);
  } catch {
    return undefined;
  }

  if (!(binding.imported in mod)) return undefined;
  const value = mod[binding.imported];
  if (typeof value === "function") {
    const eager = session.intrinsics.some((i) => i.name === binding.imported && intrinsicCallFoldsEagerly(i));
    if (!eager) return undefined;
  }
  return { value };
}

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
  /**
   * chant #1063 — this build's active lexicon PACKAGE specifiers (see
   * {@link FoldSession.lexiconPackages}). Threaded down here, not just used
   * in `buildExternals`, because chant #1093's trust check
   * ({@link isTrustedExecutableBinding}) needs the same allowlist at every
   * site that imports and executes a module.
   */
  lexiconPackages: ReadonlySet<string>;
  /** chant #1093 — see {@link FoldSession.sandbox}. */
  sandbox: boolean;
  /**
   * chant #1023 — the whole build session, for the two things composite-factory
   * interpretation needs that a per-file context cannot carry: the
   * {@link FoldSession.factoryModules} memo (a composite's defining module is
   * parsed once per BUILD, not once per calling file) and
   * {@link FoldSession.stack} (so a factory whose module is already being
   * resolved further up the same chain is a detected cycle, not a hang).
   */
  session: FoldSession;
  /**
   * chant #1023 — how many composite factory bodies are being interpreted
   * around this context, 0 at a file's own top level. A composite that
   * (directly or through its members) calls itself has no fixpoint and no file
   * boundary for {@link FoldSession.stack} to notice, so this is what
   * terminates it — see {@link MAX_INTERPRETATION_DEPTH}.
   */
  interpretDepth: number;
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
        const external = ctx.externals.get(node.text);
        // chant #1373 — a function marker is callable, never a value. The
        // export-by-name cases (`export const g = f`, `export { f }`) are
        // handled by the declarator loop before it gets here.
        if (isFoldableFunction(external)) {
          throw cheapError(`function "${node.text}" used as a value is not foldable`);
        }
        return { value: external };
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
 * Resolve a bare call expression — a composite factory call
 * (`SomeComposite({...})`) or a wrapper that takes a composite instance and
 * returns one (`propagate(SomeComposite({...}), {...})`). The callee must be
 * a plain identifier bound by this file's own `import` (a namespace-import
 * call like `ns.Foo(...)`, or a call to a function/composite DEFINED in this
 * same file, can't be resolved without running the file — falls back, same
 * as an unresolvable resource constructor).
 *
 * Two ways to get the value, tried in that order:
 *
 * 1. **Interpretation** (chant #1023) — the callee is an interpretable
 *    registered `Composite` defined in a PROJECT file, so its body is
 *    evaluated statically and nothing is imported or run. See
 *    {@link resolveInterpretableFactory} for the exact admissible subset.
 * 2. **Invocation** (chant #1022) — everything else. Each argument is
 *    resolved (recursively, for a nested composite-call/member-access
 *    argument like `propagate`'s first one) or folded (for a plain props
 *    object literal via {@link fold}), the real function is imported and
 *    invoked, and the RESULT is what matters to the caller —
 *    {@link resolveLiveValue}'s callers decide what shape they need (a
 *    `CompositeInstance` for member access, an
 *    `isDeclarable`/`isCompositeInstance` value for a top-level export).
 *    No pre-check verifies the resolved callee is "really" a composite.
 *
 * Arm 2 is untouched by #1023, including for a factory arm 1 STARTED and then
 * declined on: interpretation is all-or-nothing per call, and a decline is not
 * a fold failure — it lands exactly where the code landed before this existed.
 */
async function resolveCallExpression(node: ts.CallExpression, ctx: ResolveCtx): Promise<unknown> {
  // chant #1054 — reuses ../fold/subset's `callExpressionMessage` (the SAME
  // builder `fold()` throws with for a call used as a prop value) rather
  // than a hand-written "call expression as a value" copy: the two used to
  // say different things for the identical rejection, which silently broke
  // any tooling grouping fallback reasons by text.
  if (!ts.isIdentifier(node.expression)) {
    throw cheapError(callExpressionMessage(node));
  }
  const calleeName = node.expression.text;
  const binding = ctx.imports.get(calleeName);

  // chant #1373 — a project-local function with a foldable body (declared in
  // this file, or imported from a sibling project file) is evaluated
  // statically, through the same `fold()` branch a NESTED call to it takes.
  // When its body turns out not to fold, an IMPORTED callee still has the
  // pre-#1373 path below (interpret as a composite, else import and invoke) —
  // a helper that wraps a composite call, say, keeps folding by invocation
  // exactly as it did. A same-file callee has nothing to invoke without
  // running the file, so the fold diagnostic is the verdict.
  const local = ctx.externals.get(calleeName);
  if (isFoldableFunction(local)) {
    let foldFailure: Error | undefined;
    try {
      const folded = fold(node, ctx.consts, ctx.intrinsics, ctx.externals);
      return await reviveFoldedValue(folded, ctx, false);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      foldFailure = err;
    }
    if (!binding) throw foldFailure;
    try {
      return await resolveImportedCall(node, calleeName, binding, ctx);
    } catch (err) {
      throw cheapError(
        `${foldFailure.message}; invoking it instead failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!binding) {
    throw cheapError(callExpressionMessage(node));
  }
  return resolveImportedCall(node, calleeName, binding, ctx);
}

/** The pre-#1373 two-arm resolution of an IMPORTED callee — see {@link resolveCallExpression}. */
async function resolveImportedCall(
  node: ts.CallExpression,
  calleeName: string,
  binding: ImportBinding,
  ctx: ResolveCtx,
): Promise<unknown> {
  // chant #1023 — is this callee a composite whose body can be INTERPRETED
  // rather than run? Purely a static question (does the defining module parse,
  // does it declare this export as `Composite(<fn>, "<name>")`, is `<fn>`'s
  // body inside the admissible subset) — no argument has been evaluated yet
  // and nothing has been imported, so a `undefined` here has cost nothing and
  // changed nothing.
  const factory = await resolveInterpretableFactory(binding, ctx);

  if (factory) {
    const args = await resolveCallArguments(node, calleeName, ctx);
    const interpreted = await interpretCompositeFactory(factory, args, ctx);
    if (interpreted) return interpreted.value;
    // Declined — the body's shape passed but something in it did not resolve
    // (an identifier the module's own imports don't reach, a constructor
    // --sandbox refuses). Fall through to arm 2 with the arguments ALREADY
    // evaluated, so a nested composite-call argument is not built twice.
    return invokeImportedCallee(node, calleeName, binding, ctx, args);
  }

  return invokeImportedCallee(node, calleeName, binding, ctx);
}

/**
 * Arm 2 — import the module the callee came from and call it, in this
 * process, given ALREADY-RESOLVED argument values. Factored out of
 * {@link invokeImportedCallee} (chant #1174) so a caller with no raw
 * `ts.CallExpression` node — {@link resolveCompositeCall}, the nested-value
 * counterpart to {@link resolveCallExpression} — can reach the identical
 * refusal/resolve/import/callable-check/call sequence #1022 established,
 * without inventing a second copy of it.
 */
async function invokeResolvedCallee(
  calleeName: string,
  binding: ImportBinding,
  ctx: ResolveCtx,
  args: readonly unknown[],
): Promise<unknown> {
  // chant #1093 — THE gap this check exists for. Invoking the callee runs
  // project code (the factory body, and its whole module's top level) in the
  // CLI's own process; under --sandbox that has to happen in the child
  // instead, so refuse here and let the file fall back to the sandboxed run
  // path. See {@link sandboxedExecutionRefusal}.
  const refusal = sandboxedExecutionRefusal(binding, ctx, calleeName, "composite factory");
  if (refusal) throw cheapError(refusal);

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

  executionCounts.factoryInvocations += 1;
  if (isProjectFileSpecifier(binding.specifier)) executionCounts.projectFactoryInvocations += 1;

  return (Fn as (...fnArgs: unknown[]) => unknown)(...args);
}

/**
 * Arm 2's original entry point — a raw call-expression node in hand. Resolves
 * arguments (unless the caller already has them) and delegates to
 * {@link invokeResolvedCallee}. Unchanged from #1022 in both behavior and
 * ORDER (refusal, resolve, import, callable check, arguments, call); #1023
 * factored the body out once already, #1174 a second time.
 *
 * @param args - Already-evaluated arguments, when the caller has them.
 */
async function invokeImportedCallee(
  node: ts.CallExpression,
  calleeName: string,
  binding: ImportBinding,
  ctx: ResolveCtx,
  args?: readonly unknown[],
): Promise<unknown> {
  const callArgs = args ?? (await resolveCallArguments(node, calleeName, ctx));
  return invokeResolvedCallee(calleeName, binding, ctx, callArgs);
}

/**
 * Resolve a composite-factory call used as a NESTED value — chant #1174's
 * `<Identifier>(...).step` idiom ({@link FoldedCompositeStepCall}) — given
 * its callee NAME and already-REVIVED argument values. The nested-value
 * counterpart to {@link resolveCallExpression}, which the top-level
 * declarator path (`export const x = Checkout({...})`) already used: the
 * raw `ts.CallExpression` node isn't needed here because
 * {@link resolveInterpretableFactory} only needs the import `binding`, and
 * {@link interpretCompositeFactory}/{@link invokeResolvedCallee} only need
 * the resolved argument values — which `fold()`'s envelope already folded
 * and {@link reviveFoldedValue} has already revived by the time this runs.
 *
 * Same two arms, same order, as the top-level path: interpret a project-file
 * registered `Composite` (chant #1023) when its body qualifies, otherwise
 * import and invoke for real — which is the arm every lexicon-package
 * composite (`Checkout`, `SetupNode`, …) always takes, exactly as it does
 * today for a top-level `export const x = Checkout({...})`. An unbound
 * callee name throws the same "function call as a value" message `fold()`
 * itself would have, for a caller with no `FoldedCompositeStepCall` special
 * case to fall into.
 */
async function resolveCompositeCall(calleeName: string, args: readonly unknown[], ctx: ResolveCtx): Promise<unknown> {
  const binding = ctx.imports.get(calleeName);
  if (!binding) throw cheapError(`unresolved identifier: ${calleeName}`);

  const factory = await resolveInterpretableFactory(binding, ctx);
  if (factory) {
    const interpreted = await interpretCompositeFactory(factory, args, ctx);
    if (interpreted) return interpreted.value;
    // Declined — falls through to arm 2 with the SAME arguments, so a nested
    // composite-call argument (or a live cross-file reference) is not
    // resolved a second time. Identical discipline to `resolveImportedCall`.
  }

  return invokeResolvedCallee(calleeName, binding, ctx, args);
}

/**
 * Resolve a call's arguments to the real values the callee would receive —
 * factored out of {@link resolveCallExpression} (chant #1023) so the
 * interpretation and invocation arms consume ONE evaluation of them. Anything
 * else would evaluate a nested composite-call argument twice and hand the
 * callee the second instance while the first was already wired into an
 * `AttrRef`.
 *
 * chant #1112 — ONE rule for a registered authoring helper's arguments,
 * applied at BOTH sites that can invoke one. `reviveHelperCall` (the
 * nested-value site, #1082) already revives a helper's arguments with
 * `requireLiveRefs`, because a helper reads THROUGH its ref (`output()`
 * derefs the `WeakRef` parent) and a look-alike `{__attrRef}` envelope
 * makes it produce a wrong result rather than none. This site — a
 * top-level `export const oArn = output(bucket.Arn, "oArn")` — took the
 * composite-factory rule (`false`) instead, which is right for a factory
 * (its props keep the envelope, and the serializer's own walker resolves
 * it) and wrong for a helper. It went unnoticed while the resulting
 * `LexiconOutput` was being discarded anyway; with the export namespace
 * now collected in full, a same-file `output(...)` would reach the
 * serializer holding an inert envelope where the run path has a real
 * reference. Rejected here instead, which falls the file back to run —
 * absent output, never a wrong one.
 */
async function resolveCallArguments(
  node: ts.CallExpression,
  calleeName: string,
  ctx: ResolveCtx,
): Promise<unknown[]> {
  const helperArgs = isFoldableHelperName(calleeName);
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
        : await reviveFoldedValue(fold(argNode, ctx.consts, ctx.intrinsics, ctx.externals), ctx, helperArgs),
    );
  }
  return args;
}

// ─────────────────────────────────────────────────────────────────────────
// Composite factory interpretation (chant #1023, epic #1019 Phase 5).
//
// THE CONTRACT — the admissible factory subset, in ../fold/subset.ts's style.
//
// A composite is a factory function, and #1022 got its value the only way it
// could: by importing the defining module and CALLING it. That is the last
// place `chant build --fold` executes project-authored code in the CLI's own
// process (chant #1093), and the reason `--sandbox` has to demote such a file
// to the sandboxed child instead of folding it (chant #1111). This section
// removes the call for the factories whose bodies can be evaluated instead.
//
// A call is interpreted when ALL of the following hold. Every one of them is
// checked BEFORE any argument is evaluated or anything is constructed, so a
// factory outside the subset costs a parse and nothing else:
//
//  1. **The callee is bound by an `import` from a PROJECT FILE** (a
//     relative/absolute specifier). A lexicon-package composite is
//     deliberately NOT interpreted, for two independent reasons: an installed
//     lexicon ships compiled JS, so whether its factory bodies were
//     interpretable would depend on whether the package happened to ship
//     `.ts` — fold coverage must not vary with a dependency's build shape —
//     and a lexicon package is on {@link isTrustedExecutableBinding}'s
//     allowlist already, so calling it is exactly as safe under `--sandbox` as
//     the `loadPlugins` import the CLI performed before discovery began. There
//     is nothing to buy and a build-shape dependency to lose.
//  2. **The defining module declares that export as `Composite(<fn>, "<name>")`**
//     — a top-level `export const <name> = Composite(...)`, where `Composite`
//     is bound in THAT module to an import of chant's own
//     ({@link isChantOwnedHelperBinding}, the same provenance question #1082
//     asks of an authoring helper, and the same answer). This is #1023's
//     "recognize the callee is a registered Composite": a bare call to
//     anything else — a project helper function, a `withDefaults(...)`
//     wrapper, a re-exported binding — is not recognized and is not
//     interpreted.
//  3. **`<fn>` is an arrow/function expression taking at most one parameter**,
//     bound as a plain identifier or a simple object binding pattern (no
//     default, rest, or nested pattern).
//  4. **Its body is a single expression, or a block of `const` declarations
//     followed by one `return`** — and nothing else. No `if`, no `throw`, no
//     loop, no `let`/`var`, no nested function declaration, no bare expression
//     statement. This is the line loomster's `composites/*.ts` fall outside
//     (module-level `buildXxx()` helpers with `if`/`throw` and `.map()`), and
//     they are meant to: they keep invoking, exactly as before.
//  5. **Every expression in it is inside the fold subset, extended with the
//     two things a factory body exists to do**: `new Type(...)` in ANY value
//     position (a member, a nested property object, an array element), and a
//     call through a bare identifier. Both are shape-admissible here and
//     resolution-checked at evaluation, the same permissive-shape /
//     strict-evaluation split ../fold/subset.ts documents for identifier
//     binding and helper provenance.
//
// Everything else is out: a computed key, a method call (`naming.name(...)` —
// the callee is a property access, not an identifier), an array method, an
// operator `fold()` doesn't implement, `await`, a class expression, a template
// with a computed tag.
//
// WHY THIS IS NOT IN ../fold/subset.ts. That module is the shared, shape-only
// predicate `fold()` and EVL both read, and its own contract is that it may
// only ever be PERMISSIVE relative to `fold()`, never stricter. Admissibility
// here is not a shape question at all: rules 1 and 2 need the module graph —
// which file a name came from, and what that file declares — exactly like
// #1082's authoring-helper provenance, which subset.ts documents (point 2b)
// as deliberately out for the same reason. Putting rules 3-5 there alone would
// describe a subset no caller could act on without also answering 1 and 2, and
// putting all five there would mean teaching a syntax-only lint rule to
// resolve imports. The shape half stays checkable by anything that wants it —
// {@link findFactorySubsetViolation} takes a lone `ts` node — but the shared
// predicate is not made stricter, or wider, by this issue.
//
// WHAT IS PRESERVED. Interpretation is not a second construction path:
//
//  - **The instances are real, and made by the lexicon's own constructors.**
//    A `new Role({...})` in the body resolves `Role` through the DEFINING
//    module's imports and calls that class, the same class the run path would
//    have called from the same resolved module path.
//  - **Sibling references are live, not symbolic.** `role.Arn` reads the
//    attribute off the `Role` instance this interpretation just built, so it
//    is a genuine `AttrRef` wired to a genuine parent — identical to running
//    the factory, and strictly better than a top-level fold's `{__attrRef}`
//    envelope (an intrinsic that inspects its argument, `Sub`/`Ref`, gets what
//    it expects here).
//  - **The instance is assembled by `Composite()` itself.** The members go
//    back through chant's own {@link Composite} (../composite.ts) rather than
//    through a hand-built look-alike, so member validation, the non-enumerable
//    `members`/`_definition` layout `propagate()` and `expandComposite()`
//    depend on, and provenance stamping are the run path's, by construction
//    and not by resemblance.
//  - **`propagate()` still works, untouched.** It is a chant-owned import, so
//    `propagate(SomeComposite({...}), {...})` invokes the real `propagate` on
//    the interpreted instance and mutates it in place exactly as it does a run
//    one — which is why instance identity has to be a real `CompositeInstance`
//    and not a copy (chant #1097).
// ─────────────────────────────────────────────────────────────────────────

/**
 * A backstop for a composite that calls itself, directly or through a member.
 * {@link FoldSession.stack} cannot see it — the recursion happens entirely
 * inside one module's source, crossing no file boundary — so this is what
 * terminates it. Deliberately small: real composite nesting is 2-3 deep, and a
 * chain past this is a bug, not a design.
 */
const MAX_INTERPRETATION_DEPTH = 16;

/**
 * The static scope of a module that DEFINES composites — everything
 * interpreting one of its factory bodies needs, computed once per module per
 * build (see {@link FoldSession.factoryModules}).
 *
 * Note what is NOT here: the module's exported VALUES. Interpreting a factory
 * never needs them, which is the whole point — a module can define a perfectly
 * interpretable composite and still be unfoldable as a module (an exported
 * function declaration alongside it, say), and those two facts are
 * independent.
 */
interface FactoryModuleScope {
  file: string;
  sourceFile: ts.SourceFile;
  /**
   * The module's top-level `const`s, MINUS every one that resolves to a
   * `new Type(...)` resource.
   *
   * The exclusion is the load-bearing part. `fold()` turns a property access
   * on a resource-valued const into a symbolic `{__attrRef, entity: "<the
   * const's name>"}` — a name resolved much later, against the entity table of
   * the file being COLLECTED, which is the calling file and not this one. A
   * module-level resource shared by every call of a factory is also a
   * singleton whose identity the run path shares and interpretation would not.
   * Dropping those consts makes any reference to one an ordinary "unresolved
   * identifier" failure, which declines the interpretation and invokes
   * instead — the answer that is right on both counts.
   */
  consts: Map<string, ts.Expression>;
  imports: Map<string, ImportBinding>;
  namespaceImports: Map<string, NamespaceImportBinding>;
  /**
   * This module's own imports, resolved to their real cross-file values (see
   * {@link ResolveCtx.externals}) — LAZILY, and memoized here once built.
   *
   * Laziness is not an optimization detail, it is what keeps this issue from
   * paying #1020's cost all over again. `resolveCallExpression` reaches
   * {@link resolveInterpretableFactory} for EVERY call through a project-file
   * import, the overwhelming majority of which are not composites at all. Only
   * the parse is spent finding that out; resolving a module's whole import
   * graph — which recursively folds every project file it names — is spent
   * only by a call that is actually about to be interpreted.
   */
  resolved?: Promise<{ externals: Map<string, unknown>; failures: Map<string, string> }>;
}

/** An admissible composite factory: where it lives, what it is called, and the function to interpret. */
interface InterpretableFactory {
  scope: FactoryModuleScope;
  fn: ts.ArrowFunction | ts.FunctionExpression;
  /** `Composite()`'s second argument, or `"anonymous"` when it has none — matching {@link Composite}'s own default. */
  compositeName: string;
}

/**
 * Parse a composite-defining module into its static scope, memoized per build.
 * Returns `undefined` when the file can't be read or parsed — a decline, never
 * a throw: the caller falls through to the invocation arm, which will produce
 * its own (identical, pre-#1023) error if the module is genuinely broken.
 *
 * Reads and parses only. Nothing is imported, nothing is executed, and the
 * module's own imports are not resolved yet — see
 * {@link FactoryModuleScope.resolved}.
 */
function readFactoryModule(modulePath: string, session: FoldSession): Promise<FactoryModuleScope | undefined> {
  const cached = session.factoryModules.get(modulePath);
  if (cached) return cached;
  const promise = readFactoryModuleCore(modulePath);
  session.factoryModules.set(modulePath, promise);
  return promise;
}

async function readFactoryModuleCore(modulePath: string): Promise<FactoryModuleScope | undefined> {
  let sourceFile: ts.SourceFile;
  try {
    const source = await readFile(modulePath, "utf-8");
    sourceFile = ts.createSourceFile(modulePath, source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  } catch {
    // Not a readable TypeScript source — an installed package's compiled
    // entry point reached through a path specifier, a missing file. Decline.
    return undefined;
  }

  const collected = collectImports(sourceFile);
  const consts = collectConsts(sourceFile);
  for (const [name] of [...consts]) {
    if (constResolvesToResource(consts, name, new Set())) consts.delete(name);
  }

  return {
    file: modulePath,
    sourceFile,
    consts,
    imports: collected.named,
    namespaceImports: collected.namespaces,
  };
}

/**
 * Resolve a composite-defining module's own imports, once per module per
 * build. Guarded by {@link FoldSession.stack}, exactly like
 * {@link foldFileMemoized}: a module already being resolved further up the
 * same chain is a genuine cycle, and gets an empty scope (every identifier
 * then reads as unresolved, which declines the interpretation) rather than a
 * re-entry.
 */
function factoryModuleScopeResolved(
  scope: FactoryModuleScope,
  session: FoldSession,
): Promise<{ externals: Map<string, unknown>; failures: Map<string, string> }> {
  if (scope.resolved) return scope.resolved;
  if (session.stack.includes(scope.file) || session.stack.length >= MAX_RESOLUTION_DEPTH) {
    return Promise.resolve({ externals: new Map(), failures: new Map() });
  }
  session.stack.push(scope.file);
  scope.resolved = buildExternals(scope.file, scope.imports, scope.namespaceImports, session).finally(() => {
    const idx = session.stack.lastIndexOf(scope.file);
    if (idx !== -1) session.stack.splice(idx, 1);
  });
  return scope.resolved;
}

/**
 * True when a module-level `const` is (transitively) bound to a
 * `new Type(...)`. Mirrors `fold()`'s own `resolvesToResource`, but follows an
 * identifier chain (`const a = new T(); const b = a;`) so aliasing can't smuggle
 * a module-level resource into a factory body — see
 * {@link FactoryModuleScope.consts}.
 */
function constResolvesToResource(
  consts: Map<string, ts.Expression>,
  name: string,
  seen: Set<string>,
): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const init = consts.get(name);
  if (init === undefined) return false;
  if (ts.isNewExpression(init)) return true;
  if (ts.isIdentifier(init)) return constResolvesToResource(consts, init.text, seen);
  return false;
}

/**
 * Find `export const <exportName> = Composite(<fn>, "<name>")` at the top level
 * of `scope`'s module, verifying that `Composite` really is chant's own in that
 * module. Returns `undefined` for every other shape — see rule 2 of the
 * contract above.
 */
function findCompositeDefinition(
  scope: FactoryModuleScope,
  exportName: string,
  ctx: ResolveCtx,
): { fn: ts.ArrowFunction | ts.FunctionExpression; compositeName: string } | undefined {
  for (const statement of scope.sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!hasExportModifier(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;

    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== exportName) continue;
      const init = decl.initializer;
      if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return undefined;

      // `Composite` must be bound, in THIS module, to an import of chant's
      // own — the identical provenance question #1082 asks of an authoring
      // helper, answered by the identical predicate. A project-local
      // `function Composite(...)` shadowing the name is not chant's, and a
      // call to it is not a registered composite.
      const compositeBinding = scope.imports.get(init.expression.text);
      if (!compositeBinding || compositeBinding.imported !== "Composite") return undefined;
      if (!isChantOwnedHelperBinding(compositeBinding, { ...ctx, file: scope.file })) return undefined;

      const [fnArg, nameArg] = init.arguments;
      if (!fnArg || (!ts.isArrowFunction(fnArg) && !ts.isFunctionExpression(fnArg))) return undefined;
      // `Composite()`'s own default when the name is omitted (../composite.ts).
      // COR017 requires the literal in practice; anything that is not a plain
      // string literal is not something to guess at.
      if (nameArg !== undefined && !ts.isStringLiteral(nameArg)) return undefined;
      return { fn: fnArg, compositeName: nameArg ? nameArg.text : "anonymous" };
    }
  }
  return undefined;
}

/**
 * Decide whether `binding`'s callee is an interpretable composite — rules 1-5
 * of the contract above, in that order, with no evaluation and no import.
 * `undefined` means "not interpretable", never "broken".
 */
async function resolveInterpretableFactory(
  binding: ImportBinding,
  ctx: ResolveCtx,
): Promise<InterpretableFactory | undefined> {
  // Rule 1 — project files only. A text check; no resolution performed for a
  // bare specifier, so this costs nothing for the (common) lexicon case.
  if (!isProjectFileSpecifier(binding.specifier)) return undefined;
  if (ctx.interpretDepth >= MAX_INTERPRETATION_DEPTH) return undefined;

  let modulePath: string;
  try {
    modulePath = resolveModulePathMemoized(binding.specifier, ctx.file, ctx.resolvePathCache);
  } catch {
    return undefined;
  }

  const scope = await readFactoryModule(modulePath, ctx.session);
  if (!scope) return undefined;

  // Rule 2.
  const definition = findCompositeDefinition(scope, binding.imported, ctx);
  if (!definition) return undefined;

  // Rules 3-5.
  if (findFactorySubsetViolation(definition.fn) !== undefined) return undefined;

  return { scope, fn: definition.fn, compositeName: definition.compositeName };
}

/**
 * The SHAPE half of the contract (rules 3-5) — a lone `ts` node in, a reason
 * string out, or `undefined` when the factory is admissible. Deliberately
 * takes nothing but the node: it is the half a caller with no module graph
 * could evaluate, and keeping it separable is what lets the doc above claim
 * the shape rules are checkable without the provenance ones.
 */
export function findFactorySubsetViolation(fn: ts.ArrowFunction | ts.FunctionExpression): string | undefined {
  // Rule 3 — at most one parameter, bound plainly.
  if (fn.parameters.length > 1) return "a composite factory takes a single props parameter";
  const param = fn.parameters[0];
  if (param) {
    if (param.dotDotDotToken) return "a rest parameter is not interpretable";
    if (param.initializer) return "a defaulted parameter is not interpretable";
    if (ts.isObjectBindingPattern(param.name)) {
      for (const el of param.name.elements) {
        if (bindingElementPropKey(el) === undefined) {
          return "a destructured props parameter with a rest, default, or nested element is not interpretable";
        }
      }
    } else if (!ts.isIdentifier(param.name)) {
      return "an array-destructured props parameter is not interpretable";
    }
  }

  // Rule 4 — a concise expression body, or `const`s then one `return`.
  if (!ts.isBlock(fn.body)) return checkFactoryExpression(fn.body);

  const statements = fn.body.statements;
  if (statements.length === 0) return "an empty composite factory body has no members to interpret";
  for (let i = 0; i < statements.length; i += 1) {
    const statement = statements[i];
    const last = i === statements.length - 1;

    if (ts.isReturnStatement(statement)) {
      if (!last) return "an early `return` is not interpretable";
      if (!statement.expression) return "a composite factory must return its members";
      const violation = checkFactoryExpression(statement.expression);
      if (violation) return violation;
      continue;
    }
    if (last) return "a composite factory body must end in `return`";

    if (!ts.isVariableStatement(statement)) {
      return `\`${ts.SyntaxKind[statement.kind]}\` in a composite factory body is not interpretable`;
    }
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      return "`let`/`var` in a composite factory body is not interpretable";
    }
    for (const decl of statement.declarationList.declarations) {
      if (!decl.initializer) return "an uninitialized `const` in a composite factory body is not interpretable";
      if (ts.isObjectBindingPattern(decl.name)) {
        for (const el of decl.name.elements) {
          if (bindingElementPropKey(el) === undefined) {
            return "a destructured `const` with a rest, default, or nested element is not interpretable";
          }
        }
      } else if (!ts.isIdentifier(decl.name)) {
        return "an array-destructured `const` is not interpretable";
      }
      const violation = checkFactoryExpression(decl.initializer);
      if (violation) return violation;
    }
  }
  return undefined;
}

/**
 * Rule 5 — the fold subset, extended with `new Type(...)` in any value
 * position and a call through a bare identifier.
 *
 * Shape only, in ../fold/subset.ts's sense: whether a `new`'s constructor or a
 * call's callee actually resolves to something invocable is settled at
 * evaluation, where the module graph is available. Every operator/key/member
 * rule is read from ../fold/subset.ts's own exported sets rather than
 * re-listed, so widening `fold()` widens this in the same commit.
 */
function checkFactoryExpression(node: ts.Expression): string | undefined {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return checkFactoryExpression(node.expression);
  }

  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isIdentifier(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return undefined;
  }

  if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
    // A bare-identifier callee only — `ns.Foo(...)`, `arr.map(...)` and
    // `props.factory(...)` are all property accesses and all stay out, which
    // is what keeps a data transform (chant EVL010) from sneaking in.
    if (!ts.isIdentifier(node.expression)) {
      return ts.isNewExpression(node)
        ? `\`new ${briefNodeText(node.expression)}(...)\` needs a plain imported constructor to interpret`
        : callExpressionMessage(node);
    }
    for (const arg of node.arguments ?? []) {
      const violation = checkFactoryExpression(arg);
      if (violation) return violation;
    }
    return undefined;
  }

  if (ts.isTaggedTemplateExpression(node)) {
    if (!ts.isIdentifier(node.tag)) return unsupportedExpressionMessage(node);
    if (ts.isNoSubstitutionTemplateLiteral(node.template)) return undefined;
    for (const span of node.template.templateSpans) {
      const violation = checkFactoryExpression(span.expression);
      if (violation) return violation;
    }
    return undefined;
  }

  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const violation = checkFactoryExpression(span.expression);
      if (violation) return violation;
    }
    return undefined;
  }

  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        if (!isLiteralPropertyNameNode(prop.name)) return computedPropertyNameMessage(prop.name);
        const violation = checkFactoryExpression(prop.initializer);
        if (violation) return violation;
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        if (prop.objectAssignmentInitializer) return UNSUPPORTED_OBJECT_MEMBER_MESSAGE;
      } else if (ts.isSpreadAssignment(prop)) {
        const violation = checkFactoryExpression(prop.expression);
        if (violation) return violation;
      } else {
        return UNSUPPORTED_OBJECT_MEMBER_MESSAGE;
      }
    }
    return undefined;
  }

  if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) {
      const violation = checkFactoryExpression(ts.isSpreadElement(el) ? el.expression : el);
      if (violation) return violation;
    }
    return undefined;
  }

  if (ts.isPropertyAccessExpression(node)) return checkFactoryExpression(node.expression);

  if (ts.isElementAccessExpression(node)) {
    if (!isLiteralElementKey(node.argumentExpression)) {
      return `dynamic element access [${briefNodeText(node.argumentExpression)}] is not interpretable`;
    }
    return checkFactoryExpression(node.expression);
  }

  if (ts.isPrefixUnaryExpression(node)) {
    if (!SUPPORTED_UNARY_OPERATORS.has(node.operator)) return UNSUPPORTED_UNARY_MESSAGE;
    return checkFactoryExpression(node.operand);
  }

  if (ts.isBinaryExpression(node)) {
    if (!SUPPORTED_BINARY_OPERATORS.has(node.operatorToken.kind)) {
      return unsupportedBinaryMessage(node.operatorToken.kind);
    }
    return checkFactoryExpression(node.left) ?? checkFactoryExpression(node.right);
  }

  if (ts.isConditionalExpression(node)) {
    return (
      checkFactoryExpression(node.condition) ??
      checkFactoryExpression(node.whenTrue) ??
      checkFactoryExpression(node.whenFalse)
    );
  }

  return unsupportedExpressionMessage(node);
}

/** `isLiteralPropertyName` narrowed to the node type {@link propName} accepts, without importing the type predicate's generic form twice. */
function isLiteralPropertyNameNode(node: ts.PropertyName): boolean {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node);
}

/**
 * Interpret an admissible factory's body against `args`, and assemble the
 * result through chant's own {@link Composite}.
 *
 * Returns `undefined` — a DECLINE, not a failure — when anything in the body
 * fails to resolve (an identifier the defining module's imports don't reach, a
 * constructor `--sandbox` refuses, a nested call that isn't a composite). The
 * caller then invokes for real, landing exactly where it landed before #1023.
 * That asymmetry is deliberate: interpretation may only ever REMOVE an
 * execution, never introduce a fold failure that wasn't there.
 */
async function interpretCompositeFactory(
  factory: InterpretableFactory,
  args: readonly unknown[],
  ctx: ResolveCtx,
): Promise<{ value: unknown } | undefined> {
  // A `Composite()` factory takes exactly one props argument. Anything else at
  // the call site means the callee is being used as something this doesn't
  // model.
  if (args.length > 1) return undefined;

  const { scope, fn } = factory;
  const resolved = await factoryModuleScopeResolved(scope, ctx.session);
  // The defining module's own scope, with the factory's locals layered on top.
  // `locals` is deliberately EMPTY: `resolveLiveValue`'s local-binding branch
  // exists to re-navigate a file's own top-level composite spine, which is not
  // what a name inside a factory body means. Body bindings live in `externals`
  // instead, where an identifier resolves to the value already computed for it
  // — which is what makes `role.Arn` a live `AttrRef` on the real instance.
  const consts = new Map(scope.consts);
  const externals = new Map(resolved.externals);
  const bodyCtx: ResolveCtx = {
    file: scope.file,
    consts,
    locals: new Map(),
    imports: scope.imports,
    namespaceImports: scope.namespaceImports,
    memo: new Map(),
    intrinsics: ctx.intrinsics,
    externals,
    crossFileFailures: resolved.failures,
    importCache: ctx.importCache,
    resolvePathCache: ctx.resolvePathCache,
    lexiconPackages: ctx.lexiconPackages,
    sandbox: ctx.sandbox,
    session: ctx.session,
    interpretDepth: ctx.interpretDepth + 1,
  };

  const bind = (name: string, value: unknown): void => {
    // A body binding SHADOWS a module-level const of the same name, so the
    // const has to go — `fold()` consults `consts` before `externals`.
    consts.delete(name);
    externals.set(name, value);
  };

  try {
    const param = fn.parameters[0];
    if (param) {
      const props = args[0];
      if (ts.isIdentifier(param.name)) {
        bind(param.name.text, props);
      } else if (ts.isObjectBindingPattern(param.name)) {
        if (!isIndexableObject(props)) return undefined;
        for (const el of param.name.elements) {
          const key = bindingElementPropKey(el);
          if (key === undefined) return undefined;
          bind(el.name.getText(), (props as Record<string, unknown>)[key]);
        }
      }
    }

    const members = await interpretFactoryBody(fn, bodyCtx, bind);
    if (!isIndexableObject(members)) return undefined;

    // Assembled by chant's own `Composite()` — see the contract's "what is
    // preserved" note. One definition object per interpreted call (rather than
    // one per module, as the run path has) is the single visible difference:
    // `_id` is a fresh symbol, which nothing outside `CompositeRegistry` — used
    // only by tests — reads.
    const definition = Composite<void, CompositeMembers>(() => members as CompositeMembers, factory.compositeName);
    const instance = definition();
    executionCounts.factoryInterpretations += 1;
    return { value: instance };
  } catch {
    return undefined;
  }
}

/** Evaluate an admissible factory body's statements in order, binding each `const`, and return the `return` expression's value. */
async function interpretFactoryBody(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  ctx: ResolveCtx,
  bind: (name: string, value: unknown) => void,
): Promise<unknown> {
  if (!ts.isBlock(fn.body)) return interpretExpression(fn.body, ctx);

  for (const statement of fn.body.statements) {
    if (ts.isReturnStatement(statement)) {
      // `findFactorySubsetViolation` has already established this is the last
      // statement and has an expression.
      return interpretExpression(statement.expression as ts.Expression, ctx);
    }
    const declarations = (statement as ts.VariableStatement).declarationList.declarations;
    for (const decl of declarations) {
      const value = await interpretExpression(decl.initializer as ts.Expression, ctx);
      if (ts.isIdentifier(decl.name)) {
        bind(decl.name.text, value);
        continue;
      }
      if (!isIndexableObject(value)) {
        throw cheapError(`destructured \`const\` source in "${briefNodeText(decl.name)}" is not an object`);
      }
      for (const el of (decl.name as ts.ObjectBindingPattern).elements) {
        bind(el.name.getText(), (value as Record<string, unknown>)[bindingElementPropKey(el) as string]);
      }
    }
  }
  // Unreachable: rule 4 requires a trailing `return`.
  throw cheapError("composite factory body did not return");
}

/**
 * Evaluate one expression of a factory body.
 *
 * Only the cases that can CONTAIN a construction or a composite call are
 * handled here; everything else delegates to {@link resolveDeclaratorValue},
 * which is the same `resolveLiveValue` -> `fold()` -> revive pipeline every
 * other value in a fold takes. That split is the point: the interpreter owns
 * as little evaluation semantics as it possibly can, so `fold()` stays the one
 * definition of what an expression means, and the operators/short-circuiting
 * duplicated below are duplicated because they must not evaluate a branch
 * `fold()` would not have evaluated.
 */
async function interpretExpression(node: ts.Expression, ctx: ResolveCtx): Promise<unknown> {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return interpretExpression(node.expression, ctx);
  }

  if (ts.isNewExpression(node)) return interpretNewExpression(node, ctx);

  if (ts.isObjectLiteralExpression(node)) {
    const obj: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        obj[propName(prop.name)] = await interpretExpression(prop.initializer, ctx);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        obj[prop.name.text] = await interpretExpression(prop.name, ctx);
      } else {
        const src = await interpretExpression((prop as ts.SpreadAssignment).expression, ctx);
        if (src === null || typeof src !== "object") throw cheapError("spread source not an object");
        Object.assign(obj, src);
      }
    }
    return obj;
  }

  if (ts.isArrayLiteralExpression(node)) {
    const arr: unknown[] = [];
    for (const el of node.elements) {
      if (ts.isSpreadElement(el)) {
        const src = await interpretExpression(el.expression, ctx);
        if (!Array.isArray(src)) throw cheapError("spread source not an array");
        arr.push(...src);
      } else {
        arr.push(await interpretExpression(el, ctx));
      }
    }
    return arr;
  }

  if (ts.isConditionalExpression(node)) {
    return (await interpretExpression(node.condition, ctx))
      ? interpretExpression(node.whenTrue, ctx)
      : interpretExpression(node.whenFalse, ctx);
  }

  if (ts.isBinaryExpression(node)) {
    const S = ts.SyntaxKind;
    const opKind = node.operatorToken.kind;
    if (opKind === S.AmpersandAmpersandToken) {
      const left = await interpretExpression(node.left, ctx);
      return left ? interpretExpression(node.right, ctx) : left;
    }
    if (opKind === S.BarBarToken) {
      const left = await interpretExpression(node.left, ctx);
      return left ? left : interpretExpression(node.right, ctx);
    }
    if (opKind === S.QuestionQuestionToken) {
      const left = await interpretExpression(node.left, ctx);
      return left === null || left === undefined ? interpretExpression(node.right, ctx) : left;
    }
  }

  return (await resolveDeclaratorValue(node, ctx)).value;
}

/**
 * Construct a real resource from a `new Type(...)` anywhere inside a factory
 * body — a member, a nested property object, an array element.
 *
 * Deliberately NOT routed through {@link resolveResourceEntity}: a factory body
 * evaluates against the DEFINING module's scope with the caller's props already
 * bound to live values, so each argument is interpreted recursively (through
 * {@link interpretExpression}, which can produce a live composite instance a
 * plain `fold()` has no representation for) rather than folded and revived.
 *
 * chant #1169 removed the asymmetry that used to motivate this comment: a
 * nested `new` in a TOP-LEVEL value position now constructs too, via
 * {@link constructFoldedResource}. The two paths reach the same place — the
 * class named by an `import`, called with the arguments the source wrote — by
 * different routes, because a factory body and a file's own top level start
 * from different scopes.
 */
async function interpretNewExpression(node: ts.NewExpression, ctx: ResolveCtx): Promise<unknown> {
  // Guaranteed an identifier by {@link checkFactoryExpression}; re-checked so a
  // future caller can't reach this with a dotted callee and get a silent miss.
  if (!ts.isIdentifier(node.expression)) {
    throw cheapError(`\`new ${briefNodeText(node.expression)}(...)\` needs a plain imported constructor`);
  }
  const typeName = node.expression.text;
  const binding = ctx.imports.get(typeName);
  if (!binding) throw cheapError(`constructor "${typeName}" is not a resolvable import`);

  // chant #1093 — same gate, same reason, as every other site that imports a
  // module in order to execute something from it.
  const refusal = sandboxedExecutionRefusal(binding, ctx, typeName, "constructor");
  if (refusal) throw cheapError(refusal);

  const modulePath = resolveModulePathMemoized(binding.specifier, ctx.file, ctx.resolvePathCache);
  const mod = await importModuleMemoized(modulePath, ctx.importCache);
  const Ctor = mod[binding.imported];
  if (typeof Ctor !== "function") {
    throw cheapError(`"${binding.imported}" from "${binding.specifier}" is not a constructor`);
  }

  const ctorArgs: unknown[] = [];
  for (const arg of node.arguments ?? []) ctorArgs.push(await interpretExpression(arg, ctx));
  return new (Ctor as new (...ctorArguments: unknown[]) => unknown)(...ctorArgs);
}

/**
 * Record one exported name's fully-resolved value: unconditionally into
 * `exportedValues` (chant #1020) — the file's export namespace, which is
 * what discovery hands to `collectEntities` and what another file's
 * cross-file reference resolves against — and, additionally, into `entities`
 * when the value is a real `Declarable`/`CompositeInstance`.
 *
 * chant #1112 — `entities` is a REPORTING subset, not a filter. It used to
 * be the only thing discovery passed on, which made this function a second
 * owner of the "which export becomes an entity" decision; it had one fewer
 * case than the real owner (`enumerateEntries`, ../collect.ts), so a
 * `LexiconOutput` export folded fine and was then thrown away, and the
 * template silently lost its `Outputs` section. Discovery now passes
 * `exportedValues` — the whole namespace, exactly like the run path's real
 * `exports` object — and `collectEntities` filters it, so nothing here can
 * fall behind what collection understands. What `entities` still answers is
 * "how many resources did this file contribute", for the `[fold:fold] x.ts —
 * N resource(s)` decision line.
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
// require wiring a live `WeakRef` to the sibling entity — out of scope here:
// reject (fall back to run) rather than risk silently wrong output.
//
// chant #1169 adds the fourth envelope this walk revives, and the one that
// closes the corpus's largest fold gate: `{__resource}`, a nested
// `new Type(...)` used as a value. It is revived the same way and for the same
// reason as the other three — the real class is resolved through the folding
// file's own imports and called for real — so what the outer constructor
// receives is the instance the run path would have handed it, not a look-alike.
// See {@link constructFoldedResource}.
// ─────────────────────────────────────────────────────────────────────────

/** Resolve a bare name bound by this file's own `import` to its real, live export — the same two-step (resolve module path, then `importModule`) `resolveResourceEntity`/`resolveCallExpression` already use for constructors and composite factories. */
async function resolveImportedExport(name: string, ctx: ResolveCtx): Promise<unknown> {
  const binding = ctx.imports.get(name);
  if (!binding) {
    throw cheapError(`"${name}" is not a resolvable import`);
  }

  // chant #1093 — reached for an intrinsic tag and for a symbolic chain's root
  // (`AWS.StackName`), both of which are resolved BY NAME out of the file's own
  // imports: nothing guarantees the module behind that name is a lexicon's.
  // `reviveHelperCall` checks chant-ownership before it gets here; this covers
  // the paths that don't.
  const refusal = sandboxedExecutionRefusal(binding, ctx, name, "import");
  if (refusal) throw cheapError(refusal);

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
 * Revive a folded value tree: replace any
 * `{__intrinsic}`/`{__helper}`/`{__symbol}` envelope with the real value it
 * represents.
 *
 * `requireLiveRefs` tracks whether the CURRENT node is (transitively) an
 * argument being handed to a real function that will inspect it — a
 * `{__intrinsic}`'s own interpolated `values`, or a `{__helper}` call's
 * arguments (chant #1082). In that position a symbolic `{__attrRef}` envelope
 * is rejected rather than passed along: the receiving implementation needs a
 * genuine `AttrRef` instance (`instanceof` checks, `WeakRef` derefs — see
 * `SubIntrinsic`, and `LexiconOutput`'s constructor in ../lexicon-output.ts),
 * and handing it a look-alike plain object produces output that is wrong
 * rather than absent. Everywhere else the envelope is left untouched, because
 * the serializer's generic walker already understands it — see the module-doc
 * note above.
 */
async function reviveFoldedValue(value: FoldedValue, ctx: ResolveCtx, requireLiveRefs: boolean): Promise<unknown> {
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
  // chant #1063 adds the third kind of real object cross-file resolution can
  // now put here: a live `Intrinsic` instance read off an active lexicon
  // package (`Azure.ResourceGroupLocation`, `GCP.ProjectId` — see
  // `resolveActiveLexiconExport`). Same hazard, same fix: the generic walk
  // below would rebuild it as a plain `{}` copy, dropping the prototype that
  // carries `toJSON()` and so serializing `{}` where the run path emits
  // `[resourceGroup().location]`. `isIntrinsic` keys off
  // `Symbol.for("chant.intrinsic")` (../intrinsic.ts), a GLOBAL symbol, so it
  // holds across separately-loaded copies of chant-core the way a bare
  // `instanceof` would not.
  if (isAttrRefLike(value) || isDeclarable(value) || isCompositeInstance(value) || isIntrinsic(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    const revived: unknown[] = [];
    for (const el of value) revived.push(await reviveFoldedValue(el, ctx, requireLiveRefs));
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
      throw cheapError(`intrinsic "${intrinsic.__intrinsic}" did not resolve to a function`);
    }
    // Two authored forms, one envelope family (../fold/fold.ts's
    // `FoldedIntrinsic`): the tagged template replays as
    // `Name(strings, ...values)`, the plain call (chant #1044) as
    // `Name(...args)`. Both hand their interior to the REAL function the
    // file itself imported, with `requireLiveRefs` — an intrinsic inspects
    // what it is given (`SubIntrinsic`'s `instanceof` checks, `Ref`'s
    // `getLogicalName`), so a look-alike `{__attrRef}` envelope must be
    // rejected here rather than silently serialized as something else.
    const revived: unknown[] = [];
    if ("args" in intrinsic) {
      for (const a of intrinsic.args) revived.push(await reviveFoldedValue(a, ctx, true));
      return (Fn as (...fnArgs: unknown[]) => unknown)(...revived);
    }
    for (const v of intrinsic.values) revived.push(await reviveFoldedValue(v, ctx, true));
    return (Fn as (...fnArgs: unknown[]) => unknown)(intrinsic.strings, ...revived);
  }

  if ("__helper" in value) {
    return reviveHelperCall(value as FoldedHelperCall, ctx);
  }

  if ("__compositeStep" in value) {
    // chant #1174 — `<Identifier>(...).step`, see {@link FoldedCompositeStepCall}.
    // Arguments revive with `requireLiveRefs: false` — the same rule
    // `resolveCallArguments` applies to a NON-helper callee's arguments
    // (a composite factory stores its props, it doesn't inspect them the way
    // an intrinsic/helper does), so a `{__attrRef}` among them stays the
    // symbolic envelope the composite's own resource construction resolves
    // by name, exactly as a top-level resource's props would.
    const call = value as FoldedCompositeStepCall;
    const revivedArgs: unknown[] = [];
    for (const a of call.args) revivedArgs.push(await reviveFoldedValue(a, ctx, false));
    const result = await resolveCompositeCall(call.__compositeStep, revivedArgs, ctx);
    if (!isIndexableObject(result)) {
      throw cheapError(`composite call \`${call.__compositeStep}(...)\` did not resolve to an object with a "step" member`);
    }
    return (result as Record<string, unknown>).step;
  }

  if ("__attrRef" in value) {
    if (requireLiveRefs) {
      throw cheapError(
        "a same-file resource reference passed to a folded intrinsic or authoring helper is not foldable yet",
      );
    }
    return value;
  }

  if ("__resource" in value) {
    // chant #1169 — a nested `new Type(...)` used as a value. This is the
    // branch that makes the envelope safe: it is replaced, here, by a REAL
    // instance of the class the source named, built by the same
    // resolve-through-this-file's-imports machinery `resolveResourceEntity`
    // uses for a top-level resource and `interpretNewExpression` (#1023) uses
    // for a construction inside a factory body. Nothing symbolic reaches the
    // serializer — see {@link fold}'s `new` branch for why that is the whole
    // safety argument.
    //
    // `requireLiveRefs` is propagated rather than reset: a construction in an
    // ordinary prop position keeps the top-level rule (a `{__attrRef}` inside
    // it stays an envelope, which the serializer's own walker resolves by name
    // through `propertyDeclarable` exactly as it does for a top-level
    // resource's props), while a construction inside an intrinsic's interior
    // keeps the stricter one and rejects — the receiving implementation
    // inspects what it is handed, and this is the direction that falls back to
    // run rather than emitting something wrong.
    return constructFoldedResource(value as FoldedResource, ctx, requireLiveRefs);
  }

  const revived: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    revived[key] = await reviveFoldedValue(v as FoldedValue, ctx, requireLiveRefs);
  }
  return revived;
}

/**
 * chant #1082 — the provenance half of the registered-authoring-helper check
 * (the shape/name half is `fold()`'s, see ../fold/foldable-helpers.ts's module
 * doc). Being in the allowlist is not permission to invoke whatever the name
 * happens to be bound to: the name must be bound by THIS FILE'S OWN `import`,
 * and that import must actually come from chant. Only then is the real
 * function called, with the folded arguments — the same function the run path
 * would have called, from the same module the source itself named, so fold
 * cannot diverge from run by construction.
 *
 * Anything short of that throws, which falls the whole file back to run: a
 * local `function phase(...)`, a `phase` imported from the project's own
 * helpers, a chant-owned import that turns out not to be a function.
 */
async function reviveHelperCall(call: FoldedHelperCall, ctx: ResolveCtx): Promise<unknown> {
  const name = call.__helper;
  const binding = ctx.imports.get(name);
  if (!binding) {
    throw cheapError(`authoring helper "${name}(...)" is not a resolvable import`);
  }
  if (!isChantOwnedHelperBinding(binding, ctx)) {
    throw cheapError(
      `"${name}" is imported from "${binding.specifier}", which is not chant's own — ` +
        `only chant's registered authoring helpers fold as calls`,
    );
  }

  const Fn = await resolveImportedExport(name, ctx);
  if (typeof Fn !== "function") {
    throw cheapError(`authoring helper "${name}" did not resolve to a function`);
  }

  // `requireLiveRefs` — a helper receives its arguments as real values and may
  // inspect them (`output()` derefs the ref's `WeakRef` parent), so a symbolic
  // `{__attrRef}` envelope is rejected here rather than silently wrapped into
  // a wrong result. A ref that resolved cross-file to a genuine live `AttrRef`
  // passes straight through (see `reviveFoldedValue`'s early return).
  const args: unknown[] = [];
  for (const arg of call.args) args.push(await reviveFoldedValue(arg, ctx, true));
  return (Fn as (...fnArgs: unknown[]) => unknown)(...args);
}

/**
 * True when `binding` names a helper import chant itself owns: a published
 * chant package specifier ({@link isChantOwnedSpecifier}), or — for in-repo
 * and test callers, which import chant-core by relative/absolute path the way
 * this module's own fixtures do — a specifier that resolves to a file inside
 * chant-core's own tree.
 *
 * The path arm resolves only for a relative/absolute specifier, never a bare
 * one: resolving an arbitrary bare specifier here would reintroduce the
 * pathological cold-resolution cost chant#1020 measured (see
 * {@link fastResolveBareSpecifier}), and a bare specifier chant publishes is
 * already covered by the text arm.
 *
 * Not the same question as chant#1093's {@link isTrustedExecutableBinding}
 * below, and deliberately not shared with it: this one asks "may this NAME be
 * invoked as one of chant's registered authoring helpers", and a text match
 * is the right answer for it — a project that shadows `@intentius/chant` in
 * its own `node_modules` gets its own copy of `output()` invoked either way,
 * fold or run, so fold cannot diverge from run by trusting the text here.
 * #1093's question is "may this module execute in the CLI's process at all",
 * where a specifier the project controls the text of proves nothing.
 */
function isChantOwnedHelperBinding(binding: ImportBinding, ctx: ResolveCtx): boolean {
  if (isChantOwnedSpecifier(binding.specifier)) return true;
  if (!isProjectFileSpecifier(binding.specifier)) return false;
  let targetPath: string;
  try {
    targetPath = resolveModulePathMemoized(binding.specifier, ctx.file, ctx.resolvePathCache);
  } catch {
    return false;
  }
  const root = chantCoreRoot();
  return targetPath === root || targetPath.startsWith(root + sep);
}

/**
 * chant #1093 — the closed allowlist of modules fold may import AND EXECUTE
 * in the CLI's own process when the #1045 sandbox is active. Exactly two
 * arms, and neither of them trusts text the project controls:
 *
 *  1. **An ACTIVE lexicon package of this build** — matched against
 *     {@link FoldSession.lexiconPackages}, a closed set built from the
 *     lexicon names the BUILD resolved and `loadPlugins` already imported
 *     (../cli/plugins.ts), not from anything the file under fold says.
 *  2. **chant-core's own executing tree** — the specifier is RESOLVED and the
 *     resulting path checked against {@link chantCoreRoot}. A text match is
 *     not enough here: `@intentius/chant` and `@intentius/chant-lexicon-evil`
 *     are both strings an untrusted repo can write into its own source and
 *     back with its own `node_modules` directory, and
 *     {@link isChantOwnedSpecifier} would accept either. Resolution happens
 *     before the decision rather than after, so an allowed binding pays
 *     exactly the resolution it was about to pay anyway (the memoized one —
 *     see {@link resolveModulePathMemoized}); a bare specifier that isn't
 *     even chant-shaped is rejected on text alone, so no arbitrary bare
 *     specifier is ever resolved here (chant#1020's cold-resolution cost).
 *
 * This is deliberately the boundary chant #1045 drew: "the boundary is around
 * executing PROJECT SOURCE, which is the untrusted input" — not around chant
 * itself or the lexicon packages, which the CLI has already imported and
 * executed in its own process before discovery starts, to get the serializers
 * and lint rules it cannot run without. Fold reaching the same already-loaded
 * module (the identical un-cache-busted `import()` of the identical resolved
 * path) adds no execution the process wasn't already performing.
 *
 * Everything else is out: a sibling project file, a project-local helper
 * module, an arbitrary npm dependency, a lexicon this build didn't load. A
 * build that supplied no lexicon list keeps only arm 2, rather than falling
 * back to something more permissive — the same stance
 * {@link FoldSession.lexiconPackages} takes for #1063.
 */
function isTrustedExecutableBinding(binding: ImportBinding, ctx: ResolveCtx): boolean {
  if (activeLexiconPackage(binding.specifier, ctx.lexiconPackages) !== undefined) return true;
  // Only a chant-shaped or project-relative specifier is worth resolving; any
  // other bare specifier is untrusted by definition, and resolving it to find
  // that out would cost the pathological cold `require.resolve` (chant#1020).
  if (!isProjectFileSpecifier(binding.specifier) && !isChantOwnedSpecifier(binding.specifier)) return false;
  let targetPath: string;
  try {
    targetPath = resolveModulePathMemoized(binding.specifier, ctx.file, ctx.resolvePathCache);
  } catch {
    return false;
  }
  const root = chantCoreRoot();
  return targetPath === root || targetPath.startsWith(root + sep);
}

/**
 * chant #1093 — the one-line fold-fallback reason for a resolution that would
 * import and execute an untrusted module in the CLI's own process, or
 * `undefined` when the import may proceed (the sandbox wasn't asked for, or
 * the module is on {@link isTrustedExecutableBinding}'s allowlist).
 *
 * A refusal is not a failure to fold something folder-shaped — the shape is
 * perfectly foldable and folds fine under plain `--fold`. It is a deliberate
 * demotion: the file falls back to the run path, and under `--sandbox` the
 * run path is the sandboxed child (`./index.ts` queues every run-fallback
 * file for `./sandbox/run.ts`). So the factory/constructor/intrinsic still
 * executes, with the same arguments, in the same module graph as the rest of
 * that file — just behind Node's Permission Model and a scrubbed environment
 * instead of inside the CLI. Coverage drops; the boundary holds.
 *
 * @param what - What the binding is being resolved AS, for the message
 *   ("composite factory", "constructor", …).
 */
function sandboxedExecutionRefusal(
  binding: ImportBinding,
  ctx: ResolveCtx,
  name: string,
  what: string,
): string | undefined {
  if (!ctx.sandbox) return undefined;
  if (isTrustedExecutableBinding(binding, ctx)) return undefined;
  return (
    `${what} "${name}" is imported from "${binding.specifier}", which is neither chant's own nor an active lexicon — ` +
    `under --sandbox it is executed in the sandboxed child, not in this process`
  );
}

/**
 * chant-core's own module root — `packages/core/src` in this repo,
 * `<pkg>/dist` in a published install — derived from THIS module's location.
 * Pure string arithmetic on `import.meta.url`, no filesystem access at all, so
 * it is safe in the #1045 sandbox child (which locks reads to an allowlist);
 * lazy and memoized purely to avoid doing it per call.
 */
let chantCoreRootMemo: string | undefined;
function chantCoreRoot(): string {
  // .../<root>/discovery/fold-import.ts -> .../<root>
  chantCoreRootMemo ??= dirname(dirname(fileURLToPath(import.meta.url)));
  return chantCoreRootMemo;
}

/** Revive every value in a folded props/attributes object (see {@link reviveFoldedValue}). */
async function reviveFoldedProps(
  props: { [key: string]: FoldedValue },
  ctx: ResolveCtx,
  requireLiveRefs: boolean,
): Promise<Record<string, unknown>> {
  const revived: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    revived[key] = await reviveFoldedValue(value, ctx, requireLiveRefs);
  }
  return revived;
}

// ─────────────────────────────────────────────────────────────────────────
// Resource construction — #1022's mechanism (fold the ctor call's arguments
// via `fold()`, resolve the constructor through this file's imports,
// construct the real Declarable), split by chant #1169 into two reusable
// halves so a NESTED `new Type(...)` used as a value is built by exactly the
// same code as a file's own top-level resource declaration, not by a second
// implementation that could quietly differ.
//
// `resolveResourceEntity` below is the top-level entry point and keeps its
// per-declarator reason strings verbatim; `reviveResourceCtorArgs` and
// `instantiateFoldedResource` are the shared halves, and
// {@link constructFoldedResource} is the one-call composition of the two that
// `reviveFoldedValue` uses for a nested construction.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Revive a folded constructor call's arguments into the real values the class
 * will receive.
 *
 * chant #1039 — replays any folded intrinsic/symbol envelopes into their real
 * runtime values before the entity is constructed. A no-op walk when the file
 * used no registered intrinsics (the overwhelming majority of cases today).
 *
 * chant #1082 — when `spec.args` is present the constructor's argument list
 * isn't the classic `(props)`/`(props, attributes)` shape (AWS's `Parameter` is
 * `(type, props)`), so the whole list is revived and spread by the caller
 * instead of `spec.props`, which in that case is only a view onto one of its
 * entries and would be double-counted.
 */
async function reviveResourceCtorArgs(
  spec: FoldedResource,
  ctx: ResolveCtx,
  requireLiveRefs: boolean,
): Promise<unknown[]> {
  if (spec.args) {
    const revived: unknown[] = [];
    for (const arg of spec.args) revived.push(await reviveFoldedValue(arg, ctx, requireLiveRefs));
    return revived;
  }
  const props = await reviveFoldedProps(spec.props, ctx, requireLiveRefs);
  // The runtime constructor's optional second argument (`attributes` — CFN's
  // DependsOn/Condition/DeletionPolicy/…, see createResource in ../runtime.ts)
  // is only present in `spec` when the source actually passed one (see
  // foldResource in ../fold/fold.ts). Passing `undefined` when it's absent
  // matches the run path's own default (`attributes ?? {}` inside the
  // constructor).
  return [props, spec.attributes ? await reviveFoldedProps(spec.attributes, ctx, requireLiveRefs) : undefined];
}

/**
 * Resolve a folded constructor's NAME through `ctx`'s own `import`
 * declarations and call the real class with `ctorArgs`.
 *
 * Throws a {@link cheapError} for every failure; `resolveResourceEntity` turns
 * those into its per-declarator `reason` strings and the nested path lets them
 * fall the whole file back to run. `forClause` is the ` for "<export name>"`
 * fragment the top-level messages carry and a nested construction has no name
 * for — the only difference between the two callers' diagnostics.
 */
async function instantiateFoldedResource(
  typeName: string,
  ctorArgs: readonly unknown[],
  ctx: ResolveCtx,
  forClause: string,
): Promise<unknown> {
  const binding = ctx.imports.get(typeName);
  if (!binding) {
    throw cheapError(`constructor "${typeName}"${forClause} is not a resolvable import`);
  }

  // chant #1093 — a resource class is a lexicon export in every corpus entry
  // today, but nothing forces that: `new Thing(...)` where `Thing` comes from
  // a project file (or an arbitrary dependency) would import and run that
  // module here, in the CLI's process. Same refusal as the composite-factory
  // path above, and the reason a nested construction cannot widen the #1093
  // boundary: it reaches its class by exactly this gate.
  const refusal = sandboxedExecutionRefusal(binding, ctx, typeName, "constructor");
  if (refusal) throw cheapError(refusal);

  let modulePath: string;
  try {
    modulePath = resolveModulePathMemoized(binding.specifier, ctx.file, ctx.resolvePathCache);
  } catch (err) {
    throw cheapError(
      `could not resolve import "${binding.specifier}" for "${typeName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Same import mechanism as `resolveCallExpression` above — see its comment.
  let mod: Record<string, unknown>;
  try {
    mod = await importModuleMemoized(modulePath, ctx.importCache);
  } catch (err) {
    throw cheapError(
      `could not import "${binding.specifier}" to resolve "${typeName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const Ctor = mod[binding.imported];
  if (typeof Ctor !== "function") {
    throw cheapError(`"${binding.imported}" from "${binding.specifier}" is not a constructor`);
  }

  // Constructed with exactly the arguments the source wrote.
  return new (Ctor as new (...ctorArguments: unknown[]) => unknown)(...ctorArgs);
}

/**
 * chant #1169 — build a real instance from a nested `{__resource}` envelope:
 * revive its arguments, then resolve its class and call it. The composition
 * {@link reviveFoldedValue} reaches for; identical in every step to what
 * {@link resolveResourceEntity} does for a top-level declaration, which is the
 * point — a nested `new Image({...})` and a top-level `export const image = new
 * Image({...})` produce the same object, from the same class, from the same
 * resolved module path.
 */
async function constructFoldedResource(
  spec: FoldedResource,
  ctx: ResolveCtx,
  requireLiveRefs: boolean,
): Promise<unknown> {
  const ctorArgs = await reviveResourceCtorArgs(spec, ctx, requireLiveRefs);
  return instantiateFoldedResource(spec.__resource, ctorArgs, ctx, "");
}

/**
 * chant #1169 — construct every top-level `const x = new Type(...)` in the file
 * ONCE, in source order, before any exported declarator is resolved, and put
 * each instance in `ctx.externals` under its own name.
 *
 * This is what makes a same-file resource usable as a VALUE — `image:
 * nodeImage`, `DependsOn: [dbCluster]`, `export { app }` — and it is the half
 * of the #1169 gate the nested-`new` lift alone does not reach: the
 * `{__resource}` envelope covers a construction written INLINE at the value
 * position, while the far more common authoring shape names it once and refers
 * to it. `fold()` cannot answer that reference on its own (it is synchronous,
 * and constructing needs the module graph), so it defers to `externals` — see
 * its identifier branch for the full argument.
 *
 * ONE instance, and identity is the whole point. Every reference in the file
 * reads this map, and the exported-declarator loop reuses the same object
 * through `prebuilt` rather than constructing a second one, so a resource
 * referenced by name and the entity discovery registers are the same object —
 * which is what makes the serializer's `Ref`/`DependsOn` resolution land on a
 * logical name at all. Running the module top-to-bottom produces exactly this:
 * every top-level `const` evaluated once, in order, later ones seeing earlier
 * ones. Order matters and is preserved — `collectConsts` yields source order, so
 * `const b = new Thing({ x: a })` finds `a` already built.
 *
 * A construction that FAILS is skipped silently rather than failing the file:
 * the name stays absent from `externals`, so a reference to it rejects with the
 * identical message it produced before this existed, and an EXPORTED one falls
 * through to {@link resolveResourceEntity}, which reproduces the failure with
 * its own located reason. Strictly additive.
 *
 * Under `--sandbox` every construction here goes through the same
 * {@link sandboxedExecutionRefusal} as every other one, so a project-defined
 * class refuses, the name stays unresolved, and the file demotes to the
 * sandboxed child exactly as before. Under plain `--fold` this can import a
 * constructor's module for a const that is never exported — work the RUN path
 * performs unconditionally for the same file, and through the same
 * already-memoized `importModule`.
 */
/**
 * The local names this file bound to the build's parameter object (chant
 * #1443). Object identity against {@link FoldSession.buildParams}, which
 * `buildExternals` substituted directly, so an unrelated import that happens to
 * be called `params` is not mistaken for it.
 */
function paramLocalNames(ctx: ResolveCtx): Set<string> {
  const out = new Set<string>();
  const buildParams = ctx.session.buildParams;
  if (!buildParams) return out;
  for (const [name, value] of ctx.externals) {
    if (value === buildParams) out.add(name);
  }
  return out;
}

/**
 * chant #1443 — record which build parameters each of a resource's authored
 * property expressions reads, before fold substitutes them away. Best-effort
 * and additive: a file with no `params` import, or a constructor called with no
 * object literal, records nothing.
 */
function stampParamDependencies(entity: unknown, node: ts.NewExpression, ctx: ResolveCtx): void {
  if (typeof entity !== "object" || entity === null) return;
  const paramLocals = paramLocalNames(ctx);
  if (paramLocals.size === 0) return;
  // The same argument `foldResource` treats as props: the first object literal.
  let propsArg: ts.ObjectLiteralExpression | undefined;
  for (const argument of node.arguments ?? []) {
    if (ts.isObjectLiteralExpression(argument)) {
      propsArg = argument;
      break;
    }
  }
  if (!propsArg) return;
  for (const [path, origin] of Object.entries(collectParamDependencies(propsArg, ctx.consts, paramLocals))) {
    setPathProvenance(entity, path, origin);
  }
}

async function preresolveResourceConsts(ctx: ResolveCtx): Promise<Map<ts.Expression, unknown>> {
  const built = new Map<ts.Expression, unknown>();
  for (const [name, initializer] of ctx.consts) {
    if (!ts.isNewExpression(initializer) || !ts.isIdentifier(initializer.expression)) continue;
    try {
      const spec = foldResource(initializer, ctx.consts, ctx.intrinsics, ctx.externals);
      const instance = await constructFoldedResource(spec, ctx, false);
      stampParamDependencies(instance, initializer, ctx);
      built.set(initializer, instance);
      ctx.externals.set(name, instance);
    } catch {
      // Not constructible here (an unresolvable constructor import, a prop
      // outside the fold subset, a --sandbox refusal). Leave the name alone.
    }
  }
  return built;
}

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

  let ctorArgs: unknown[];
  try {
    ctorArgs = await reviveResourceCtorArgs(spec, ctx, false);
  } catch (err) {
    return {
      ok: false,
      reason: `"${name}" is not foldable: ${describeFoldFailure(err, ctx)}`,
    };
  }

  try {
    const entity = (await instantiateFoldedResource(spec.__resource, ctorArgs, ctx, ` for "${name}"`)) as Declarable;
    stampParamDependencies(entity, node, ctx);
    return { ok: true, entity };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
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

/**
 * chant #1054 — a short, single-line label for a destructured export's
 * source expression, for a fold fallback reason: the callee plus `(...)`
 * for the common composite-call source (`GkeCluster(...)`), or a brief,
 * bounded rendering of whatever else it is otherwise. Never the source's own
 * `getText()` — for a real composite call that's the entire multi-line
 * argument list.
 */
function describeDestructureSource(node: ts.Expression): string {
  return ts.isCallExpression(node) ? `${briefNodeText(node.expression)}(...)` : briefNodeText(node);
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
): Promise<{ externals: Map<string, unknown>; failures: Map<string, string>; liveSources: Set<string> }> {
  const externals = new Map<string, unknown>();
  const failures = new Map<string, string>();
  // chant #1044 — see `FoldFileResult.liveSources`.
  const liveSources = new Set<string>();

  for (const [localName, binding] of imports) {
    // chant #1064 — a named `params` import that resolves to chant-core's own
    // build-time-parameters module (../params.ts) is substituted directly
    // from this build's already-resolved values, with NO import performed —
    // so `params.tier` folds to a LITERAL rather than a symbolic node
    // (contrast the `{__symbol}` deferral a pseudo-parameter namespace import
    // like `AWS.StackName` gets — that genuinely can't resolve until a real
    // module runs; a build parameter's value is already fully known here).
    //
    // A BARE specifier is recognized by an exact TEXT match against the one
    // real published subpath ({@link PARAMS_BARE_SPECIFIER}), NEVER by
    // resolving it: `resolveModulePathMemoized`'s bare-specifier branch falls
    // through to Node's own package resolution
    // (`createRequire(fromFile).resolve(specifier)`), which chant#1020's own
    // fix-history (see this module's other comments) measured at up to ~361s
    // for the FIRST resolution of a genuinely new bare specifier in a
    // process — a cost `buildExternals` previously never paid at all for
    // bare specifiers (the pre-#1064 code skipped them outright). Since
    // `binding.imported === "params"` alone says nothing about which package
    // a project actually imported from, resolving EVERY such bare specifier
    // to check it would reintroduce exactly that pathological cost for any
    // corpus/project file that happens to import a same-named binding from
    // an unrelated package — a real, measured regression this text-match
    // avoids entirely (no filesystem/package resolution for a bare
    // specifier, ever, in this branch).
    //
    // A RELATIVE/ABSOLUTE specifier is still resolved and path-compared
    // against {@link paramsModulePath} — that resolution is always cheap
    // (`existsSync`/`statSync` candidate probing, never Node's package
    // resolution), so it's safe for this module's own absolute-path test
    // fixtures to exercise the identical substitution a real bare import
    // takes, without the bare-specifier cost concern applying.
    if (session.buildParams && binding.imported === "params") {
      if (binding.specifier === PARAMS_BARE_SPECIFIER) {
        externals.set(localName, session.buildParams);
        continue;
      }
      if (isProjectFileSpecifier(binding.specifier)) {
        try {
          const targetPath = resolveModulePathMemoized(binding.specifier, file, session.resolvePathCache);
          if (targetPath === paramsModulePath()) {
            externals.set(localName, session.buildParams);
            continue;
          }
        } catch {
          // Unresolvable specifier — fall through to the ordinary handling
          // below, same as any other import this loop can't resolve.
        }
      }
    }

    if (!isProjectFileSpecifier(binding.specifier)) {
      // chant #1063 — a bare specifier naming one of THIS BUILD's active
      // lexicon packages resolves to that package's real export, so a plain
      // data export a lexicon publishes (`Azure`/`GCP`'s pseudo-parameter
      // namespaces, AWS's `S3Actions`, gitlab's `CI`) is an ordinary
      // identifier value here rather than fold's most common remaining
      // "unresolved identifier" failure. See
      // {@link resolveActiveLexiconExport} for the allowlist, the no-cold-
      // resolution rule, and why callable exports stay out.
      //
      // No `liveSources` edge is recorded for what comes back, unlike the
      // project-file case just below. `liveSources` (chant #1044) exists so
      // that a folded file which captured ANOTHER FILE's objects is
      // invalidated when that file is forced back to run — a fold/run
      // disagreement about identity. A lexicon package has no such duality:
      // it is not a discovered source file, `planFoldTaint` never considers
      // it (it filters to the discovered `files` set), it never falls back to
      // run, and both paths reach it through the identical un-cache-busted
      // `import()` of the identical resolved path — so the object fold
      // captures IS the object the run path holds. There is nothing for the
      // two sides to disagree about, hence nothing to taint.
      const lexiconExport = await resolveActiveLexiconExport(binding, file, session);
      if (lexiconExport) {
        externals.set(localName, lexiconExport.value);
        continue;
      }
      // Every other bare specifier (a non-lexicon vendor package, a lexicon
      // this build didn't load) is left alone here, exactly as before #1064:
      // it resolves lazily, through the pre-existing `importModule`
      // mechanism, only once a constructor/composite-factory/intrinsic tag
      // actually consumes it.
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
      const value = result.exportedValues.get(binding.imported);
      externals.set(localName, value);
      if (hasObjectIdentity(value)) liveSources.add(targetPath);
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
    for (const value of result.exportedValues.values()) {
      if (hasObjectIdentity(value)) {
        liveSources.add(targetPath);
        break;
      }
    }
  }

  return { externals, failures, liveSources };
}

/**
 * True when `value` is something whose IDENTITY matters across the
 * fold/run boundary — any object or function, as opposed to a primitive
 * (chant #1044). Deliberately coarse: an object that merely *contains* a
 * `Declarable` is as identity-bearing as the Declarable itself, and cheaply
 * treating every object as such avoids a deep walk whose only payoff would
 * be keeping a handful of extra files folded inside an entry that already
 * falls back. See {@link FoldFileResult.liveSources}.
 */
function hasObjectIdentity(value: unknown): boolean {
  // chant #1373 — a foldable-function marker is a description of source, not
  // an object the run path could hold a different copy of: a call to it
  // produces the same value folded or run. No identity to disagree about.
  if (isFoldableFunction(value)) return false;
  return value !== null && (typeof value === "object" || typeof value === "function");
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
  // chant #1373 — chant-core's own modules are library code, not project
  // source: their exports are reached by importing them (a helper, a
  // constructor, `params`), never by folding their bodies. Before #1373 every
  // one of them happened to disqualify itself at the scan (each exports a
  // function); now that an exported function is a foldable shape, the
  // exclusion has to be explicit, or a fixture/in-repo import by path would
  // walk fold into chant's own tree and fold `params` to an empty object.
  {
    const root = chantCoreRoot();
    if (file === root || file.startsWith(root + sep)) {
      return { ok: false, reason: "chant's own module is not project source" };
    }
  }
  try {
    const source = await readFile(file, "utf-8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, /* setParentNodes */ true);

    const scan = scanExports(sourceFile);
    if (scan.unfoldableReason) return { ok: false, reason: scan.unfoldableReason };
    if (scan.declarators.length === 0) return { ok: false, reason: "no foldable resource exports" };

    const collected = collectImports(sourceFile);
    const { externals, failures, liveSources } = await buildExternals(file, collected.named, collected.namespaces, session);

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
      lexiconPackages: session.lexiconPackages,
      sandbox: session.sandbox,
      session,
      interpretDepth: 0,
    };

    // chant #1169 — every same-file `const x = new Type(...)`, built once, in
    // source order, before anything references one. See
    // {@link preresolveResourceConsts}.
    const prebuiltResources = await preresolveResourceConsts(ctx);

    // chant #1373 — this file's own functions, callable from its own folds
    // (and, once exported, from an importer's). Registered after the
    // resource pre-pass so a marker never shadows a pre-built instance; a
    // function and a const cannot share a name in valid TypeScript anyway.
    const localFunctions = collectLocalFunctions(sourceFile, ctx);
    for (const [name, marker] of localFunctions) {
      if (!ctx.externals.has(name)) ctx.externals.set(name, marker);
    }

    const entities: FoldedEntity[] = [];
    const exportedValues = new Map<string, unknown>();

    for (const decl of scan.declarators) {
      if (decl.kind === "function") {
        applyResolvedValue(decl.name, localFunctions.get(decl.name), entities, exportedValues);
        continue;
      }

      if (decl.kind === "resource") {
        // chant #1169 — the pre-pass already built this exact node. Reuse that
        // instance rather than constructing a second one: a sibling prop that
        // referenced this resource by name holds the pre-pass object, and if
        // the entity discovery registers were a different one, the reference
        // would have no logical name to resolve against.
        const prebuilt = prebuiltResources.get(decl.node);
        if (prebuilt !== undefined) {
          applyResolvedValue(decl.name, prebuilt, entities, exportedValues);
          continue;
        }
        const result = await resolveResourceEntity(decl.name, decl.node, ctx);
        if (!result.ok) return result;
        applyResolvedValue(decl.name, result.entity, entities, exportedValues);
        continue;
      }

      if (decl.kind === "single") {
        // chant #1373 — `export const f = (…) => …` exports the function
        // marker, exactly like `export function f`; so does an alias of one
        // (`export const g = f`, `f` declared here or imported).
        const aliased = ts.isIdentifier(decl.node) ? ctx.externals.get(decl.node.text) : undefined;
        const marker = localFunctions.get(decl.name) ?? (isFoldableFunction(aliased) ? aliased : undefined);
        if (marker) {
          applyResolvedValue(decl.name, marker, entities, exportedValues);
          continue;
        }
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
        // chant #1054 — identify the destructured export by its BINDING
        // NAMES and the source's callee (`"cluster, nodePool" (destructured
        // from GkeCluster(...))`), never `decl.node.getText()`: for a real
        // composite call that's the entire multi-line source, which buries
        // the actual error after it and breaks any line-oriented consumer of
        // `[fold:run]` output.
        const boundNames = decl.elements.map((el) => el.bindingName).join(", ");
        const source = describeDestructureSource(decl.node);
        try {
          value = (await resolveDeclaratorValue(decl.node, ctx)).value;
        } catch (err) {
          return {
            ok: false,
            reason: `"${boundNames}" (destructured from ${source}) is not foldable: ${describeFoldFailure(err, ctx)}`,
          };
        }
        if (!isIndexableObject(value)) {
          return {
            ok: false,
            reason: `"${boundNames}" (destructured from ${source}) is not foldable: not a composite call or object`,
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
          // chant #1373 — `function f() {…}; export { f }`.
          const marker = localFunctions.get(localNameNode.text);
          if (marker) {
            applyResolvedValue(exportedName, marker, entities, exportedValues);
            continue;
          }
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
        const value = result.exportedValues.get(imported);
        // chant #1044 — a re-export hands another file's OBJECT straight
        // through under this file's name, so it is a live-identity edge
        // exactly like an imported binding is (see `liveSources`).
        if (hasObjectIdentity(value)) liveSources.add(targetPath);
        applyResolvedValue(exportedName, value, entities, exportedValues);
      }
    }

    return { ok: true, entities, exportedValues, liveSources };
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
 * chant #1044 adds the OTHER half of the same hazard, in the opposite
 * direction along the same edges. Forward taint covers "a run file imports a
 * folded file"; it does not cover "a FOLDED file consumed the objects of a
 * file that later got forced to run". Once a plain-call intrinsic can fold,
 * that second case is easy to reach: in `lexicons/aws/examples/lambda-api`,
 * `health-api.ts` folds and captures `params.ts`'s real `Parameter` instance
 * through `Ref(environment)`, while `params.ts` itself is forced to run
 * because a DIFFERENT sibling (`data-bucket.ts`) imports it and falls back.
 * Discovery then collects the run instance and serializes the folded one —
 * the same "Logical name not set" crash described above, arriving from the
 * other side. So `liveSources` (see {@link FoldFileResult}) contributes
 * reverse edges here: a tainted file taints every folded file that captured
 * one of its objects. Only object identity propagates — a file that imported
 * a plain string from a tainted file has nothing to disagree about.
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
/**
 * file -> set of OTHER files in `files` that it relatively imports OR
 * re-exports from, regardless of that file's own fold outcome. Extracted
 * from {@link planFoldTaint} (chant #1083) so a second consumer — the fold
 * blocker dominator ranking (`./fold-rank.ts`) — can walk the exact same
 * project-file edges instead of re-parsing every file with its own
 * specifier-resolution logic. chant #1020 — this counts a namespace import
 * (`import * as ns from "./x"`, previously skipped — see `collectImports`)
 * and a re-export (`export { x } from "./y"`, which `collectImports` never
 * saw at all, since it only looks at `import` declarations): both are real
 * cross-file value dependencies fold's own resolution follows, so both need
 * the same edge an ordinary named import already gets.
 */
export async function buildProjectImportEdges(files: readonly string[]): Promise<Map<string, Set<string>>> {
  const fileSet = new Set(files);
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
      // file itself, which is enough to seed it as tainted below (or, for
      // the dominator ranking, leaves it a childless node).
    }
    edges.set(file, targets);
  }
  return edges;
}

export async function planFoldTaint(
  files: readonly string[],
  wouldFold: ReadonlyMap<string, boolean>,
  liveSources?: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<Set<string>> {
  const fileSet = new Set(files);

  // file -> set of OTHER discovered files it relatively imports OR re-exports
  // from — see {@link buildProjectImportEdges}.
  const edges = await buildProjectImportEdges(files);

  // chant #1044 — reverse edges: consumed-file -> the folded files that
  // captured its objects. Same taint set, same fixpoint walk; see this
  // function's doc for the crash this closes.
  for (const [consumer, sources] of liveSources ?? []) {
    if (!fileSet.has(consumer)) continue;
    for (const source of sources) {
      if (!fileSet.has(source)) continue;
      let back = edges.get(source);
      if (!back) {
        back = new Set<string>();
        edges.set(source, back);
      }
      back.add(consumer);
    }
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
