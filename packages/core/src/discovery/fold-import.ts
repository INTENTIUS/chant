import * as ts from "typescript";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join, isAbsolute, resolve as resolvePath } from "node:path";
import { createRequire } from "node:module";
import { isDeclarable, type Declarable } from "../declarable";
import { isCompositeInstance, type CompositeInstance } from "../composite";
import {
  collectConsts,
  foldResource,
  fold,
  FoldError,
  type FoldedResource,
  type FoldedValue,
  type FoldedIntrinsic,
  type SymbolicValue,
} from "../fold/fold";
import { importModule } from "./import";
import type { IntrinsicDef } from "../lexicon";

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
  | { ok: true; entities: FoldedEntity[] }
  | { ok: false; reason: string };

/** True when `node` carries the `export` modifier. */
function hasExportModifier(node: { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
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

/** `export { a, b as c };` — a LOCAL named-export list (no `moduleSpecifier`), referencing bindings declared earlier in the same file (#1023: commonly a composite call destructured into local `const`s first, then re-exported by name). Distinct from a genuine re-export (`export { a } from "./other"`), which still disqualifies the file below. */
interface NamedExportDeclarator {
  kind: "named-export";
  elements: Array<{ localNameNode: ts.Identifier; exportedName: string }>;
}

type ScanDeclarator = ResourceDeclarator | SingleDeclarator | DestructureDeclarator | NamedExportDeclarator;

interface ScanResult {
  declarators: ScanDeclarator[];
  unfoldableReason?: string;
}

/**
 * Scan a source file's top-level statements for the exported shapes this
 * module can fold: `export const X = new Type(...)` (resources, #1022),
 * `export const X = <expr>` / `export const { a, b } = <expr>` (composite
 * calls and member access on them, #1023), and `export { a, b }` (a local
 * named-export list). Any OTHER export construct (`export default`, a
 * genuine re-export, an exported function/class, `let`/`var`, a destructured
 * export with a rest/nested/defaulted element) makes the whole file
 * ineligible: the module must run so that construct is actually evaluated.
 * This mirrors the epic's hybrid design — fallback is per-module, not
 * per-declaration, because an unfoldable export can itself reference or be
 * referenced by a foldable one in ways only running proves safe.
 */
function scanExports(sourceFile: ts.SourceFile): ScanResult {
  const declarators: ScanDeclarator[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      return { declarators, unfoldableReason: "`export default` is not foldable" };
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier) {
        return { declarators, unfoldableReason: "re-export declaration is not foldable" };
      }
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        return { declarators, unfoldableReason: "export declaration is not foldable" };
      }
      const elements: NamedExportDeclarator["elements"] = [];
      for (const el of statement.exportClause.elements) {
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
    // `new ns.Type(...)` constructor call (or `ns.Foo(...)` composite call)
    // folds its callee text as the dotted string "ns.Type", which will
    // simply miss this map — handled uniformly below as an unresolved
    // callee, falling back to run.
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
  /** Memoizes by initializer node so a composite call referenced by several member accesses / destructured names is invoked exactly once — matching what actually running the file would do. */
  memo: Map<ts.Expression, Promise<LiveResolution>>;
  /** Lexicon-registered intrinsic tags (chant #1039) — passed through to
   * {@link fold}/{@link foldResource} so a registered tagged template
   * (e.g. AWS `Sub`\`...\`) folds instead of throwing "unregistered tagged
   * template intrinsic". Empty when the caller (`discover()`) wasn't given any. */
  intrinsics: readonly IntrinsicDef[];
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
    if (!binding) return undefined;
    const resolvedSource = await resolveMemoized(binding.source, ctx);
    if (resolvedSource === undefined) return undefined;
    if (binding.propKey === undefined) return resolvedSource;
    if (!isCompositeInstance(resolvedSource.value)) {
      throw new Error(`destructured member "${binding.propKey}" is not on a composite value`);
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
    if (!isCompositeInstance(base.value)) {
      throw new Error(`property access ".${key}" on a non-composite value is not foldable`);
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
    throw new Error(`call expression as a value is not foldable: ${node.expression.getText()}(...)`);
  }
  const calleeName = node.expression.text;
  const binding = ctx.imports.get(calleeName);
  if (!binding) {
    throw new Error(`call expression as a value is not foldable: ${calleeName}(...)`);
  }

  let modulePath: string;
  try {
    modulePath = resolveModulePath(binding.specifier, ctx.file);
  } catch (err) {
    throw new Error(
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
    mod = await importModule(modulePath);
  } catch (err) {
    throw new Error(
      `could not import "${binding.specifier}" to resolve "${calleeName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const Fn = mod[binding.imported];
  if (typeof Fn !== "function") {
    throw new Error(`"${binding.imported}" from "${binding.specifier}" is not a function`);
  }

  const args: unknown[] = [];
  for (const argNode of node.arguments) {
    const live = await resolveLiveValue(argNode, ctx);
    // chant #1039 — a folded (non-live) argument may itself contain a
    // registered intrinsic tagged template; revive it into the real value
    // before the composite factory actually runs on it (see the "Intrinsic
    // revival" section below `resolveResourceEntity` uses the same way).
    args.push(live !== undefined ? live.value : await reviveFoldedValue(fold(argNode, ctx.consts, ctx.intrinsics), ctx, false));
  }

  return (Fn as (...fnArgs: unknown[]) => unknown)(...args);
}

/** How a fully-resolved value should be applied to the folded entities list. */
function applyResolvedValue(
  name: string,
  value: unknown,
  entities: FoldedEntity[],
): { ok: true } | { ok: false; reason: string } {
  if (value === undefined || value === null) {
    // A legitimate "produces nothing" result — e.g. an optional composite
    // member that wasn't created (`web.pdb` when `minAvailable` wasn't set).
    // The run path would export `undefined` here too, which `collectEntities`
    // silently ignores (not a Declarable/array/CompositeInstance) — match it.
    return { ok: true };
  }
  if (isDeclarable(value) || isCompositeInstance(value)) {
    entities.push([name, value as Declarable | CompositeInstance]);
    return { ok: true };
  }
  return { ok: false, reason: `exported "${name}" did not fold to a Declarable or composite instance` };
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
    throw new Error(`"${name}" is not a resolvable import`);
  }

  let modulePath: string;
  try {
    modulePath = resolveModulePath(binding.specifier, ctx.file);
  } catch (err) {
    throw new Error(
      `could not resolve import "${binding.specifier}" for "${name}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let mod: Record<string, unknown>;
  try {
    mod = await importModule(modulePath);
  } catch (err) {
    throw new Error(
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
    throw new Error(`symbol "${text}" is not a simple dotted import reference`);
  }
  const [root, ...path] = text.split(".");
  let value = await resolveImportedExport(root, ctx);
  for (const key of path) {
    if (value === null || value === undefined) {
      throw new Error(`symbol "${text}": "${root}" has no "${key}"`);
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
      throw new Error(`intrinsic tag "${intrinsic.__intrinsic}" did not resolve to a function`);
    }
    const revivedValues: unknown[] = [];
    for (const v of intrinsic.values) revivedValues.push(await reviveFoldedValue(v, ctx, true));
    return (Fn as (...fnArgs: unknown[]) => unknown)(intrinsic.strings, ...revivedValues);
  }

  if ("__attrRef" in value) {
    if (insideIntrinsic) {
      throw new Error(
        "a same-file resource reference inside a folded intrinsic's interpolation is not foldable yet",
      );
    }
    return value;
  }

  if ("__resource" in value) {
    // fold() itself already rejects a nested `new Type(...)` as a value
    // (see its own comment) — this is defensive, not a reachable path today.
    throw new Error("nested resource as a value is not foldable");
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
    spec = foldResource(node, ctx.consts, ctx.intrinsics);
  } catch (err) {
    if (err instanceof FoldError) {
      return { ok: false, reason: `"${name}" is not foldable: ${err.message}` };
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
      reason: `"${name}" is not foldable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const typeName = spec.__resource;
  const binding = ctx.imports.get(typeName);
  if (!binding) {
    return { ok: false, reason: `constructor "${typeName}" for "${name}" is not a resolvable import` };
  }

  let modulePath: string;
  try {
    modulePath = resolveModulePath(binding.specifier, ctx.file);
  } catch (err) {
    return {
      ok: false,
      reason: `could not resolve import "${binding.specifier}" for "${typeName}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Same import mechanism as `resolveCallExpression` above — see its comment.
  let mod: Record<string, unknown>;
  try {
    mod = await importModule(modulePath);
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
// Entry point.
// ─────────────────────────────────────────────────────────────────────────

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
 *   target lexicons' combined `intrinsics()`.
 */
export async function tryFoldFile(
  file: string,
  intrinsics: readonly IntrinsicDef[] = [],
): Promise<FoldFileResult> {
  try {
    const source = await readFile(file, "utf-8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, /* setParentNodes */ true);

    const scan = scanExports(sourceFile);
    if (scan.unfoldableReason) return { ok: false, reason: scan.unfoldableReason };
    if (scan.declarators.length === 0) return { ok: false, reason: "no foldable resource exports" };

    const ctx: ResolveCtx = {
      file,
      consts: collectConsts(sourceFile),
      locals: collectLocalBindings(sourceFile),
      imports: collectImports(sourceFile),
      memo: new Map(),
      intrinsics,
    };

    const entities: FoldedEntity[] = [];

    for (const decl of scan.declarators) {
      if (decl.kind === "resource") {
        const result = await resolveResourceEntity(decl.name, decl.node, ctx);
        if (!result.ok) return result;
        entities.push([decl.name, result.entity]);
        continue;
      }

      if (decl.kind === "single") {
        let resolved: LiveResolution;
        try {
          resolved = await resolveLiveValue(decl.node, ctx);
        } catch (err) {
          return { ok: false, reason: `"${decl.name}" is not foldable: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (resolved === undefined) {
          return {
            ok: false,
            reason: `exported "${decl.name}" is not a \`new Type(...)\` resource declaration (composite call or plain value)`,
          };
        }
        const applied = applyResolvedValue(decl.name, resolved.value, entities);
        if (!applied.ok) return applied;
        continue;
      }

      if (decl.kind === "destructure") {
        let resolved: LiveResolution;
        try {
          resolved = await resolveLiveValue(decl.node, ctx);
        } catch (err) {
          return {
            ok: false,
            reason: `destructured export from "${decl.node.getText()}" is not foldable: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        if (resolved === undefined || !isCompositeInstance(resolved.value)) {
          return {
            ok: false,
            reason: `destructured export from "${decl.node.getText()}" is not foldable (not a composite call)`,
          };
        }
        const instance = resolved.value as unknown as Record<string, unknown>;
        for (const { propKey, bindingName } of decl.elements) {
          const applied = applyResolvedValue(bindingName, instance[propKey], entities);
          if (!applied.ok) return applied;
        }
        continue;
      }

      // decl.kind === "named-export" — reuse resolveLiveValue's own identifier
      // handling (ctx.locals lookup + memoized destructured-member extraction)
      // rather than duplicating it here.
      for (const { localNameNode, exportedName } of decl.elements) {
        let resolved: LiveResolution;
        try {
          resolved = await resolveLiveValue(localNameNode, ctx);
        } catch (err) {
          return {
            ok: false,
            reason: `exported "${exportedName}" is not foldable: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        if (resolved === undefined) {
          return {
            ok: false,
            reason: `exported "${exportedName}" is not a \`new Type(...)\` resource declaration (composite call or plain value)`,
          };
        }
        const applied = applyResolvedValue(exportedName, resolved.value, entities);
        if (!applied.ok) return applied;
      }
    }

    return { ok: true, entities };
  } catch (err) {
    // Any unexpected failure degrades to "fall back to run" rather than
    // taking discovery down with it — fold is opt-in, not a new failure mode.
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
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
 * A sibling file like `alb.ts` that does
 * `import { network } from "./network"; ... vpcId: network.vpc.VpcId`
 * can't fold that cross-file reference (cross-file identifier resolution is
 * #1020, out of scope here) and falls back to run — but running `alb.ts`
 * for real re-executes `import "./network"` for real too, which (via
 * Node's module cache) produces the SAME `network.ts` module instance for
 * every OTHER run-fallback file that imports it, but a DIFFERENT one than
 * the object `tryFoldFile("network.ts")` already built. `alb.ts`'s AttrRef
 * for `network.vpc.VpcId` then points at an object that's never in the
 * `entities` map (only the folded one is), so it can never be assigned a
 * logical name and serialization fails outright — not drift, a crash.
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
 */
export async function planFoldTaint(
  files: readonly string[],
  wouldFold: ReadonlyMap<string, boolean>,
): Promise<Set<string>> {
  const fileSet = new Set(files);

  // file -> set of OTHER discovered files it relatively imports, regardless
  // of that file's own fold outcome (taint needs the full edge set to
  // propagate transitively).
  const edges = new Map<string, Set<string>>();
  for (const file of files) {
    const targets = new Set<string>();
    try {
      const source = await readFile(file, "utf-8");
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      for (const binding of collectImports(sourceFile).values()) {
        if (!binding.specifier.startsWith(".") && !isAbsolute(binding.specifier)) continue; // package import, not a sibling source file
        let resolved: string;
        try {
          resolved = resolveModulePath(binding.specifier, file);
        } catch {
          continue;
        }
        if (fileSet.has(resolved)) targets.add(resolved);
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
