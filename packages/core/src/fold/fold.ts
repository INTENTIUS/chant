import * as ts from "typescript";
import { relative } from "node:path";
import { intrinsicCallFolds, intrinsicCallFoldsEagerly, intrinsicTagFolds, type IntrinsicDef } from "../lexicon";
import {
  SUPPORTED_BINARY_OPERATORS,
  SUPPORTED_UNARY_OPERATORS,
  UNSUPPORTED_OBJECT_MEMBER_MESSAGE,
  UNSUPPORTED_UNARY_MESSAGE,
  briefNodeText,
  callExpressionMessage,
  computedPropertyNameMessage,
  dynamicElementAccessMessage,
  isLiteralElementKey,
  isLiteralPropertyName,
  unsupportedBinaryMessage,
  unsupportedExpressionMessage,
  type SubsetRuleId,
} from "./subset";
import { isFoldableHelperName } from "./foldable-helpers";

/**
 * fold — static AST value reducer (chant #1026/#1021/#1024, part of epic #1019)
 *
 * Reduces a single-file TypeScript expression AST to a value with NO
 * module execution. The node-kind/operator/key subset it covers — literals,
 * template interpolation, object/array literals (incl. spread), `const`
 * identifier resolution, property and element access (incl. the
 * cross-resource `{ __attrRef }` case, literal-key-only), unary `!`/`-`,
 * the binary operators `+ - * / === !== > < >= <=`, short-circuit
 * `&& || ??`, conditional expressions, `as`/`satisfies`/`!`/parenthesized
 * unwrapping, a nested `new Type({...})` resource-as-value (chant #1169), and
 * registered lexicon intrinsic tagged templates — is defined ONCE, in
 * {@link "./subset"} ({@link findSubsetViolation}), and shared with EVL001/EVL003
 * ({@link "../lint/rules/evl001-non-literal-expression"}), so the linted
 * subset and the folded subset can never drift apart (#1024).
 *
 * chant #1169 closed the largest of the documented fold/EVL divergences in the
 * process: a nested `new Type(...)` used as a value was shape-valid for
 * `./subset` and rejected by `fold()`, because `fold()` could only produce the
 * `{__resource, props}` envelope and nothing constructed it. Now it folds to
 * that envelope and ../discovery/fold-import.ts constructs the REAL instance
 * from it. The remaining divergences are the resolution-dependent ones
 * ./subset's own module doc enumerates, plus one this change adds in the same
 * safe direction: a BARE identifier bound to a same-file `new` is shape-valid
 * there and rejected here, because folding it would build a duplicate of a
 * resource discovery already registered — see {@link fold}'s identifier branch.
 *
 * A `CallExpression` has almost no case — a function call as a value is
 * structurally unrepresentable, not merely linted against. Composite
 * factory calls are out of scope here (epic Phase 5, #1023). There are
 * exactly two exceptions, both closed allowlists of names declared
 * somewhere a human had to write them down, and both reducing to a symbolic
 * envelope that executes nothing here:
 *
 *   - a call to a REGISTERED chant authoring helper
 *     ({@link "./foldable-helpers"}, chant #1082) → {@link FoldedHelperCall};
 *   - a call to a lexicon intrinsic whose lexicon registered it AND opted
 *     its call form in ({@link intrinsicCallFolds}, ../lexicon.ts, chant
 *     #1044) → {@link FoldedIntrinsicCall}, the same `{__intrinsic}` family
 *     the tagged-template form already reduces to.
 *
 * chant #1373 adds a third, the only one that evaluates rather than
 * enveloping: a call to a PROJECT-LOCAL function — declared in this file or
 * imported from a sibling project file — whose body is itself inside the
 * fold subset. ../discovery/fold-import.ts hands such a function in through
 * `externals` as a {@link FoldableFunction}, and {@link callFoldableFunction}
 * folds its body against the defining module's scope with the folded
 * arguments bound. Still nothing is imported or run.
 *
 * A bare composite factory call (`Checkout({...})` on its own) is still out
 * of scope (epic Phase 5, #1023 covers only interpreting a factory's OWN
 * body, not consuming its result as a value elsewhere). chant #1174 adds one
 * narrow exception at the PROPERTY-ACCESS level rather than here: the
 * `<Identifier>(...).step` idiom — see {@link FoldedCompositeStepCall} on the
 * property-access branch below. A call with no `.step` narrowing, or any
 * other member, still throws from this branch exactly as before.
 *
 * chant #1966 adds a fourth call shape, and a method call on top of any of
 * the four: a lexicon-package function its lexicon registered with
 * {@link intrinsicCallFoldsEagerly} (../lexicon.ts) evaluates eagerly —
 * unlike the other three, which envelope for later revival — because its
 * usual use (`` `${matrix("os")}` ``) coerces the result via `String()` at
 * fold time, before any revival would run. A `CallExpression` whose callee is
 * a property access — `github.actor.toString()`, `[...].join(",")`,
 * `matrix("os").toString()` — folds its receiver and calls the named method
 * on it directly, PROVIDED the receiver is a real value and not one of
 * fold's own symbolic envelopes (see {@link isFoldSymbolicEnvelope}); nothing
 * about the method name is otherwise restricted.
 *
 * Everything else — an ordinary package function, an array `.map`, a
 * registered name shadowed by a local binding — still throws.
 *
 * Cross-file identifier resolution (chant #1020): `consts` alone is always
 * this file's own top-level bindings — that part stays single-file, and
 * nothing about the supported node-kind subset changes. But an identifier
 * `fold()` can't find in `consts` isn't necessarily a dead end: the optional
 * `externals` map (populated by ../discovery/fold-import.ts, which owns the
 * module graph traversal) lets a caller pre-resolve an *imported* binding to
 * its real value — a plain value for an imported `const`, or the REAL,
 * already-constructed `Declarable`/`CompositeInstance` for a name bound to a
 * resource/composite in the defining module — and `fold()` just returns it
 * for the identifier, unchanged. This is why a bare object/array bracket
 * index a few lines down (`obj[key]`) is enough to make `network.vpc.VpcId`
 * fold correctly once `network` resolves via `externals` to the real,
 * shared composite instance object: indexing a live class instance the same
 * way as a plain object returns its real getter's real `AttrRef`, wired to
 * the real shared parent — see fold-import.ts's module doc for why that
 * shared identity is the entire hard part of #1020.
 */

/**
 * The result of folding an AST node: a plain value, a symbolic reference to
 * a sibling resource's attribute, a folded intrinsic tagged template, an
 * unresolved external symbol chain, or a folded resource spec.
 */
export type FoldedValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FoldedValue[]
  | { [key: string]: FoldedValue }
  | AttrRefValue
  | FoldedIntrinsic
  | FoldedHelperCall
  | SymbolicValue
  | FoldedResource
  | FoldedCompositeStepCall;

/**
 * Symbolic reference produced when a property/element access resolves to an
 * attribute of another `const`-declared resource in the same file, e.g.
 * `bucket.name` (or `bucket["name"]`) where `bucket` is
 * `const bucket = new S3Bucket({...})`.
 *
 * This is the SAME envelope `AttrRef.prototype.toJSON()` produces at
 * runtime ({@link "../attrref"}) — `serializer-walker.ts`'s `walkValue`
 * already recognizes a plain `{ __attrRef }` object as an AttrRef envelope
 * (it doesn't require a live `AttrRef` instance), so this is not an
 * invented shape: it's the existing envelope, produced without running the
 * module that would otherwise construct the real `AttrRef`.
 */
export interface AttrRefValue {
  __attrRef: { entity: string; attribute: string };
}

/**
 * The result of folding a registered lexicon intrinsic tagged template
 * (e.g. `Sub\`${AWS.StackName}-x\``) to its node form: tag name, cooked
 * template string parts, and folded interpolated values (in order).
 * Mirrors the runtime call shape `Tag(strings, ...values)` so a later
 * build path can replay it into the real intrinsic object (#1022).
 */
export type FoldedIntrinsic = FoldedIntrinsicTag | FoldedIntrinsicCall;

/** The tagged-template form: `Sub\`${x}-y\`` — see {@link FoldedIntrinsic}. */
export interface FoldedIntrinsicTag {
  __intrinsic: string;
  strings: string[];
  values: FoldedValue[];
}

/**
 * The plain-call form of a registered, opted-in lexicon intrinsic
 * (chant #1044) — `Ref(bucket)`, `Concat("a", b)`, `GetAtt("Fn", "Arn")`.
 * Same `__intrinsic` key as the tagged-template form, so the same revival
 * branch handles both and nothing downstream learns a new envelope; the
 * payload differs because the call shape does — positional `args` mirroring
 * `Name(...args)`, where the tag form mirrors `Name(strings, ...values)`.
 *
 * Symbolic, exactly like the tag form: `fold()` executes nothing, it only
 * records that a registered intrinsic was called and with what. The real
 * function is resolved through the folding file's own imports and invoked by
 * `../discovery/fold-import.ts`'s `reviveFoldedValue`.
 */
export interface FoldedIntrinsicCall {
  __intrinsic: string;
  args: FoldedValue[];
}

/**
 * The result of folding a call to a registered chant authoring helper
 * (chant #1082) — e.g. `phase("Apply", [...])`, `output(ref, "oX")`. Holds
 * the helper's name and its folded arguments, in source order.
 *
 * Symbolic, exactly like {@link FoldedIntrinsic}: `fold()` executes nothing,
 * it only records that a registered helper was called and with what. The real
 * function is resolved through the folding file's own imports and invoked by
 * `../discovery/fold-import.ts`'s `reviveFoldedValue`, which is also where
 * the "is this name actually bound to chant's own helper" check lives. See
 * {@link "./foldable-helpers"} for the allowlist and why it is closed.
 */
export interface FoldedHelperCall {
  __helper: string;
  args: FoldedValue[];
}

/**
 * A sub-expression inside a folded intrinsic that fold could not reduce to
 * a value without resolving an identifier from outside this file — e.g. an
 * imported pseudo-parameter namespace access like `AWS.StackName`.
 * Cross-file import resolution is #1020; until then the raw source text is
 * preserved verbatim (never stringified, never rejected) instead of being
 * treated as an unresolved-identifier error. Only appears inside a folded
 * intrinsic's `values` — see {@link foldIntrinsicValue}.
 */
export interface SymbolicValue {
  __symbol: string;
}

/**
 * The result of folding a resource constructor: `new Type({ ...props })`.
 *
 * chant #1169 — produced for a NESTED `new Type(...)` used as a value too, not
 * just for a file's own top-level resource declaration. It is symbolic in
 * exactly the sense {@link FoldedIntrinsic} and {@link FoldedHelperCall} are:
 * `fold()` executes nothing, it records which constructor the source named and
 * with what arguments. ../discovery/fold-import.ts resolves that name through
 * the folding file's own imports and calls the real class, so a folded
 * construction and a run construction are the same construction. An envelope
 * must never reach a serializer — see the `new` branch of {@link fold}.
 */
export interface FoldedResource {
  __resource: string;
  props: { [key: string]: FoldedValue };
  /**
   * The constructor's optional second argument — CFN-style resource-level
   * attributes (`DependsOn`, `Condition`, `DeletionPolicy`,
   * `UpdateReplacePolicy`, `CreationPolicy`, `Metadata`, …) some lexicons
   * accept alongside `props` (see `createResource`'s `attributes` param,
   * ../runtime.ts). Present only when the source actually passed one.
   */
  attributes?: { [key: string]: FoldedValue };
  /**
   * chant #1082 — every constructor argument, folded, in source order. Present
   * only when the argument list is NOT the classic `(props)` / `(props,
   * attributes)` shape — most often because the props object isn't first
   * (`new Parameter("String", {...})`, whose signature is `(type, props)`).
   *
   * When present this is authoritative: the entity is constructed by spreading
   * it, so the constructor receives exactly what the source wrote. `props`
   * alongside it is the first object-literal argument, reported for readers,
   * never re-passed (which would double-count it).
   */
  args?: FoldedValue[];
}

/**
 * The result of folding the `<Identifier>(...).step` composite-consumer
 * idiom (chant #1174) — `Checkout({...}).step`, `SetupNode({...}).step`,
 * every lexicon's single-action `Composite()` wrapper embedded inline in a
 * `Job`'s `steps` array, exactly as composites.mdx documents it. This is the
 * SAME shape chant #1544 already carved out of EVL001 as a documented,
 * correct fallback rather than a lint error
 * ({@link "./subset"}'s `allowCompositeStepAccess`) — `fold()` never set
 * that flag, so before this it fell back to run every time, as designed.
 * This is the fold-side counterpart that actually reduces it instead.
 *
 * Symbolic, exactly like {@link FoldedIntrinsic}/{@link FoldedHelperCall}:
 * `fold()` executes nothing here. It records which composite factory the
 * source named, its folded arguments (in source order), and that the result
 * was immediately narrowed to `.step`. ../discovery/fold-import.ts's bridge
 * resolves the callee through the folding file's own imports — a
 * project-file registered `Composite` is interpreted (chant #1023's existing
 * machinery), anything else (every lexicon-package composite, which is what
 * `Checkout`/`SetupNode` are) is imported and invoked for real, exactly as a
 * top-level `export const x = Checkout({...})` already does via
 * `resolveCallExpression` — and then reads `.step` off the REAL result.
 *
 * Deliberately narrower than "any call, any member access": the member name
 * is fixed to `"step"`, matching the one idiom ../fold/subset.ts's EVL
 * carve-out already permits. `fold()` may never accept a shape EVL doesn't
 * (see that module's doc, point 2c, for the direction it is not allowed to
 * be wrong in) — widening past `.step` here without widening the shared
 * predicate in lockstep would open exactly that gap.
 */
export interface FoldedCompositeStepCall {
  __compositeStep: string;
  args: FoldedValue[];
}

/**
 * One entry per exported `const` resource declaration in {@link foldModule}'s
 * result. The `ok: false` case surfaces the same located, rule-id-tagged
 * shape as {@link FoldError} (#1024) — `error` stays the formatted message
 * string for backward-compat display, while `ruleId`/`line`/`column` let a
 * caller cite the exact same rule id + position an EVL diagnostic for the
 * same construct would.
 */
export type FoldModuleEntry =
  | { ok: true; spec: FoldedResource }
  | { ok: false; error: string; ruleId: SubsetRuleId; line: number; column: number };

/**
 * Error thrown when a node cannot be folded to a value without executing
 * code. Carries the node's source position (1-based, matching `LintError`)
 * so callers can report a located diagnostic, and the id of the EVL rule
 * that flags the same construct (#1024) — "EVL001" (the general
 * not-statically-evaluable umbrella) unless the rejection is specifically a
 * dynamic element-access key, which is "EVL003"'s construct. A rejection
 * with no EVL equivalent (unresolved identifier, unregistered intrinsic tag,
 * spread of a value that turns out not to be an object/array — all
 * environment/value-dependent, see {@link "./subset"}'s module doc) still
 * defaults to "EVL001" since that's the closest umbrella rule, even though
 * EVL can't actually detect it ahead of a real fold.
 *
 * chant #1020 hang fix — every `FoldError` is thrown for a routine, EXPECTED
 * outcome (this node's shape isn't in the fold subset) and is ALWAYS caught
 * a few frames up (`tryFoldFileCore`'s own top-level catch, ultimately),
 * reduced to `.message`; `.stack` is never read anywhere on this path. V8
 * still eagerly walks live JS frames to populate the (lazy) `.stack` getter's
 * backing data at CONSTRUCTION time regardless of whether it's ever read —
 * cheap for a shallow call stack, but expensive once the surrounding
 * functions are hot enough for V8 to aggressively inline them (every corpus
 * entry re-triggers the same call shapes across `foldFileMemoized` ->
 * `buildExternals` -> `tryFoldFileCore` -> `resolveDeclaratorValue` ->
 * `resolveLiveValue` -> `resolveCallExpression`/`fold`, chant #1020's
 * cross-file resolution making that chain several layers deeper than the
 * pre-#1020 single-file fold ever needed): capturing a stack from deep,
 * optimized/inlined frames requires V8 to reconstruct them from deopt
 * metadata, confirmed via `sample` to dominate CPU during the observed
 * multi-minute stall (`Isolate::CaptureAndSetErrorStack` /
 * `OptimizedJSFrame::Summarize` / `DeoptTranslationIterator`). Most files in
 * the corpus (77/98 entries have at least one run-fallback file) throw one
 * of these, so the cost compounds across a build. `Error.stackTraceLimit = 0`
 * for the duration of `super()` makes V8 capture zero frames — free
 * regardless of stack depth/optimization state — then the limit is restored
 * immediately, so it doesn't suppress a real stack trace anywhere else in
 * the process.
 */
export class FoldError extends Error {
  readonly line: number;
  readonly column: number;
  readonly ruleId: SubsetRuleId;

  constructor(message: string, line: number, column: number, ruleId: SubsetRuleId = "EVL001") {
    const prevStackTraceLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    super(`${line}:${column} - ${message}`);
    Error.stackTraceLimit = prevStackTraceLimit;
    this.name = "FoldError";
    this.line = line;
    this.column = column;
    this.ruleId = ruleId;
  }
}

/**
 * A project-local function `fold()` can CALL — chant #1373.
 *
 * Produced by ../discovery/fold-import.ts for every top-level function a
 * project file declares (`export function f(...) {...}`, `export const f =
 * (...) => ...`, and their non-exported siblings) and placed in the folding
 * file's `externals` under the function's name, so a call through a bare
 * identifier bound to one evaluates STATICALLY: the arguments fold in the
 * caller's scope, the parameters are bound, and the body folds in the
 * DEFINING module's scope (`consts`/`externals` here are that module's, not
 * the caller's). Nothing is imported and nothing runs — this is the same
 * "evaluate the source instead of the module" move #1023 makes for a
 * composite factory body, applied to a plain function.
 *
 * Why this exists: the advice every chant project gets is to read build
 * parameters through a small helper (`optionalAccountId(params.accountId)`)
 * so defaulting and validation live in one place. Before #1373 a call to
 * that helper was "a function call as a value" and unfoldable, and because
 * fallback is per file and taint propagates along imports, ONE helper call
 * at the top of a parameter file demoted every stack that imported it.
 *
 * The value is a marker, never a real function: a folded file's export
 * namespace may carry one (an importer's `buildExternals` picks it up by
 * name), and `fold()` refuses it anywhere a VALUE is expected — a function
 * object cannot be serialized, and the run path's export namespace holds the
 * real function the collector ignores, so ignoring the marker matches.
 *
 * Not a `FoldedValue`: it never appears inside a folded tree.
 */
export class FoldableFunction {
  constructor(
    /** The binding name, for diagnostics. */
    readonly name: string,
    readonly fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
    /** Absolute path of the defining module, for diagnostics. */
    readonly file: string,
    /**
     * The defining module's top-level `const` initializers, with every
     * `new`-bound one already REMOVED — a body that mentions one reads the
     * live instance out of `externals` instead (the same object the module's
     * own fold registered), never a by-name `{__attrRef}` that would name an
     * entity of the wrong file once revived in the caller.
     */
    readonly consts: Map<string, ts.Expression>,
    /** The defining module's resolved imports, its own pre-built resources, and its own sibling functions. Read live, never copied, so a function declared before a const it reads still sees that const's value. */
    readonly externals: ReadonlyMap<string, unknown>,
    /** Why an import of the defining module did NOT resolve, by local name — enriches an "unresolved identifier" inside the body. */
    readonly failures?: ReadonlyMap<string, string>,
  ) {}

  /**
   * Set once a call to this function has RETURNED a live object (a value
   * with a prototype — a pre-built resource instance of the defining module,
   * say) into a caller. The caller then shares that object's identity with
   * the defining module exactly as an imported resource binding would, and
   * fold-import.ts records the same `liveSources` edge for it so the two
   * files fold or run together. A function that returns only plain data never
   * sets this, which is what keeps a parameter helper from tainting anything.
   */
  leakedIdentity = false;
}

/** True when `value` (or anything inside it, through plain objects and arrays) carries a prototype other than Object/Array — i.e. is a live instance, not folded data. */
function carriesLiveObject(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value !== "object") return typeof value === "function";
  if (seen.has(value)) return false;
  seen.add(value);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return true;
  for (const inner of Object.values(value)) {
    if (carriesLiveObject(inner, seen)) return true;
  }
  return false;
}

export function isFoldableFunction(value: unknown): value is FoldableFunction {
  return value instanceof FoldableFunction;
}

/** A binding element a folded function can bind plainly: `{ a }` / `{ a: b }`, no rest, default, or nested pattern. */
function plainBindingKey(el: ts.BindingElement): string | undefined {
  if (el.dotDotDotToken || el.initializer || !ts.isIdentifier(el.name)) return undefined;
  const key = el.propertyName ?? el.name;
  if (ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key)) return key.text;
  return undefined;
}

/**
 * The SHAPE half of what makes a project-local function foldable (chant
 * #1373) — a reason string, or `undefined` when the function is admissible.
 * Deliberately the same statement-level contract #1023 gives a composite
 * factory body: parameters bound plainly (an identifier, optionally
 * defaulted, or a flat object pattern), and a body that is either a single
 * expression or `const` declarations followed by one `return`. Every
 * expression inside is then folded by {@link fold} itself, so the expression
 * subset is defined exactly once — with the additions {@link fold} refuses
 * INSIDE a function body (a `new`, a tagged template, a registered helper or
 * intrinsic call), because each of those reduces to an envelope revived
 * against the CALLER's imports, which are not the scope the body was written
 * in.
 */
export function findFunctionSubsetViolation(
  fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
): string | undefined {
  if (fn.asteriskToken) return "a generator function is not foldable";
  if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return "an async function is not foldable";
  if (!fn.body) return "a function without a body (an overload signature) is not foldable";

  for (const param of fn.parameters) {
    if (param.dotDotDotToken) return "a rest parameter is not foldable";
    if (ts.isIdentifier(param.name)) continue;
    if (ts.isObjectBindingPattern(param.name)) {
      for (const el of param.name.elements) {
        if (plainBindingKey(el) === undefined) {
          return "a destructured parameter with a rest, default, or nested element is not foldable";
        }
      }
      continue;
    }
    return "an array-destructured parameter is not foldable";
  }

  if (!ts.isBlock(fn.body)) return undefined;

  const statements = fn.body.statements;
  for (let i = 0; i < statements.length; i += 1) {
    const statement = statements[i];
    const last = i === statements.length - 1;

    if (ts.isReturnStatement(statement)) {
      if (!last) return "an early `return` is not foldable";
      continue;
    }
    if (!ts.isVariableStatement(statement)) {
      return `\`${ts.SyntaxKind[statement.kind]}\` in a function body is not foldable — only \`const\` declarations and a final \`return\` are`;
    }
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      return "`let`/`var` in a function body is not foldable";
    }
    for (const decl of statement.declarationList.declarations) {
      if (!decl.initializer) return "an uninitialized `const` in a function body is not foldable";
      if (ts.isIdentifier(decl.name)) continue;
      if (ts.isObjectBindingPattern(decl.name)) {
        for (const el of decl.name.elements) {
          if (plainBindingKey(el) === undefined) {
            return "a destructured `const` with a rest, default, or nested element is not foldable";
          }
        }
        continue;
      }
      return "an array-destructured `const` in a function body is not foldable";
    }
  }
  return undefined;
}

/**
 * How many project-local function bodies are being folded around the current
 * `fold()` call — 0 at a file's own top level. Two jobs: terminate a function
 * that (directly or through another) calls itself, which has no fixpoint and
 * no file boundary for fold-import's cycle detection to notice; and tell the
 * envelope-producing branches of {@link fold} that they are inside a body,
 * where an envelope must not be produced (see {@link findFunctionSubsetViolation}).
 */
let functionBodyDepth = 0;
const MAX_FUNCTION_CALL_DEPTH = 32;

function insideFunctionBody(node: ts.Node, what: string): FoldError | undefined {
  if (functionBodyDepth === 0) return undefined;
  return foldError(node, `${what} inside a folded function body is not foldable`);
}

function fileLabel(file: string): string {
  const rel = relative(process.cwd(), file);
  return rel.startsWith("..") ? file : rel;
}

/**
 * Evaluate a call to a project-local function (chant #1373) — see
 * {@link FoldableFunction}. Arguments fold in the caller's scope (`consts`/
 * `externals`); the body folds in the callee's, with the parameters bound on
 * top. Any failure inside the body is re-thrown at the CALL site, naming the
 * callee, its file and the position inside it, and the reason — so the
 * `[fold:run]` line for the importing file says which helper to fix and why,
 * rather than the bare "function call as a value" it said before.
 */
function callFoldableFunction(
  callee: FoldableFunction,
  node: ts.CallExpression,
  consts: Map<string, ts.Expression>,
  intrinsics: readonly IntrinsicDef[],
  externals: ReadonlyMap<string, unknown> | undefined,
): FoldedValue {
  const label = `call to "${callee.name}" (${fileLabel(callee.file)})`;
  const violation = findFunctionSubsetViolation(callee.fn);
  if (violation) throw foldError(node, `${label} is not foldable: ${violation}`);
  if (functionBodyDepth >= MAX_FUNCTION_CALL_DEPTH) {
    throw foldError(node, `${label} is not foldable: call depth exceeded — is it recursive?`);
  }

  const args: FoldedValue[] = [];
  for (const arg of node.arguments) {
    if (ts.isSpreadElement(arg)) throw foldError(arg, `${label} is not foldable: a spread argument is not foldable`);
    args.push(fold(arg, consts, intrinsics, externals));
  }

  const bodyConsts = new Map(callee.consts);
  const bodyExternals = new Map(callee.externals);
  const bind = (name: string, value: unknown): void => {
    // A parameter or body binding SHADOWS a module-level const of the same
    // name — `fold()` consults `consts` before `externals`.
    bodyConsts.delete(name);
    bodyExternals.set(name, value);
  };
  const destructure = (pattern: ts.ObjectBindingPattern, value: unknown): void => {
    if (value === null || typeof value !== "object") {
      throw foldError(pattern, `destructured source in \`${briefNodeText(pattern)}\` is not an object`);
    }
    for (const el of pattern.elements) {
      bind((el.name as ts.Identifier).text, (value as Record<string, unknown>)[plainBindingKey(el) as string]);
    }
  };

  functionBodyDepth += 1;
  try {
    const result = evaluateFunctionBody(callee, args, bodyConsts, bodyExternals, intrinsics, bind, destructure);
    // Live objects that ARRIVED through the arguments are the caller's own
    // already; only one the body produced from its module's scope is new.
    if (!callee.leakedIdentity && carriesLiveObject(result) && !args.some((arg) => carriesLiveObject(arg))) {
      callee.leakedIdentity = true;
    }
    return result;
  } catch (err) {
    if (!(err instanceof FoldError)) throw err;
    // The inner message is positioned inside the CALLEE file. Strip that
    // prefix and re-anchor at the call site: callee, its file and position,
    // then the reason.
    const prefix = `${err.line}:${err.column} - `;
    const inner = err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message;
    let reason = inner;
    const unresolved = /^unresolved identifier: (\w+)$/.exec(inner);
    if (unresolved && callee.failures?.has(unresolved[1])) {
      reason = `${inner} (${callee.failures.get(unresolved[1])})`;
    }
    throw foldError(
      node,
      `${label} is not foldable: ${fileLabel(callee.file)}:${err.line}:${err.column} - ${reason}`,
      err.ruleId,
    );
  } finally {
    functionBodyDepth -= 1;
  }
}

function evaluateFunctionBody(
  callee: FoldableFunction,
  args: readonly FoldedValue[],
  bodyConsts: Map<string, ts.Expression>,
  bodyExternals: Map<string, unknown>,
  intrinsics: readonly IntrinsicDef[],
  bind: (name: string, value: unknown) => void,
  destructure: (pattern: ts.ObjectBindingPattern, value: unknown) => void,
): FoldedValue {
  callee.fn.parameters.forEach((param, i) => {
    let value: unknown = args[i];
    if (value === undefined && param.initializer) {
      value = fold(param.initializer, bodyConsts, intrinsics, bodyExternals);
    }
    if (ts.isIdentifier(param.name)) bind(param.name.text, value);
    else destructure(param.name as ts.ObjectBindingPattern, value);
  });

  const body = callee.fn.body as ts.ConciseBody;
  if (!ts.isBlock(body)) return fold(body, bodyConsts, intrinsics, bodyExternals);

  for (const statement of body.statements) {
    if (ts.isReturnStatement(statement)) {
      return statement.expression ? fold(statement.expression, bodyConsts, intrinsics, bodyExternals) : undefined;
    }
    for (const decl of (statement as ts.VariableStatement).declarationList.declarations) {
      const value = fold(decl.initializer as ts.Expression, bodyConsts, intrinsics, bodyExternals);
      if (ts.isIdentifier(decl.name)) bind(decl.name.text, value);
      else destructure(decl.name as ts.ObjectBindingPattern, value);
    }
  }
  // A block body with no `return` evaluates to `undefined`, as it would run.
  return undefined;
}

/**
 * Resolve a node's 1-based line/column via its owning `SourceFile`. Exported
 * (chant #1020) so fold-import.ts can build its own located `FoldError`s
 * (e.g. an import-cycle diagnostic pointing at the specific `import`
 * statement that closes the cycle) using the exact same position math
 * `foldError` uses here, rather than a second hand-rolled implementation.
 */
export function locate(node: ts.Node): { line: number; column: number } {
  const sourceFile = node.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return { line: line + 1, column: character + 1 };
}

function foldError(node: ts.Node, message: string, ruleId: SubsetRuleId = "EVL001"): FoldError {
  const { line, column } = locate(node);
  return new FoldError(message, line, column, ruleId);
}

/**
 * Collect every top-level `const x = <initializer>` in a source file into a
 * name -> initializer map. Single-file only (cross-file is #1020).
 */
export function collectConsts(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const consts = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) {
        consts.set(decl.name.text, decl.initializer);
      }
    }
  }
  return consts;
}

/**
 * A property/element key foldable without execution: identifier, string, or
 * numeric literal.
 *
 * Exported for chant #1023's composite-factory interpreter
 * (../discovery/fold-import.ts), which walks object literals itself — a
 * factory body may construct a resource inside one, which {@link fold} has no
 * case for — and must reject a computed key with the identical message
 * {@link fold} would, rather than growing a second, silently divergent copy of
 * this rule.
 */
export function propName(node: ts.PropertyName): string {
  if (isLiteralPropertyName(node)) return node.text;
  throw foldError(node, computedPropertyNameMessage(node));
}

/**
 * An element-access key foldable without execution: a string or numeric
 * LITERAL only (EVL003 semantics — a variable or expression key is a
 * dynamic key and is rejected).
 */
function elementKey(node: ts.Expression): string {
  if (isLiteralElementKey(node)) return node.text;
  throw foldError(node, dynamicElementAccessMessage(node), "EVL003");
}

/** True when `ident` is a `const` bound to a `new Type(...)` resource constructor. */
function resolvesToResource(consts: Map<string, ts.Expression>, ident: ts.Identifier): boolean {
  const init = consts.get(ident.text);
  return init !== undefined && ts.isNewExpression(init);
}

/**
 * True when `node` is a call through a bare identifier that isn't ALREADY
 * one of `fold()`'s other three call shapes — a registered authoring helper,
 * a registered call-form intrinsic, or a project-local {@link FoldableFunction}
 * — i.e. exactly the callee the `CallExpression` branch below would
 * otherwise throw {@link callExpressionMessage} for. Used only by the
 * `.step` narrowing in the property-access branch (chant #1174,
 * {@link FoldedCompositeStepCall}): checked from the OUTSIDE, at the
 * property-access node, so `Checkout({...})` alone (no `.step`) still falls
 * through to the ordinary `CallExpression` throw, unchanged.
 */
function isUnclaimedBareCall(
  node: ts.Expression,
  consts: Map<string, ts.Expression>,
  intrinsics: readonly IntrinsicDef[],
  externals?: ReadonlyMap<string, unknown>,
): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return false;
  const name = node.expression.text;
  if (consts.has(name)) return false;
  if (isFoldableHelperName(name)) return false;
  if (intrinsics.some((i) => i.name === name && intrinsicCallFolds(i))) return false;
  if (isFoldableFunction(externals?.get(name))) return false;
  return true;
}

/** True when a folded value is a {@link FoldedResource} envelope (a `new Type(...)` that nothing constructed yet). */
function isFoldedResource(value: FoldedValue): value is FoldedResource {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "__resource" in value;
}

/**
 * True when `value` is one of `fold()`'s own symbolic envelope shapes — a
 * stand-in for a value nothing has constructed or revived yet, not the value
 * itself. A method call (see the `CallExpression` branch's property-access
 * case below) must refuse one rather than silently falling through to
 * `Object.prototype`'s own inherited methods — `toString` chief among them —
 * which would answer with the placeholder's shape instead of what the real,
 * eventually-revived value would produce.
 */
function isFoldSymbolicEnvelope(value: FoldedValue): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    "__attrRef" in value ||
    "__intrinsic" in value ||
    "__helper" in value ||
    "__resource" in value ||
    "__compositeStep" in value
  );
}

/**
 * chant #1535 — an attribute read whose object folded to a resource ENVELOPE
 * rather than resolving through {@link resolvesToResource}. That happens when
 * the const's initializer is not a bare `new` but an expression that yields
 * one: `const provider = flag ? new OIDCProvider({...}) : undefined;` then
 * `provider.Arn`. Indexing the envelope (`{__resource, props}`) by the
 * attribute name returns `undefined`, and the property vanished from the
 * output without a word — a trust policy built with `Principal: { Federated:
 * provider.Arn }` landed in CloudFormation as `Principal: {}`.
 *
 * When the object is a plain identifier, the answer is the same symbolic
 * `{__attrRef}` the bare-`new` case produces — the serializer resolves it by
 * the const's name, exactly as it would have for `const provider = new
 * OIDCProvider({...})`. Any other expression shape has no name to key the
 * ref on, so it refuses and the file falls back to run rather than emitting
 * something wrong.
 */
function attrRefOnFoldedResource(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  attribute: string,
): AttrRefValue {
  if (ts.isIdentifier(node.expression)) {
    return { __attrRef: { entity: node.expression.text, attribute } };
  }
  throw foldError(
    node,
    `attribute "${attribute}" read on an inline resource expression is not foldable — bind the resource to a const first (falls back to run)`,
  );
}

/**
 * True when `node` is an identifier, or a dotted/bracketed access chain
 * rooted at an identifier, that neither `consts` nor `externals` can resolve
 * — e.g. `AWS.StackName` from an imported pseudo-parameter namespace inside
 * a lexicon package (still #1063). Nothing here can say what it refers to,
 * so an intrinsic's interior keeps it symbolically rather than rejecting it.
 *
 * `externals` (chant #1020) is consulted so a root that fold CAN resolve is
 * not treated as unresolved: `Ref(environment)`, where `environment` is a
 * `Parameter` imported from a sibling project file, must fold to the REAL,
 * already-constructed Declarable the fold session made for that file, not to
 * a `{__symbol}` the bridge later re-imports — re-importing the defining
 * module builds a second, differently-identified instance of the same
 * resource, which is exactly the shared-identity property #1020 exists to
 * preserve (see fold-import.ts's module doc).
 */
function isUnresolvedSymbolChain(
  node: ts.Expression,
  consts: Map<string, ts.Expression>,
  externals?: ReadonlyMap<string, unknown>,
): boolean {
  if (ts.isIdentifier(node)) {
    return node.text !== "undefined" && !consts.has(node.text) && !externals?.has(node.text);
  }
  if (ts.isPropertyAccessExpression(node)) return isUnresolvedSymbolChain(node.expression, consts, externals);
  if (ts.isElementAccessExpression(node)) return isUnresolvedSymbolChain(node.expression, consts, externals);
  if (ts.isNonNullExpression(node)) return isUnresolvedSymbolChain(node.expression, consts, externals);
  return false;
}

/**
 * Fold one sub-expression of a registered intrinsic's interior — an
 * interpolation of its tagged-template form, or (chant #1044) an argument of
 * its plain-call form. Identical to {@link fold}, except a symbol chain
 * nothing can resolve (a pseudo-parameter-style access into a lexicon
 * package, `AWS.StackName`) folds to a {@link SymbolicValue} instead of
 * throwing — the run path resolves it once the module actually imports and
 * runs; fold preserves it symbolically rather than stringifying or rejecting
 * it, and fold-import.ts's `resolveSymbolicValue` resolves it for real
 * before the intrinsic is constructed.
 *
 * `externals` (chant #1020) takes precedence over the symbolic path: see
 * {@link isUnresolvedSymbolChain} for why an already-resolved cross-file
 * binding must reach the intrinsic as the real, shared object rather than as
 * a symbol the bridge re-imports.
 */
function foldIntrinsicValue(
  node: ts.Expression,
  consts: Map<string, ts.Expression>,
  intrinsics: readonly IntrinsicDef[],
  externals?: ReadonlyMap<string, unknown>,
): FoldedValue {
  if (isUnresolvedSymbolChain(node, consts, externals)) {
    return { __symbol: node.getText() };
  }
  return fold(node, consts, intrinsics, externals);
}

/**
 * Fold a `TaggedTemplateExpression` whose tag is a registered, foldable
 * lexicon intrinsic ({@link intrinsicTagFolds}, `../lexicon.ts`) to its node
 * form. An unregistered — or registered-but-not-foldable — tag throws a
 * located {@link FoldError}.
 *
 * Checks the TAG-form predicate specifically (chant #1044): an intrinsic
 * whose lexicon opted its plain-call form in is not thereby usable as a
 * tagged template, and `` Ref`...` `` stays a rejection.
 */
function foldTaggedTemplate(
  node: ts.TaggedTemplateExpression,
  consts: Map<string, ts.Expression>,
  intrinsics: readonly IntrinsicDef[],
  externals?: ReadonlyMap<string, unknown>,
): FoldedIntrinsic {
  const tagName = node.tag.getText();
  const isRegistered = intrinsics.some((i) => i.name === tagName && intrinsicTagFolds(i));
  if (!isRegistered) {
    throw foldError(node, `unregistered tagged template intrinsic: ${briefNodeText(node.tag)}\`...\``);
  }

  const template = node.template;
  if (ts.isNoSubstitutionTemplateLiteral(template)) {
    return { __intrinsic: tagName, strings: [template.text], values: [] };
  }

  const strings = [template.head.text, ...template.templateSpans.map((span) => span.literal.text)];
  const values = template.templateSpans.map((span) =>
    foldIntrinsicValue(span.expression, consts, intrinsics, externals),
  );
  return { __intrinsic: tagName, strings, values };
}

/**
 * Fold a single expression node to a value. Throws {@link FoldError} for
 * anything outside the supported subset — including any `CallExpression`
 * that is neither a registered chant authoring helper nor a registered,
 * call-form-opted-in lexicon intrinsic (see the module doc).
 *
 * @param intrinsics - The active lexicons' registered intrinsics. A tagged
 *   template whose tag isn't in this list, or is in it without
 *   {@link intrinsicTagFolds}, is rejected; a plain call is rejected unless
 *   its callee is in this list with {@link intrinsicCallFolds} (chant
 *   #1044). Defaults to none — pass the target lexicon's manifest
 *   `intrinsics` to recognize either form.
 * @param externals - chant #1020: pre-resolved imported bindings, consulted
 *   only when an identifier isn't in `consts`. See the module doc above.
 *   `undefined` (the default) preserves the exact pre-#1020 single-file
 *   behavior — every identifier not in `consts` is unresolved.
 */
export function fold(
  node: ts.Expression,
  consts: Map<string, ts.Expression>,
  intrinsics: readonly IntrinsicDef[] = [],
  externals?: ReadonlyMap<string, unknown>,
): FoldedValue {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return fold(node.expression, consts, intrinsics, externals);
  }

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    // chant #1373 — a function is callable here (see {@link FoldableFunction})
    // but never a VALUE: nothing downstream can serialize one.
    throw foldError(node, "a function used as a value is not foldable");
  }

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }

  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;

  if (ts.isIdentifier(node) && node.text === "undefined") return undefined;

  if (ts.isTaggedTemplateExpression(node)) {
    const inside = insideFunctionBody(node, "a tagged template intrinsic");
    if (inside) throw inside;
    return foldTaggedTemplate(node, consts, intrinsics, externals);
  }

  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      out += String(fold(span.expression, consts, intrinsics, externals)) + span.literal.text;
    }
    return out;
  }

  if (ts.isObjectLiteralExpression(node)) {
    const obj: { [key: string]: FoldedValue } = {};
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        obj[propName(prop.name)] = fold(prop.initializer, consts, intrinsics, externals);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        obj[prop.name.text] = fold(prop.name, consts, intrinsics, externals);
      } else if (ts.isSpreadAssignment(prop)) {
        const src = fold(prop.expression, consts, intrinsics, externals);
        if (src === null || typeof src !== "object") {
          throw foldError(prop, "spread source not an object");
        }
        Object.assign(obj, src);
      } else {
        throw foldError(prop, UNSUPPORTED_OBJECT_MEMBER_MESSAGE);
      }
    }
    return obj;
  }

  if (ts.isArrayLiteralExpression(node)) {
    const arr: FoldedValue[] = [];
    for (const el of node.elements) {
      if (ts.isSpreadElement(el)) {
        const src = fold(el.expression, consts, intrinsics, externals);
        if (!Array.isArray(src)) {
          throw foldError(el, "spread source not an array");
        }
        arr.push(...src);
      } else {
        arr.push(fold(el, consts, intrinsics, externals));
      }
    }
    return arr;
  }

  if (ts.isIdentifier(node)) {
    if (!consts.has(node.text)) {
      // chant #1020 — an imported binding fold-import.ts already resolved
      // (to a plain value, or the real live Declarable/CompositeInstance a
      // sibling file's own fold produced) is returned as-is: for a plain
      // value this is exactly like resolving a local const; for a real live
      // object, the property-access branches below just index it like any
      // other object, which is what makes a real, correctly-identified
      // `AttrRef` fall out of `network.vpc.VpcId` with zero special-casing
      // here (see fold-import.ts's module doc).
      if (externals?.has(node.text)) {
        const external = externals.get(node.text);
        if (isFoldableFunction(external)) {
          throw foldError(node, `function "${node.text}" used as a value is not foldable`);
        }
        // chant #1966 — a registered eager-fold lexicon helper (see the
        // CallExpression branch below) is callable, never a bare value:
        // nothing downstream can serialize a function.
        if (
          typeof external === "function" &&
          intrinsics.some((i) => i.name === node.text && intrinsicCallFoldsEagerly(i))
        ) {
          throw foldError(node, `function "${node.text}" used as a value is not foldable — call it instead`);
        }
        return external as FoldedValue;
      }
      // chant #1064 — a bare `process` reference is ALWAYS an ambient
      // environment read (`process.env.X`, `process.argv`, …), never
      // something a future resolution pass could fold: it's Node's global,
      // not a local const or an importable module export. Point at the
      // supported alternative instead of leaving the author to infer the fix
      // from the generic "unresolved identifier" message — see
      // ../build-params.ts/../params.ts.
      if (node.text === "process") {
        throw foldError(
          node,
          `ambient "process" read is not foldable — declare a build-time parameter instead ` +
            `(chant.config.ts's buildParams + \`chant build --param name=value\`/\`--params-file\`) and reference ` +
            `it via \`import { params } from "@intentius/chant/params"\`, rather than reading process.env directly`,
        );
      }
      throw foldError(node, `unresolved identifier: ${node.text}`);
    }
    const initializer = consts.get(node.text) as ts.Expression;
    // chant #1169 — a BARE reference to a same-file `const x = new T(...)` is a
    // reference to THAT resource instance, and the ONE thing it must never
    // become is a second one. Re-folding the initializer here would do exactly
    // that now that the `new` branch below constructs: the consumer would get a
    // duplicate object discovery never registered, whose `AttrRef`s could never
    // be assigned a logical name ("Cannot serialize AttrRef …: logical name not
    // set") and whose `Ref` would silently inline instead of referencing. A
    // crash or wrong output, not drift.
    //
    // So `externals` — and ONLY `externals` — answers this one. A caller with a
    // module graph (../discovery/fold-import.ts) pre-resolves each of this
    // file's `new`-valued consts to ONE instance, in source order, before any
    // declarator is folded, and puts it here; every reference in the file then
    // reads that same object, exactly as running the module top-to-bottom
    // would. A caller without one (`foldModule`, a unit test) has no way to
    // construct anything, so the reference stays a rejection and the file falls
    // back to run.
    //
    // `bucket.name` is a different question and keeps its answer regardless: the
    // property-access branch below consults `consts` first, so a sibling
    // attribute reference is still the symbolic `{__attrRef}` the serializer
    // resolves by NAME. Nothing about the existing envelope changes.
    if (ts.isNewExpression(initializer)) {
      if (externals?.has(node.text)) return externals.get(node.text) as FoldedValue;
      throw foldError(
        node,
        `same-file resource \`${node.text}\` used as a value is not foldable — falls back to run`,
      );
    }
    return fold(initializer, consts, intrinsics, externals);
  }

  if (ts.isPropertyAccessExpression(node)) {
    if (ts.isIdentifier(node.expression) && resolvesToResource(consts, node.expression)) {
      return { __attrRef: { entity: node.expression.text, attribute: node.name.text } };
    }
    // chant #1174 — `<Identifier>(...).step`, the composite-consumer idiom
    // (`Checkout({...}).step`) — see FoldedCompositeStepCall's doc. Checked
    // here, at the property-access node, rather than inside the
    // CallExpression branch: a bare `Checkout({...})` with no `.step` still
    // has no case there and throws exactly as before.
    if (node.name.text === "step" && isUnclaimedBareCall(node.expression, consts, intrinsics, externals)) {
      const call = node.expression;
      const calleeName = (call.expression as ts.Identifier).text;
      const inside = insideFunctionBody(node, `composite call \`${calleeName}(...).step\``);
      if (inside) throw inside;
      return {
        __compositeStep: calleeName,
        args: call.arguments.map((arg) => fold(arg, consts, intrinsics, externals)),
      };
    }
    const obj = fold(node.expression, consts, intrinsics, externals);
    if (obj === null || obj === undefined) return undefined;
    if (isFoldedResource(obj)) return attrRefOnFoldedResource(node, node.name.text);
    return (obj as { [key: string]: FoldedValue })[node.name.text];
  }

  if (ts.isElementAccessExpression(node)) {
    const key = elementKey(node.argumentExpression);
    if (ts.isIdentifier(node.expression) && resolvesToResource(consts, node.expression)) {
      return { __attrRef: { entity: node.expression.text, attribute: key } };
    }
    const obj = fold(node.expression, consts, intrinsics, externals);
    if (obj === null || obj === undefined) return undefined;
    if (isFoldedResource(obj)) return attrRefOnFoldedResource(node, key);
    return (obj as { [key: string]: FoldedValue })[key];
  }

  if (ts.isPrefixUnaryExpression(node)) {
    if (!SUPPORTED_UNARY_OPERATORS.has(node.operator)) {
      throw foldError(node, UNSUPPORTED_UNARY_MESSAGE);
    }
    const value = fold(node.operand, consts, intrinsics, externals);
    if (node.operator === ts.SyntaxKind.ExclamationToken) return !value;
    return -(value as unknown as number); // ts.SyntaxKind.MinusToken — the only other supported operator
  }

  if (ts.isBinaryExpression(node)) {
    const opKind = node.operatorToken.kind;
    const S = ts.SyntaxKind;

    if (opKind === S.AmpersandAmpersandToken) {
      const left = fold(node.left, consts, intrinsics, externals);
      return left ? fold(node.right, consts, intrinsics, externals) : left;
    }
    if (opKind === S.BarBarToken) {
      const left = fold(node.left, consts, intrinsics, externals);
      return left ? left : fold(node.right, consts, intrinsics, externals);
    }
    if (opKind === S.QuestionQuestionToken) {
      const left = fold(node.left, consts, intrinsics, externals);
      return left === null || left === undefined ? fold(node.right, consts, intrinsics, externals) : left;
    }

    if (!SUPPORTED_BINARY_OPERATORS.has(opKind)) {
      throw foldError(node, unsupportedBinaryMessage(opKind));
    }

    const left = fold(node.left, consts, intrinsics, externals);
    const right = fold(node.right, consts, intrinsics, externals);
    switch (opKind) {
      case S.PlusToken:
        return (left as unknown as string) + (right as unknown as string);
      case S.MinusToken:
        return (left as unknown as number) - (right as unknown as number);
      case S.AsteriskToken:
        return (left as unknown as number) * (right as unknown as number);
      case S.SlashToken:
        return (left as unknown as number) / (right as unknown as number);
      case S.EqualsEqualsEqualsToken:
        return left === right;
      case S.ExclamationEqualsEqualsToken:
        return left !== right;
      case S.GreaterThanToken:
        return (left as unknown as string) > (right as unknown as string);
      case S.LessThanToken:
        return (left as unknown as string) < (right as unknown as string);
      case S.GreaterThanEqualsToken:
        return (left as unknown as string) >= (right as unknown as string);
      case S.LessThanEqualsToken:
        return (left as unknown as string) <= (right as unknown as string);
      default:
        // Unreachable given the SUPPORTED_BINARY_OPERATORS guard above —
        // kept as a defensive fallback in case that set and this switch
        // ever fall out of sync.
        throw foldError(node, unsupportedBinaryMessage(opKind));
    }
  }

  if (ts.isConditionalExpression(node)) {
    return fold(node.condition, consts, intrinsics, externals)
      ? fold(node.whenTrue, consts, intrinsics, externals)
      : fold(node.whenFalse, consts, intrinsics, externals);
  }

  if (ts.isNewExpression(node)) {
    // chant #1169 — a nested `new Type({...})` used as a property VALUE folds
    // to the SAME {@link FoldedResource} envelope a top-level resource
    // declaration does, and is constructed for real by the same bridge.
    //
    // This used to be an unconditional rejection, and the reason it was is
    // worth keeping in view: `fold()` alone can only produce the envelope, and
    // an envelope that reaches serialization is the wrong value — the #1025
    // differential caught exactly that on gitlab/multi-stage-deploy, where
    // `new Image({...})` as a job's `image:` must serialize as the constructed
    // Image's own shape, not as `{__resource, props}`. What changed is not the
    // envelope's safety but who consumes it: ../discovery/fold-import.ts's
    // `reviveFoldedValue` now REVIVES a `{__resource}` node into a real
    // instance, built by the class the file's own `import` names, resolved
    // through the same provenance-checked machinery that already constructs a
    // top-level resource (and that #1023's factory interpreter already uses to
    // construct a nested `new` inside a factory body — the asymmetry that
    // motivated this change). Nothing symbolic survives into the serializer:
    // the value the outer constructor receives is the same object the run path
    // would have handed it, with the same prototype, the same `props`, and the
    // same `toJSON`/`kind` the serializer's walker dispatches on.
    //
    // Only a PLAIN IDENTIFIER constructor is admissible. `new ns.Type(...)`
    // cannot be resolved to a live class through the file's named imports, so
    // it stays a rejection rather than folding to an envelope nothing can
    // revive — the same bare-identifier rule #1023's `checkFactoryExpression`
    // applies to a body-level construction, and the same one `fold()` applies
    // to an intrinsic call and an authoring helper.
    if (!ts.isIdentifier(node.expression)) {
      throw foldError(
        node,
        `nested \`new ${briefNodeText(node.expression)}(...)\` as a value needs a plain imported constructor — falls back to run`,
      );
    }
    const inside = insideFunctionBody(node, `\`new ${node.expression.text}(...)\``);
    if (inside) throw inside;
    return foldResource(node, consts, intrinsics, externals);
  }

  if (ts.isCallExpression(node)) {
    // chant #1082 — the ONE call shape that folds: a registered chant
    // authoring helper ({@link FOLDABLE_AUTHORING_HELPERS}), called through a
    // bare identifier that this file hasn't shadowed with its own `const`.
    // Nothing is executed here — the call reduces to a symbolic
    // {@link FoldedHelperCall} envelope, exactly as a registered intrinsic
    // tagged template reduces to a {@link FoldedIntrinsic} one, and for the
    // same reason: the real function lives in another module, and resolving
    // + invoking it is the async bridge's job (../discovery/fold-import.ts's
    // `reviveFoldedValue`), which also verifies the name is actually bound to
    // an import of chant's own before invoking anything. Every other call —
    // a user's function, a method call, a call to something declared in this
    // file — still has no case and throws, unchanged.
    if (
      ts.isIdentifier(node.expression) &&
      isFoldableHelperName(node.expression.text) &&
      !consts.has(node.expression.text)
    ) {
      const inside = insideFunctionBody(node, `authoring helper call \`${node.expression.text}(...)\``);
      if (inside) throw inside;
      return {
        __helper: node.expression.text,
        args: node.arguments.map((arg) => fold(arg, consts, intrinsics, externals)),
      };
    }

    // chant #1044 — the other call shape that folds: a lexicon intrinsic in
    // PLAIN-CALL form (`Ref(bucket)`, `Concat("a", b)`), where that lexicon
    // registered it AND opted its call form in ({@link intrinsicCallFolds},
    // ../lexicon.ts — default off, never inferred). Reduces to the same
    // `{__intrinsic}` envelope family the tagged-template form produces, with
    // positional `args`; nothing is executed here, for the same reason as the
    // tag form — the real function lives in the lexicon module, and resolving
    // it through this file's own imports and invoking it is the async
    // bridge's job (../discovery/fold-import.ts's `reviveFoldedValue`).
    //
    // Arguments fold through {@link foldIntrinsicValue}, exactly like a tag's
    // interpolations: an intrinsic's interior is where a pseudo-parameter
    // chain (`GetAZs(AWS.Region)`) legitimately appears, and it stays
    // symbolic rather than rejecting.
    //
    // The door does not open any wider than this. A bare-identifier callee
    // only, so `ns.Ref(...)` and `arr.map(...)` are untouched; the file's own
    // `const` shadowing wins, so a local `Ref` is not the lexicon's; and a
    // name absent from the active lexicons' registered set — or registered
    // without the opt-in — falls straight through to the throw below.
    if (ts.isIdentifier(node.expression) && !consts.has(node.expression.text)) {
      const calleeName = node.expression.text;
      if (intrinsics.some((i) => i.name === calleeName && intrinsicCallFolds(i))) {
        const inside = insideFunctionBody(node, `intrinsic call \`${calleeName}(...)\``);
        if (inside) throw inside;
        return {
          __intrinsic: calleeName,
          args: node.arguments.map((arg) => foldIntrinsicValue(arg, consts, intrinsics, externals)),
        };
      }
    }

    // chant #1373 — the third call shape, and the only open-ended one: a
    // PROJECT-LOCAL function (declared in this file or imported from a
    // sibling project file) whose body is itself foldable. fold-import.ts
    // places a {@link FoldableFunction} marker in `externals` for each such
    // declaration (a same-file `const f = () => …` is in `consts` too, which
    // is why this is not gated on `consts` like the two above); the call is
    // evaluated right here, statically, against the defining module's scope
    // — see {@link callFoldableFunction}. Checked AFTER the two registered
    // shapes so a registered name keeps its registered meaning; a package
    // export never produces a marker, so `node_modules` stays out.
    if (ts.isIdentifier(node.expression)) {
      const callee = externals?.get(node.expression.text);
      if (isFoldableFunction(callee)) {
        return callFoldableFunction(callee, node, consts, intrinsics, externals);
      }
    }

    // chant #1966 — the fourth call shape: a lexicon-package function its
    // lexicon registered with {@link intrinsicCallFoldsEagerly} (../lexicon.ts),
    // resolved into `externals` by ../discovery/fold-import.ts's
    // `resolveActiveLexiconExport` exactly like a plain data export
    // (`Azure.ResourceGroupLocation`, chant #1063), except callable. Unlike
    // the intrinsic-call shape above, this one is EVALUATED right here rather
    // than enveloped: a lexicon's own string-building helper (`matrix("os")`,
    // github lexicon) is typically embedded directly in a template literal
    // (`` `${matrix("os")}` ``), which coerces its result via native
    // `String()` at fold time — an envelope deferred to later revival would
    // stringify as "[object Object]" there. Evaluating eagerly, with the
    // folded arguments, produces the real, already-live return value instead
    // — the same guarantee a live external's own getter execution already
    // gives {@link fold}'s property-access branch.
    if (
      ts.isIdentifier(node.expression) &&
      !consts.has(node.expression.text) &&
      intrinsics.some((i) => i.name === (node.expression as ts.Identifier).text && intrinsicCallFoldsEagerly(i))
    ) {
      const callee = externals?.get(node.expression.text);
      if (typeof callee !== "function") {
        throw foldError(node, `"${node.expression.text}" did not resolve to a function — falls back to run`);
      }
      const args = node.arguments.map((arg) => fold(arg, consts, intrinsics, externals));
      return (callee as (...callArgs: unknown[]) => unknown)(...args) as FoldedValue;
    }

    // chant #1966 — a method call whose RECEIVER is itself foldable: property
    // access on a live external (`github.actor.toString()`), a call folded by
    // one of the shapes above (`matrix("os").toString()`), or fold's own
    // array/object literal (`[...].join(",")`). The method is never checked
    // by name — only that the receiver is a REAL value (not one of fold's own
    // symbolic envelopes, see {@link isFoldSymbolicEnvelope}) and that the
    // named property on it is actually a function. Calling it with the folded
    // arguments is then no different from what running the file would do:
    // the receiver is the same real object either way.
    if (ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      const receiver = fold(node.expression.expression, consts, intrinsics, externals);
      if (receiver === null || receiver === undefined) {
        throw foldError(node, `cannot call ".${methodName}(...)" on ${String(receiver)}`);
      }
      if (isFoldSymbolicEnvelope(receiver)) {
        throw foldError(
          node,
          `method call \`.${methodName}(...)\` on an unresolved value is not foldable — falls back to run`,
        );
      }
      const method = (receiver as Record<string, unknown>)[methodName];
      if (typeof method !== "function") {
        throw foldError(node, `"${methodName}" is not a callable method on the folded value — falls back to run`);
      }
      const args = node.arguments.map((arg) => fold(arg, consts, intrinsics, externals));
      return (method as (...methodArgs: unknown[]) => unknown).apply(receiver, args) as FoldedValue;
    }

    throw foldError(node, callExpressionMessage(node));
  }

  throw foldError(node, unsupportedExpressionMessage(node));
}

/**
 * Fold a resource constructor call to its spec.
 *
 * The common `createResource` shape (../runtime.ts) is `new Type({ ...props
 * })` or `new Type({ ...props }, { ...attributes })` — CFN-style resource
 * attributes (`DependsOn`, `Condition`, `DeletionPolicy`, …) second — and
 * that shape reduces to `props` (+ `attributes`) exactly as before.
 *
 * chant #1082 — but that is a convention, not a rule every lexicon class
 * follows. AWS's deploy-time `Parameter` is `(type, props)`
 * (lexicons/aws/src/parameter.ts): the props object is the SECOND argument
 * and the first is a plain string. `foldResource` used to require argument 0
 * to be an object literal, so no `new Parameter(...)` anywhere could ever
 * fold, whatever surrounded it. The general case now folds every argument in
 * source order into {@link FoldedResource.args}, which the caller constructs
 * the entity from verbatim — no positional assumption at all. `props` is
 * still reported (the first object-literal argument, for callers that read
 * it) but is a VIEW onto `args`, not the thing constructed from.
 */
export function foldResource(
  node: ts.NewExpression,
  consts: Map<string, ts.Expression>,
  intrinsics: readonly IntrinsicDef[] = [],
  externals?: ReadonlyMap<string, unknown>,
): FoldedResource {
  const typeName = node.expression.getText();
  const args = node.arguments ?? ([] as unknown as ts.NodeArray<ts.Expression>);
  const [firstArg, secondArg] = args;
  const foldArg = (arg: ts.Expression) => fold(arg, consts, intrinsics, externals);

  if (!firstArg) {
    return { __resource: typeName, props: {} };
  }

  // The classic (props) / (props, attributes) shape — reported without an
  // `args` list so the spec of an ordinary resource is unchanged.
  if (ts.isObjectLiteralExpression(firstArg)) {
    const props = foldArg(firstArg) as { [key: string]: FoldedValue };
    if (args.length === 1) {
      return { __resource: typeName, props };
    }
    if (args.length === 2 && ts.isObjectLiteralExpression(secondArg)) {
      return { __resource: typeName, props, attributes: foldArg(secondArg) as { [key: string]: FoldedValue } };
    }
  }

  // Anything else: fold every argument positionally. Each one still has to be
  // in the fold subset on its own terms — a non-foldable argument throws from
  // `fold()` exactly as a non-foldable prop value does.
  const folded = args.map(foldArg);
  const propsIndex = args.findIndex((arg) => ts.isObjectLiteralExpression(arg));
  const props = (propsIndex === -1 ? {} : folded[propsIndex]) as { [key: string]: FoldedValue };
  return { __resource: typeName, props, args: folded };
}

function hasExportModifier(statement: ts.VariableStatement): boolean {
  return statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * Fold every exported `const X = new Type({...})` resource declaration in a
 * source file to its spec, with no module execution.
 *
 * Non-resource `const` exports (anything whose initializer isn't a `new`
 * expression) are left out of the result rather than folded or errored —
 * `new`-less resource forms (composite factory calls) are epic Phase 5
 * (#1023) and are not attempted here.
 *
 * @param intrinsics - Lexicon-registered intrinsic tags, forwarded to
 *   {@link fold} for every resource. See {@link fold}'s `intrinsics` param.
 */
export function foldModule(
  source: string,
  fileName = "module.ts",
  intrinsics: readonly IntrinsicDef[] = [],
): Record<string, FoldModuleEntry> {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const consts = collectConsts(sourceFile);
  const result: Record<string, FoldModuleEntry> = {};

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!hasExportModifier(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;

    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      if (!ts.isNewExpression(decl.initializer)) continue;

      const name = decl.name.text;
      try {
        const spec = foldResource(decl.initializer, consts, intrinsics);
        result[name] = { ok: true, spec };
      } catch (err) {
        if (err instanceof FoldError) {
          result[name] = { ok: false, error: err.message, ruleId: err.ruleId, line: err.line, column: err.column };
        } else {
          throw err;
        }
      }
    }
  }

  return result;
}
