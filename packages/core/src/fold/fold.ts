import * as ts from "typescript";
import { intrinsicCallFolds, intrinsicTagFolds, type IntrinsicDef } from "../lexicon";
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
 * Everything else — a user's function, a method call, an array `.map`, a
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
  | FoldedResource;

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
        return externals.get(node.text) as FoldedValue;
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
    const obj = fold(node.expression, consts, intrinsics, externals);
    if (obj === null || obj === undefined) return undefined;
    return (obj as { [key: string]: FoldedValue })[node.name.text];
  }

  if (ts.isElementAccessExpression(node)) {
    const key = elementKey(node.argumentExpression);
    if (ts.isIdentifier(node.expression) && resolvesToResource(consts, node.expression)) {
      return { __attrRef: { entity: node.expression.text, attribute: key } };
    }
    const obj = fold(node.expression, consts, intrinsics, externals);
    if (obj === null || obj === undefined) return undefined;
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
        return {
          __intrinsic: calleeName,
          args: node.arguments.map((arg) => foldIntrinsicValue(arg, consts, intrinsics, externals)),
        };
      }
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
